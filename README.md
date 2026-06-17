# Night Bazaar

> **Status & build note.** A working demo on the pops/cashu accept-layer stack:
> pay pops at a gate, win ecash. The server depends on
> [`MakePrisms/pops`](https://github.com/MakePrisms/pops) (the `pops-core-verify`
> middleware and charge-01 codec); clone it and point the build at it (see Run).

A pop-gated 3D browser world. Arrive as a ghost, pay a pops token to spawn a body, pay again to enter gated courts, win real ecash at the booths inside.

![Night Bazaar street overview](docs/phase1a-street-overview.png)

## How it works

**Core loop:** anyone connects as a ghost and roams free. A small pops payment spawns a body (chat, jump, interact). Deeper courts and booths require a second payment at the door. Winning plays pay out real ecash bearer tokens.

**Architecture:** one Rust axum binary serves the game websocket (server-authoritative positions, per-session entitlements, chat relay), the pops-gated HTTP 402 endpoints (`POST /spawn`, `POST /enter/:court`, `POST /play/gacha`, `POST /play/bell`), and the built Three.js client. Payments are verified by `pops-core-verify` (MakePrisms/pops). The server accepts the full set of currently-valid `pop_<ts>` units (multi-unit accept with auto-rotation); a durable revenue sink (`vault/revenue.jsonl`) is written and fsynced before every grant returns.

**Booths:**
- **Riddle lantern** (jade court, free): answer the riddle, win a prize, riddle rotates.
- **Gacha shrine** (crimson court, paid per pull): deterministic every-Nth-wins counter.
- **Timing bell** (street, paid per play): server-clock-judged pendulum, press `[E]` on cue.

## Controls

`WASD` move, `[B]` buy a body, `[E]` interact/pay/play, `[Space]` jump, `Enter`/`T` chat (bodies only), `[M]` mute.

At a booth: `[E]` reads the riddle / pulls the gacha / starts the bell; during a bell play `[E]` rings it; in the riddle modal type your answer and press Enter.

Dev query params: `?webgl=1` force WebGL2 (default tries WebGPU, auto-fallback), `?nobloom=1` skip the post chain, `?crowd=N` client-side fake wanderers for screenshots/FPS (never networked).

## Layout

- `server/` - Rust crate (`night-bazaar-server` binary + lib + `gen-vectors` helper)
- `client/` - bun + Three.js; charge-01 payer codec in `client/src/charge01.ts`
- `protocol/` - seam: `protocol.ts` (TS source of truth, mirrored by `server/src/protocol.rs`), shared fixtures, golden charge-01 vectors (both test suites consume them)
- `vault/tokens.json` - prize stock, keyed by chest/booth id (bearer cash, never commit)
- `vault/revenue.jsonl` - durable revenue sink (a WALLET, never commit): one line per redeemed gate/play, written and fsynced before the grant returns
- `.local/` - test funds and run artifacts (never commit)

## Run

**Server** (from `server/`; needs the pops devshell for rustc and the git dep):

```sh
git clone https://github.com/MakePrisms/pops   # the pops checkout, for rustc + the git dep
cd server
CARGO_NET_GIT_FETCH_WITH_CLI=true nix develop ../pops -c cargo run --bin night-bazaar-server
# two bins in this package; bare `cargo run` errors
# prebuilt: ./target/debug/night-bazaar-server
```

**Client** (from `client/`):

```sh
bun install
bun run build       # bundles src/main.ts + index.html into dist/
bun test            # codec vs golden vectors, wallet, protocol fixtures
```

**Server tests** (from `server/`):

```sh
CARGO_NET_GIT_FETCH_WITH_CLI=true nix develop <path-to-pops> -c cargo test
```

## Configuration

Key env vars (all optional; sensible defaults for local dev):

| Variable | Purpose |
|---|---|
| `BAZAAR_BIND` | Listen address (e.g. `0.0.0.0:8410`) |
| `BAZAAR_MINT_URL` | Cashu mint URL the server uses for probing and redeeming |
| `BAZAAR_MINT_PUBLIC_URLS` | Comma-separated mint URLs as clients see them (defaults to `BAZAAR_MINT_URL`) |
| `BAZAAR_MODE` | `live` (default, pops middleware enforced) or `mock` (free gates, dev only) |
| `BAZAAR_PRICE_SPAWN/_JADE/_CRIMSON` | Gate prices in pops |
| `BAZAAR_PRICE_GACHA/_BELL` | Per-play prices for the paid booths |
| `BAZAAR_BINDING_KEY` | Hex server secret; set as a persistent secret in production so deploys keep outstanding challenges valid |

See `server/src/config.rs` for the full list.

## Deploy

Build artifacts, then deploy to Fly.io: see [`docs/fly-deploy.md`](docs/fly-deploy.md).

```sh
bash server/build-image.sh          # release build + bun build + staged runtime tree
docker build -t night-bazaar:latest .
fly deploy
```
