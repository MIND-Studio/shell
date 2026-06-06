# Deploying `shell` as `shell.mindpods.org`

Runbook for adding the shell + Vault to the live `mindpods.org` fleet. Follows
PRD §2.3 (steps 1–5) and `mindpods-infra/docs/APP-DOCKERFILE.md`. The infra
stack went live 2026-05-31 (single Hetzner VM `37.27.80.161`, SSH alias
`mind-codespaces`, one Caddy edge, CSS at `pod.mindpods.org` = the OIDC issuer).

This repo already carries the app-side pieces (PRD §2.3 step 1):
`output: "standalone"` in `next.config.ts`, the prod `Dockerfile` (with the
Rust→WASM build step), `.npmrc`, and `.github/workflows/release.yml`
(`IMAGE_NAME: mind-shell`). The steps below are what's left: build the image,
add a catalog tile, and wire the infra repo.

> **Deploy gotchas (PRD §2.3) — honor all four:**
> 1. `NEXT_PUBLIC_*` is **build-time-inlined**. Changing the issuer/pod/sibling
>    URLs means **rebuilding the image**, not editing compose. After a domain
>    change, hard-reload open tabs (stale inlined values otherwise).
> 2. A Caddyfile-only change needs `docker compose ... up -d --force-recreate
>    caddy` — the single-file bind-mount inode trap means a plain `restart`
>    serves the old file.
> 3. GHCR images are **private**; the box authenticates via its gitignored
>    `ghcr.env` (PAT with `read:packages`).
> 4. `workflow_dispatch` builds **committed HEAD** — commit any build-arg edits
>    before triggering a manual build.
> 5. **On-page login needs a CORS-permissive pod.** The shell's on-page password
>    login (`PasswordLoginCard`) calls `pod.mindpods.org/.account/` and
>    `…/.oidc/token` **cross-origin from `shell.mindpods.org` in the browser**, and
>    mints **client-credentials** via the Account API. The prod CSS must therefore
>    (a) send `Access-Control-Allow-Origin` (echoing the shell origin) +
>    `Access-Control-Allow-Credentials: true` on those endpoints, and (b) keep
>    browser client-credentials creation enabled. If it doesn't, on-page login
>    fails and the UI **falls back to the redirect `MindLoginCard`** (still works)
>    — so this degrades gracefully, but the on-page path won't function until the
>    pod allows it. **Verify against the live pod before relying on §C** (step 6).

---

## 1. Build & push the image (PRD §2.3 step 1 + 5)

The build-args are baked into `release.yml` already (public mindpods.org URLs):

```
NEXT_PUBLIC_SOLID_ISSUER=https://pod.mindpods.org/
NEXT_PUBLIC_POD_BASE_URL=https://pod.mindpods.org/
NEXT_PUBLIC_SHELL_NAMESPACE=mind-shell
NEXT_PUBLIC_APP_DOCK_URL=https://dock.mindpods.org
NEXT_PUBLIC_APP_DRIVE_URL=https://drive.mindpods.org
NEXT_PUBLIC_APP_BUILDER_URL=https://builder.mindpods.org
NEXT_PUBLIC_APP_CODESPACES_URL=https://codespaces.mindpods.org
```

Tag and push (CI builds the image — including the Rust→WASM step — runs the
`crypto-audit` job, then pushes to GHCR and prints the digest):

```bash
git tag v0.1.0 && git push --tags
# or, to build a specific ref by hand:
gh workflow run release.yml -f ref=main
```

Copy the printed `MIND_SHELL_IMAGE=ghcr.io/mind-studio/mind-shell@sha256:...`
line from the job summary — it goes into the infra repo's `images.env` (step 4).

---

## 2. DNS (PRD §2.3 step 4)

Add an A record → the VM. Wait for propagation **before** first boot — Caddy
issues the Let's Encrypt cert on the first request per host, and a failed
challenge counts against the LE rate limit.

| Type | Name | Value |
|---|---|---|
| A | `shell` | 37.27.80.161 |

(Add AAAA too if the box has stable IPv6.)

---

## 3. Catalog tile (PRD §2.3 step 3) — in `mind-shared-ui`, NOT here

The shared app launcher (`@mind-studio/core`) shows the suite as tiles. Add a
Shell/Vault tile to **`mind-shared-ui/src/apps/catalog.ts`** → `DEFAULT_APPS`.
URLs MUST be **static** `process.env.NEXT_PUBLIC_APP_*_URL` member accesses —
Next only inlines those, never dynamic `process.env[key]` lookups.

Exact diff to apply (in the `mind-shared-ui` repo):

```diff
 const CODESPACES_URL = process.env.NEXT_PUBLIC_APP_CODESPACES_URL ?? "http://localhost:3010";
+const SHELL_URL = process.env.NEXT_PUBLIC_APP_SHELL_URL ?? "http://localhost:3100";

 export const DEFAULT_APPS: AppEntry[] = [
   { key: "dock", label: "Dock", url: DOCK_URL, icon: "🧭", blurb: "Your pod, all in one place.", order: 0 },
   { key: "drive", label: "Drive", url: DRIVE_URL, icon: "📁", blurb: "Your files, in your pod.", order: 1 },
   { key: "builder", label: "Builder", url: BUILDER_URL, icon: "🛠️", blurb: "Wish an app, watch it build.", order: 2 },
   { key: "codespaces", label: "Codespaces", url: CODESPACES_URL, icon: "🧰", blurb: "Publish a site to your pod.", order: 3 },
+  { key: "shell", label: "Shell", url: SHELL_URL, icon: "🪟", blurb: "The everything app — your apps + Vault.", order: 4 },
 ];
```

