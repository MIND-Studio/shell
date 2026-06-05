# syntax=docker/dockerfile:1.7
#
# Production image for mind-shell (the Dock-style shell + the Vault app). Two
# stages:
#   builder — installs deps, compiles the Rust crypto core to WASM, then runs
#             `next build` to emit .next/standalone.
#   runtime — minimal Debian-slim running the standalone server as non-root.
#
# Unlike the other Mind apps, this image has a Rust → WASM step: the Vault app
# imports the wasm-pack output at `src/lib/vault/pkg/`, so `npm run wasm` MUST
# run before `npm run build`. We add the Rust toolchain + wasm-pack to the
# builder via rustup (the official, version-pinnable path) rather than swapping
# to a `rust` base image, so the Node toolchain that drives `next build` stays
# the canonical node:22-bookworm-slim used across the fleet. The toolchain is
# confined to the builder stage and never reaches the runtime image.

# --- Stage 1: build --------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Build prerequisites for the Rust crypto core. `build-essential` (a C linker)
# is needed by cargo; `curl`/`ca-certificates` to fetch rustup + wasm-pack.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Rust toolchain (rustup) + the wasm32 target + wasm-pack. Pinned for
# reproducibility; bump deliberately. Installed into /usr/local so it's on PATH.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
# 1.85+ required: transitive dep base64ct 1.8.x ships `edition = "2024"`, which
# older toolchains can't parse (`cargo metadata` fails in `npm run wasm`).
# Pinned to the toolchain the crate is developed/tested against locally.
ARG RUST_VERSION=1.89.0
ARG WASM_PACK_VERSION=0.13.1
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain "${RUST_VERSION}" --profile minimal \
 && rustup target add wasm32-unknown-unknown \
 && curl -sSfL "https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      | tar -xz --strip-components=1 -C /usr/local/cargo/bin \
        "wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl/wasm-pack"

# `.npmrc` points the @mind-studio scope at GitHub Packages and reads the auth
# token from $NODE_AUTH_TOKEN, passed as a BuildKit secret (never layer-baked).
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token 2>/dev/null || true)" \
    npm ci --no-audit --no-fund

COPY . .
RUN mkdir -p public

# Compile the Rust crypto core to WASM BEFORE the Next build — `next build`
# imports the generated bindings at src/lib/vault/pkg/. (Matches package.json
# `wasm`: wasm-pack build --target web --out-dir ../src/lib/vault/pkg --no-pack.)
RUN npm run wasm

# NEXT_PUBLIC_* are inlined at build time (passed as build-args by the workflow).
ARG NEXT_PUBLIC_SOLID_ISSUER
ARG NEXT_PUBLIC_POD_BASE_URL
ARG NEXT_PUBLIC_SHELL_NAMESPACE
ENV NEXT_PUBLIC_SOLID_ISSUER=$NEXT_PUBLIC_SOLID_ISSUER \
    NEXT_PUBLIC_POD_BASE_URL=$NEXT_PUBLIC_POD_BASE_URL \
    NEXT_PUBLIC_SHELL_NAMESPACE=$NEXT_PUBLIC_SHELL_NAMESPACE

# The app launcher (shared @mind-studio/core) links to the sibling Mind apps;
# their public URLs are inlined here too.
ARG NEXT_PUBLIC_APP_DOCK_URL
ARG NEXT_PUBLIC_APP_DRIVE_URL
ARG NEXT_PUBLIC_APP_BUILDER_URL
ARG NEXT_PUBLIC_APP_CODESPACES_URL
ENV NEXT_PUBLIC_APP_DOCK_URL=$NEXT_PUBLIC_APP_DOCK_URL \
    NEXT_PUBLIC_APP_DRIVE_URL=$NEXT_PUBLIC_APP_DRIVE_URL \
    NEXT_PUBLIC_APP_BUILDER_URL=$NEXT_PUBLIC_APP_BUILDER_URL \
    NEXT_PUBLIC_APP_CODESPACES_URL=$NEXT_PUBLIC_APP_CODESPACES_URL

RUN npm run build

# --- Stage 2: runtime ------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

USER node

# The wasm bundle lives under .next/ (Next traces it into the standalone
# output), so copying standalone + static carries it into the runtime image —
# no Rust toolchain is needed here.
COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
COPY --chown=node:node --from=builder /app/public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
