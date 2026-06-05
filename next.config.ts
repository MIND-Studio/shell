import type { NextConfig } from "next";

// Two delivery targets share one frontend (PRD-NATIVE.md §4):
//   • Web/Docker  → `output: 'standalone'` (.next/standalone/server.js) — the
//     default, used by Dockerfile + .github/workflows/release.yml.
//   • Tauri native → `output: 'export'` (static HTML/CSS/JS in `out/`) — Tauri
//     ships no Node server, so the shell must run as a pure client bundle.
//
// We switch modes *only* when the `TAURI` env var is set. The `export` script
// (`TAURI=1 next build`) sets it, and Tauri drives it via
// `beforeBuildCommand: npm run export` (src-tauri/tauri.conf.json); the plain
// `build`/Docker path never sets it and stays standalone. Static export is viable
// here because all pod I/O is client-side (browser Solid SDK) and there are no
// route handlers, server actions, or dynamic server functions — see task #5.
const isTauri = process.env.TAURI === "1" || process.env.TAURI === "true";

const nextConfig: NextConfig = {
  output: isTauri ? "export" : "standalone",
  transpilePackages: ["@mind-studio/core", "@mind-studio/ui"],
  // `next/image` optimization needs a server; under static export it must be
  // unoptimized or the build errors. Harmless for the web build (we don't rely
  // on the optimizer), so set it only for the Tauri target.
  ...(isTauri ? { images: { unoptimized: true } } : {}),
};

export default nextConfig;