Then (in `mind-shared-ui`): publish a new `@mind-studio/core`, bump it in every
consumer, and rebuild each consumer image so the new tile (and its
`NEXT_PUBLIC_APP_SHELL_URL` build-arg) is inlined. Every consumer image's
`Dockerfile` + `release.yml` then needs the matching build-arg added:

```
NEXT_PUBLIC_APP_SHELL_URL=https://shell.mindpods.org
```

> Do NOT edit `mind-shared-ui` from this repo — the snippet above is the change
> to make there, owned by that package. Until it ships, the shell still deploys
> and works; it just won't appear as a tile in the other apps' launchers yet.

---

## 4. Wire the infra repo (`mindpods-infra`, PRD §2.3 step 4)

Three edits in the infra repo (do them there; this repo never touches infra).

**a) Caddy vhost** — add to `caddy/Caddyfile` alongside the other app vhosts:

```caddyfile
{$MIND_DOMAIN_SHELL} {
	encode zstd gzip
	reverse_proxy shell:3000
}
```

**b) compose service** — add to `compose.yml` under the front-end apps block
(same shape as `dock`/`drive`/`builder`); add `shell` to the caddy
`depends_on` list, and `MIND_DOMAIN_SHELL` to caddy's `environment`:

```yaml
  shell:
    image: ${MIND_SHELL_IMAGE:?set MIND_SHELL_IMAGE in images.env}
    container_name: mind-shell
    restart: unless-stopped
    environment:
      NODE_ENV: production
      HOSTNAME: "0.0.0.0"   # Next standalone binds localhost otherwise
      PORT: "3000"
    expose: ["3000"]
    networks: [mind]
```

Add the hostname env to the `caddy` service environment and `.env.example`:

```
MIND_DOMAIN_SHELL=shell.mindpods.org
```

**c) image pin** — add to `images.env` (gitignored on the box) the digest
printed by CI in step 1:

```
MIND_SHELL_IMAGE=ghcr.io/mind-studio/mind-shell@sha256:...
```

---

## 5. Deploy (PRD §2.3 step 5)

From a checkout of `mindpods-infra` on your laptop, with `.env` (incl. the new
`MIND_DOMAIN_SHELL`) and `images.env` (incl. `MIND_SHELL_IMAGE`) present on the
box:

```bash
./scripts/deploy.sh
```

This rsyncs the committed config (compose, Caddyfile), `docker login`s GHCR
from the box's `ghcr.env`, pulls the digest-pinned images, and `up -d`s the
stack. Because the Caddyfile changed, force-recreate the edge so the new vhost
loads (single-file bind-mount inode trap, gotcha #2):

```bash
ssh mind-codespaces 'cd /opt/mindpods-infra && \
  docker compose --env-file .env --env-file images.env up -d --force-recreate caddy'
```

---

## 6. Verify

- `https://shell.mindpods.org` serves the shell; the login card points at
  `pod.mindpods.org` and SSO works if already signed in at a sibling.
- **Redirect login** (`MindLoginCard`) — "Continue with Mind" → land in the shell,
  switch Workspace / Project / app. This is the always-on path.
- **On-page password login (§C)** — sign in with email + password on `/connect`
  and confirm it lands in `/shell` **without a redirect to `pod.mindpods.org`**. If
  the browser console shows a CORS error on `/.account/` or `…/.oidc/token`, the
  pod isn't configured per gotcha #5 — the redirect card still works, but on-page
  login is unavailable until the pod allows it. (Quick pre-check from a shell box:
  `curl -i -X OPTIONS https://pod.mindpods.org/.account/ -H 'Origin:
  https://shell.mindpods.org' -H 'Access-Control-Request-Method: POST'` →
  expect `access-control-allow-origin` echoing the shell origin.)
- **Background resume / one-tap unlock (A/B)** — after an on-page login, hard-reload
  the tab: the front door should show only the unlock hero; one master-password
  entry re-enters as the same identity (no email/issuer, no redirect).
- **Hosted app over the bridge** — with an `embed:"iframe"` app in the user's
  `home/apps.ttl`, open it from the app switcher: it renders in the app body, shows
  the right WebID (handshake), and a brokered read works — confirm in DevTools that
  the **iframe makes no authed pod request itself** (the credential never crosses).
- Create a Vault item, then confirm **only ciphertext** landed in the pod:
  run `npm run smoke:vault` against the pod (or inspect `*.enc` under
  `{pod}/apps/vault/items/` — opaque bytes, no plaintext).
- Once the new `@mind-studio/core` is published and consumers rebuilt, the
  Shell tile appears in the dock launcher.
