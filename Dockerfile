# Night Bazaar runtime image — THIN, no build inside Docker.
#
# Why no in-image cargo build: pops-core-verify is a PRIVATE git dep
# (ssh://git@github.com/MakePrisms/pops.git). Building in Docker would have to
# bake an SSH key into a layer. Instead we build the release binary LOCALLY in
# the pops nix devshell (which already has repo access) and copy the prebuilt
# artifact in. (Contract §B, option 1.)
#
# Why we bundle glibc: the nix devshell links the binary against nix's glibc
# 2.42 with a /nix/store ELF interpreter path that no Debian image carries, and
# musl is not installed in the devshell (only wasm32). So `build-image.sh`
# patchelf's the binary onto a BUNDLED interpreter + rpath (/opt/nbz/lib) and
# stages the 4 runtime .so files (libc/libm/libgcc + the loader) alongside it.
# The binary is then self-contained on its own glibc, so the base image's glibc
# is irrelevant — we use distroless/static (no libc of its own) as the smallest
# correct base. TLS roots are compiled in (reqwest rustls-tls -> webpki-roots),
# so NO ca-certificates package is needed.
#
# Build context = the night-bazaar/ repo root. Run `server/build-image.sh`
# FIRST to produce server/target/docker-stage (the patched binary + libs) and
# client/dist (the built client), then:
#   docker build -t night-bazaar:latest .

# A scratch-like base with a nonroot user + tmp dir but no libc (we bundle ours).
FROM gcr.io/distroless/static-debian12:nonroot

# The self-contained binary + its bundled glibc closure.
COPY server/target/docker-stage/night-bazaar-server /opt/nbz/night-bazaar-server
COPY server/target/docker-stage/lib/ /opt/nbz/lib/

# The built client (served at /). Vault + revenue sink live on the Fly VOLUME,
# never in the image (see fly.toml [mounts] + docs/fly-deploy.md).
COPY client/dist/ /opt/nbz/client/dist/

# Internal listen address (Fly routes :443 -> this). 0.0.0.0 so the platform
# can reach it inside the machine.
ENV BAZAAR_BIND=0.0.0.0:8080 \
    BAZAAR_STATIC=/opt/nbz/client/dist \
    BAZAAR_VAULT=/data/tokens.json \
    BAZAAR_REVENUE_SINK=/data/revenue.jsonl

EXPOSE 8080

# distroless :nonroot already runs as uid 65532. Run the patched binary
# directly (it finds /opt/nbz/lib/ld-linux-x86-64.so.2 via its baked PT_INTERP).
USER nonroot:nonroot
ENTRYPOINT ["/opt/nbz/night-bazaar-server"]
