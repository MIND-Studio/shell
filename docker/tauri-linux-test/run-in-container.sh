#!/usr/bin/env bash
# Runs INSIDE the container: build the Linux Tauri binary, launch it headless
# under Xvfb, screenshot it, optionally click "Sign in", screenshot again.
# Artifacts are written to /work/docker/tauri-linux-test/artifacts/.
set -uo pipefail

OUT=/work/docker/tauri-linux-test/artifacts
mkdir -p "$OUT"

# RELEASE build: a debug Tauri build loads `build.devUrl` (http://localhost:3100),
# which does not exist in the container; the release build loads the EMBEDDED
# frontend (../out) via the asset protocol (correct MIME types too). So we must
# build release to actually render the app offline.
# --features custom-protocol => tauri `is_dev()` is false => the binary loads the
# EMBEDDED frontend (../out) via the asset protocol instead of build.devUrl
# (http://localhost:3100, which doesn't exist in the container). Without it the
# webview shows "Could not connect to localhost".
echo "[c] cargo build --release --features custom-protocol (linux/$(uname -m))..."
cd /work/src-tauri
if ! cargo build --release --features custom-protocol 2>&1 | tail -8; then
  echo "[c] BUILD FAILED"; exit 1
fi
BIN=${CARGO_TARGET_DIR:-/work/src-tauri/target}/release/mind-shell
[ -x "$BIN" ] || { echo "[c] binary missing at $BIN"; exit 1; }
echo "[c] built: $BIN"

echo "[c] starting Xvfb + D-Bus..."
Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
sleep 2
eval "$(dbus-launch --sh-syntax)"

echo "[c] launching app..."
"$BIN" >/tmp/app.log 2>&1 &
APP=$!

# Wait for a mapped window to appear (the Tauri/GTK window).
WID=""
for i in $(seq 1 40); do
  kill -0 "$APP" 2>/dev/null || { echo "[c] app exited early"; break; }
  WID=$(xdotool search --onlyvisible --name "" 2>/dev/null | tail -1 || true)
  [ -z "$WID" ] && WID=$(xdotool search --class "mind-shell" 2>/dev/null | tail -1 || true)
  [ -n "$WID" ] && break
  sleep 1
done
echo "[c] window id: ${WID:-none}"
echo "[c] window list:"; xdotool search --name "" getwindowname %@ 2>/dev/null | sed 's/^/[c]   /' | head

# Give the webview time to load + hydrate the SPA.
sleep 6
import -window root "$OUT/01-initial.png" 2>/tmp/import1.log \
  || scrot "$OUT/01-initial.png" 2>/tmp/scrot1.log \
  || echo "[c] screenshot 1 failed (see logs)"
echo "[c] shot 1 -> $OUT/01-initial.png ($(du -h "$OUT/01-initial.png" 2>/dev/null | cut -f1))"

# Try to interact: move/click near the primary button area, then re-shoot.
if [ -n "$WID" ]; then
  xdotool windowactivate "$WID" 2>/dev/null || true
  xdotool mousemove --window "$WID" 640 460 click 1 2>/dev/null || true
  sleep 3
  import -window root "$OUT/02-after-click.png" 2>/tmp/import2.log \
    || scrot "$OUT/02-after-click.png" 2>/tmp/scrot2.log || true
  echo "[c] shot 2 -> $OUT/02-after-click.png"
fi

echo "[c] ===== app stderr/stdout (no secrets expected) ====="
tail -40 /tmp/app.log 2>/dev/null | sed 's/^/[app] /'
echo "[c] ===== xvfb log tail ====="
tail -5 /tmp/xvfb.log 2>/dev/null | sed 's/^/[xvfb] /'

kill "$APP" 2>/dev/null || true
echo "[c] done"
