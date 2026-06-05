# Headless Linux (WebKitGTK) test harness for the mind-shell Tauri app.
#
# IMPORTANT FIDELITY NOTE: this builds the *Linux* Tauri target, whose webview is
# WebKitGTK — NOT the WKWebView used on macOS/iOS that ships to users. It verifies
# the frontend bundle + Tauri command wiring + native crypto/OIDC render and run
# under a real Tauri webview, headless. It does NOT verify macOS-specific webview
# behavior, and the system-browser OIDC leg cannot run in a container.
#
# Only the Rust binary is built here; the static frontend (../out) is reused from
# the host (it is platform-agnostic), so no Node / GitHub-Packages PAT is needed.
FROM rust:1-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# Tauri 2 Linux system deps + headless X (Xvfb), input synthesis (xdotool),
# screenshot (ImageMagick `import` / scrot), D-Bus, and fonts so text renders.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev \
      libgtk-3-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libsoup-3.0-dev \
      build-essential pkg-config file curl wget \
      xvfb xauth x11-utils xdotool imagemagick scrot \
      dbus dbus-x11 at-spi2-core \
      fonts-dejavu fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# WebKitGTK needs software rendering + compositing/DMABUF disabled to run on Xvfb.
ENV WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    GDK_BACKEND=x11 \
    DISPLAY=:99

WORKDIR /work/src-tauri
