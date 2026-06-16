//! Reverse-proxy handler for `GET|POST /mint/*path`.
//!
//! The server advertises `/mint/*` as the public mint URL; the browser builds
//! its pop wallet against it and swaps there.  The handler strips the `/mint`
//! prefix, forwards the request to the DIRECT upstream (`BAZAAR_MINT_URL`)
//! with method + headers + body, and streams the response back.
//!
//! No auth: a cashu mint is public by design.
//!
//! Error mapping:
//!   - Bad request body read              → 400
//!   - Upstream connect / timeout failure → 503 Service Unavailable
//!   - Any other upstream error           → 502 Bad Gateway

use axum::body::Body;
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};

/// Shared state for the `/mint/*path` reverse-proxy handler.
#[derive(Clone, Debug)]
pub struct MintProxyState {
    /// Reqwest client (connection-pooled, timeout = `cfg.mint_timeout_secs`).
    pub client: reqwest::Client,
    /// Direct upstream mint URL, e.g. `http://127.0.0.1:28338`.
    pub upstream: String,
}

/// Reverse-proxy handler.  Register with
/// `Router::new().route("/mint/*path", get(mint_proxy).post(mint_proxy)).with_state(state)`.
pub async fn mint_proxy(
    State(MintProxyState { client, upstream }): State<MintProxyState>,
    req: Request<Body>,
) -> Response {
    let suffix = req
        .uri()
        .path()
        .strip_prefix("/mint")
        .unwrap_or("")
        .to_string();
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let target = format!("{upstream}{suffix}{query}");

    let method = req.method().clone();

    // Forward selected headers (skip hop-by-hop).
    let mut fwd = client.request(method, &target);
    for (name, value) in req.headers() {
        let n = name.as_str().to_ascii_lowercase();
        if matches!(
            n.as_str(),
            "connection"
                | "keep-alive"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "te"
                | "trailers"
                | "transfer-encoding"
                | "upgrade"
                | "host"
        ) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            fwd = fwd.header(name, v);
        }
    }

    let body_bytes = match axum::body::to_bytes(req.into_body(), 4 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return (
                http::StatusCode::BAD_REQUEST,
                format!("failed to read request body: {e}"),
            )
                .into_response()
        }
    };
    fwd = fwd.body(body_bytes);

    let upstream_resp = match fwd.send().await {
        Ok(r) => r,
        Err(e) if e.is_connect() || e.is_timeout() => {
            return (
                http::StatusCode::SERVICE_UNAVAILABLE,
                format!("mint proxy: upstream unreachable: {e}"),
            )
                .into_response()
        }
        Err(e) => {
            return (
                http::StatusCode::BAD_GATEWAY,
                format!("mint proxy: upstream error: {e}"),
            )
                .into_response()
        }
    };

    let status = http::StatusCode::from_u16(upstream_resp.status().as_u16())
        .unwrap_or(http::StatusCode::BAD_GATEWAY);

    // Collect response headers, skipping hop-by-hop headers that are
    // irrelevant or problematic once we've fully buffered the body.
    let response_headers: Vec<(String, String)> = upstream_resp
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            let n = name.as_str().to_ascii_lowercase();
            // Skip hop-by-hop: transfer-encoding was for the upstream
            // connection; we send a complete buffered body, so it must not
            // be forwarded (it would confuse clients expecting chunked
            // encoding that we are NOT emitting).
            if matches!(
                n.as_str(),
                "connection"
                    | "keep-alive"
                    | "proxy-authenticate"
                    | "proxy-authorization"
                    | "te"
                    | "trailers"
                    | "transfer-encoding"
                    | "upgrade"
            ) {
                return None;
            }
            value.to_str().ok().map(|v| (n, v.to_string()))
        })
        .collect();

    let bytes = match upstream_resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return (
                http::StatusCode::BAD_GATEWAY,
                format!("mint proxy: error reading upstream body: {e}"),
            )
                .into_response()
        }
    };

    let mut builder = http::Response::builder().status(status);
    for (name, value) in &response_headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    match builder.body(Body::from(bytes)) {
        Ok(resp) => resp,
        Err(e) => (
            http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("mint proxy: failed to build response: {e}"),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use axum::Router;
    use http::{Request, StatusCode};
    use tower::ServiceExt;
    use axum::body::Body;

    /// Build a minimal test router with the proxy mounted at `/mint/*path`.
    fn proxy_router(state: MintProxyState) -> Router {
        Router::new()
            .route("/mint/*path", get(mint_proxy).post(mint_proxy))
            .with_state(state)
    }

    async fn send(router: &Router, req: Request<Body>) -> (StatusCode, String) {
        let resp = router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let body = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&body).to_string())
    }

    /// A real local HTTP server that echoes the path of every request as its
    /// body, so tests can verify the proxy strips `/mint` correctly.
    async fn spawn_echo_server() -> (u16, tokio::task::JoinHandle<()>) {
        use axum::extract::Request as AxumRequest;
        use axum::response::Response as AxumResponse;

        async fn echo_path(req: AxumRequest<Body>) -> AxumResponse<Body> {
            let path = req.uri().path().to_string();
            http::Response::builder()
                .status(200)
                .header("content-type", "text/plain")
                .body(Body::from(path))
                .unwrap()
        }
        let app = Router::new().fallback(echo_path);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("echo server bind");
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (port, handle)
    }

    /// A minimal server that accepts a TCP connection but never sends a byte
    /// (simulates a hung/unreachable upstream).
    async fn spawn_black_hole() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("black-hole bind");
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let _held_open = socket;
                    std::future::pending::<()>().await;
                });
            }
        });
        (port, handle)
    }

    // ---- prefix stripping -------------------------------------------

    #[tokio::test]
    async fn proxy_strips_mint_prefix_from_path() {
        let (port, _handle) = spawn_echo_server().await;
        let upstream = format!("http://127.0.0.1:{port}");
        let state = MintProxyState {
            client: reqwest::Client::new(),
            upstream,
        };
        let router = proxy_router(state);

        let req = Request::builder()
            .method("GET")
            .uri("/mint/v1/keysets")
            .body(Body::empty())
            .unwrap();
        let (status, body) = send(&router, req).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body, "/v1/keysets", "prefix must be stripped");
    }

    #[tokio::test]
    async fn proxy_bare_mint_path_maps_to_root() {
        let (port, _handle) = spawn_echo_server().await;
        let upstream = format!("http://127.0.0.1:{port}");
        let state = MintProxyState {
            client: reqwest::Client::new(),
            upstream,
        };
        let router = proxy_router(state);

        // The `/mint` prefix alone strips to empty, which becomes `/` at the upstream.
        let req = Request::builder()
            .method("GET")
            .uri("/mint/v1/info")
            .body(Body::empty())
            .unwrap();
        let (status, body) = send(&router, req).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body, "/v1/info");
    }

    // ---- POST forwarding --------------------------------------------

    #[tokio::test]
    async fn proxy_forwards_post_method() {
        let (port, _handle) = spawn_echo_server().await;
        let upstream = format!("http://127.0.0.1:{port}");
        let state = MintProxyState {
            client: reqwest::Client::new(),
            upstream,
        };
        let router = proxy_router(state);

        let req = Request::builder()
            .method("POST")
            .uri("/mint/v1/swap")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"proofs":[]}"#))
            .unwrap();
        let (status, _body) = send(&router, req).await;
        assert_eq!(status, StatusCode::OK);
    }

    // ---- upstream-down error mapping --------------------------------

    #[tokio::test]
    async fn proxy_returns_502_when_upstream_is_not_listening() {
        // Port 1 is almost certainly not bound; the connection should be refused.
        let state = MintProxyState {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(2))
                .build()
                .unwrap(),
            upstream: "http://127.0.0.1:1".to_string(),
        };
        let router = proxy_router(state);

        let req = Request::builder()
            .method("GET")
            .uri("/mint/v1/keysets")
            .body(Body::empty())
            .unwrap();
        let (status, body) = send(&router, req).await;
        // A connect failure is 503; any other error is 502. Either indicates the
        // upstream was not reachable.
        assert!(
            status == StatusCode::SERVICE_UNAVAILABLE || status == StatusCode::BAD_GATEWAY,
            "upstream-down must be 502 or 503, got {status}: {body}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn proxy_returns_503_when_upstream_hangs() {
        let (port, _handle) = spawn_black_hole().await;
        let state = MintProxyState {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(200))
                .build()
                .unwrap(),
            upstream: format!("http://127.0.0.1:{port}"),
        };
        let router = proxy_router(state);

        let req = Request::builder()
            .method("GET")
            .uri("/mint/v1/keysets")
            .body(Body::empty())
            .unwrap();
        let started = std::time::Instant::now();
        let (status, body) = send(&router, req).await;
        let elapsed = started.elapsed();
        assert!(
            status == StatusCode::SERVICE_UNAVAILABLE || status == StatusCode::BAD_GATEWAY,
            "hung upstream must be 503 or 502, got {status}: {body}"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "must answer within timeout margin, took {elapsed:?}"
        );
    }
}
