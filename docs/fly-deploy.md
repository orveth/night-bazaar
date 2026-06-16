# Night Bazaar: Fly.io deploy guide

The exact command sequence to put Night Bazaar on a clickable public URL.
You run these: they touch your Fly account, payment, and org.

What ships: one container (the Rust server + the built Three.js client), a
persistent **volume** for the wallet files, and a **binding-key secret** so
deploys do not invalidate outstanding payment challenges. The mint is
`poptest.agi.cash` (MAINNET, real sats); fund prize tokens deliberately.

---

## 0. One-time: build the image artifacts (local)

The image is THIN: it copies a prebuilt binary, never builds inside Docker
(the pops dep is a private git repo; no SSH key is baked). Build the
binary + client + staged runtime tree first, from the repo root:

```sh
bash server/build-image.sh      # release build + bun build + patchelf stage
```

This produces `server/target/docker-stage/` (the patched binary + its bundled
glibc) and `client/dist/`. Fly builds the image from these via the `Dockerfile`
(remote builder; nothing else to install).

> Why bundled glibc: the nix devshell links against glibc 2.42 with a
> `/nix/store` ELF interpreter path, and musl is not available in the devshell.
> `build-image.sh` patchelf's the binary onto a bundled interpreter
> (`/opt/nbz/lib`) + copies the 4 runtime `.so` files, so it runs on the
> `distroless/static` base. TLS roots are compiled in (rustls + webpki-roots),
> so no ca-certificates are needed.

---

## 1. Create the app (no deploy yet)

```sh
fly launch --no-deploy --copy-config --name night-bazaar --region sjc
# (or, if you prefer to keep fly.toml verbatim:)
# fly apps create night-bazaar
```

`--copy-config` keeps the committed `fly.toml`. Pick your own name if
`night-bazaar` is taken; update `app =` in `fly.toml` to match.

---

## 2. Create the persistent volume (BEFORE first deploy)

The vault (prize tokens) and `revenue.jsonl` (a WALLET: redeemed proofs, real
money) MUST survive deploys/restarts. They live on this volume at `/data`.

```sh
fly volumes create bazaar_data --region sjc --size 1   # 1 GB; grow later if needed
```

The volume name + region must match `[mounts] source` and `primary_region` in
`fly.toml`. One volume = one machine; that is what we want (`min_machines_running
= 1`, a single stateful world).

---

## 3. Set the binding-key SECRET (deploy-survival)

Without this, every deploy generates a fresh per-boot key and invalidates every
outstanding payment challenge. Set it ONCE as a secret (never in `fly.toml` or
the image):

```sh
# Generate a fresh 32-byte hex key:
KEY=$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')
echo "$KEY"                                   # save this somewhere safe
fly secrets set BAZAAR_BINDING_KEY="$KEY"
```

Keep the key: if you ever recreate the app, reuse it to keep challenges valid.
(No other secrets are required: the mint is public and rustls bundles its CA
roots.)

---

## 4. Deploy

```sh
fly deploy
```

Fly builds the image from the `Dockerfile` + the staged artifacts and boots one
machine. Watch the logs for the boot banner and the valid-unit line:

```sh
fly logs
# expect:
#   night bazaar booting … mode=Live
#   valid pop-unit set discovered (newest = mint-into unit) accepted=[…] newest=pop_<ts>
#   revenue sink open (WALLET, back this file up) path=/data/revenue.jsonl
#   listening on http://0.0.0.0:8080
```

Your URL: **`https://night-bazaar.fly.dev`** (or `https://<your-app>.fly.dev`).
Open it: free ghosts connect with no install. Verify config:

```sh
curl -s https://night-bazaar.fly.dev/api/config | jq
# { "mintUrl": "https://poptest.agi.cash", "unit": "pop_<ts>",
#   "acceptedUnits": ["pop_<ts>", …], "prices": {…}, "mode": "live" }
```

---

