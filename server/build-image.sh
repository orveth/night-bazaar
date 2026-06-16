#!/usr/bin/env bash
# Build the Night Bazaar release binary + stage a self-contained runtime tree
# for the thin Docker image (Dockerfile at the repo root).
#
# Steps:
#   1. cargo build --release in the pops nix devshell (private-dep access).
#   2. Build the client (bun run build) -> client/dist.
#   3. Stage the binary + its nix glibc closure into server/target/docker-stage,
#      patchelf'd onto a bundled interpreter (/opt/nbz/lib) so it runs on ANY
#      base image (the nix-store interpreter path is replaced).
#
# Run from anywhere; paths are absolute-relative to this script.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
POPS=/srv/forge/projects/pops
STAGE="$HERE/target/docker-stage"

echo "==> [1/3] release build (pops devshell)"
cd "$HERE"
CARGO_NET_GIT_FETCH_WITH_CLI=true nix develop "$POPS" -c \
  cargo build --release --bin night-bazaar-server

echo "==> [2/3] client build (bun run build)"
cd "$ROOT/client"
nix develop "$POPS" -c bun install
nix develop "$POPS" -c bun run build

echo "==> [3/3] stage runtime tree + patchelf"
cd "$HERE"
nix develop "$POPS" -c bash -euo pipefail -c '
  BIN=target/release/night-bazaar-server
  STAGE=target/docker-stage
  rm -rf "$STAGE"; mkdir -p "$STAGE/lib"
  cp "$BIN" "$STAGE/night-bazaar-server"; chmod 0755 "$STAGE/night-bazaar-server"
  # Runtime .so closure (glibc + libgcc).
  for so in $(ldd "$BIN" | grep -oE "/nix/store/[^ ]+\.so[^ ]*"); do
    base=$(basename "$so")
    cp -L "$so" "$STAGE/lib/$base"; chmod 0644 "$STAGE/lib/$base"
  done
  # The ELF interpreter (dynamic loader).
  INTERP=$(ldd "$BIN" | grep -oE "/nix/store/[^ ]+ld-linux[^ ]*" | head -1 | cut -d" " -f1)
  cp -L "$INTERP" "$STAGE/lib/ld-linux-x86-64.so.2"; chmod 0755 "$STAGE/lib/ld-linux-x86-64.so.2"
  # Repoint at the bundled interpreter + rpath (image path /opt/nbz/lib).
  patchelf --set-interpreter /opt/nbz/lib/ld-linux-x86-64.so.2 \
           --set-rpath /opt/nbz/lib "$STAGE/night-bazaar-server"
  echo "    interp: $(patchelf --print-interpreter "$STAGE/night-bazaar-server")"
  echo "    rpath:  $(patchelf --print-rpath "$STAGE/night-bazaar-server")"
  echo "    staged libs:"; ls -1 "$STAGE/lib"
'

echo "==> done. Stage: $STAGE  (+ client/dist)"
echo "    Now: cd $ROOT && docker build -t night-bazaar:latest ."