## 5. Stock the vault for prizes (first finds)

Chests/booths render as already-looted/out-of-prizes until the vault holds
tokens. The vault is `/data/tokens.json` on the volume, keyed by chest/booth id:

```json
{ "chest.jade": ["cashuB…"], "chest.rooftop": [], "booth.riddle": [],
  "booth.gacha": [], "booth.bell": [] }
```

These are BEARER ecash (funded by you, keep them SMALL). Two ways to stock:

**A. SSH console (carve in place):**

```sh
fly ssh console
# distroless has no shell by default; use option B instead.
```

**B. Upload a prepared file (recommended):**

Prepare `tokens.json` locally with your prize cashuB strings, then push it onto
the volume and restart:

```sh
fly ssh sftp shell
put ./tokens.json /data/tokens.json
exit
fly apps restart night-bazaar      # claimed-flags derive from stock at boot
```

The vault file is read at claim time; the per-chest "already looted" flag is
derived at boot, so restock + restart brings a chest/booth to life.
`revenue.jsonl` accrues automatically as players pay; back the volume up.

---

## 6. Unit rotation (handled automatically)

`poptest` rotates its `pop_<ts>` unit (~every 2 days) with overlapping credit
windows. The server tracks the **whole set of currently-valid units** (every
keyset whose `final_expiry` is in the future; it ignores the lying `active`
flag) and:

- advertises the NEWEST as the mint-into unit (`/api/config` `unit`),
- ACCEPTS any still-valid unit a player declares (multi-unit accept: a returning
  player on yesterday's unit is not cut off),
- re-probes every 5 min (`BAZAAR_UNIT_REFRESH_SECS`), so a new unit is added and
  an expired one drops with no restart.

You do nothing for a normal rotation. **Fallback** if the set ever looks wrong
(e.g. the mint was re-registered): `fly apps restart night-bazaar` re-probes at
boot.

---

## 7. Price tuning (the experiment)

Prices are plain env. To change them:

```sh
# edit [env] BAZAAR_PRICE_* in fly.toml, then:
fly deploy
# (BAZAAR_BINDING_KEY is a secret, so the redeploy keeps challenges valid.)
```

---

## Custom domain (later)

```sh
fly certs add bazaar.example.com        # then add the CNAME/A records it prints
```

Point a CNAME at `night-bazaar.fly.dev` (or the A/AAAA records `fly certs show`
gives). Until then the `*.fly.dev` URL is the public address.

---

## Quick reference

| Step | Command |
|------|---------|
| Build artifacts | `bash server/build-image.sh` |
| Create app | `fly launch --no-deploy --copy-config --name night-bazaar --region sjc` |
| Create volume | `fly volumes create bazaar_data --region sjc --size 1` |
| Set binding key | `fly secrets set BAZAAR_BINDING_KEY=$(head -c32 /dev/urandom \| od -An -tx1 \| tr -d ' \n')` |
| Deploy | `fly deploy` |
| Logs | `fly logs` |
| Stock vault | `fly ssh sftp shell` then `put ./tokens.json /data/tokens.json` then `fly apps restart night-bazaar` |
| Restart (rotation fallback) | `fly apps restart night-bazaar` |
| URL | `https://night-bazaar.fly.dev` |

### Local smoke (optional, before deploying)

To exercise the live payment path locally without pushing to Fly, run the built
image against a Cashu mint you have access to:

```sh
docker run --rm --network host \
  -v "$PWD/.local/fly-volume:/data" \
  -e BAZAAR_MODE=live -e BAZAAR_BIND=0.0.0.0:8413 \
  -e BAZAAR_MINT_URL=http://<your-mint-host>:<port> \
  -e BAZAAR_MINT_PUBLIC_URLS=http://<your-mint-host>:<port> \
  -e BAZAAR_BINDING_KEY=<hex> \
  night-bazaar:latest
# then: curl -s http://127.0.0.1:8413/api/config | jq
```
