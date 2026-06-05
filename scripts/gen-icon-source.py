#!/usr/bin/env python3
"""Generate a 1024x1024 RGBA source icon for `tauri icon` — no external deps.

A simple, on-brand placeholder: an indigo (#6366f1) rounded-square tile with a
white padlock (nods to the zero-knowledge Vault). Pure stdlib (zlib + struct),
so it runs anywhere without Pillow/ImageMagick. Replace with real brand art when
available; this just unblocks `tauri build` icon bundling.

Usage:  python3 scripts/gen-icon-source.py [out.png]
"""
import math
import struct
import sys
import zlib

W = H = 1024


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_rect_alpha(x, y, x0, y0, x1, y1, r):
    """Soft (anti-aliased) coverage in [0,1] for a rounded rect."""
    # distance outside the rounded rect (negative inside)
    dx = max(x0 + r - x, 0, x - (x1 - r))
    dy = max(y0 + r - y, 0, y - (y1 - r))
    if dx == 0 and dy == 0:
        # interior (away from corner regions) — but also handle straight edges
        outside = max(x0 - x, x - x1, y0 - y, y - y1)
        return max(0.0, min(1.0, 0.5 - outside))
    d = math.hypot(dx, dy) - r
    return max(0.0, min(1.0, 0.5 - d))


INDIGO_TOP = (99, 102, 241)    # #6366f1
INDIGO_BOT = (79, 70, 229)     # #4f46e5
WHITE = (255, 255, 255)

# Lock geometry
CX = 512
SHACKLE_CY = 430
SHACKLE_RO = 150
SHACKLE_RI = 92
BODY_X0, BODY_X1 = 332, 692
BODY_Y0, BODY_Y1 = 520, 824
BODY_R = 64
KEY_CY = 648
KEY_R = 36
STEM_W = 30
STEM_Y1 = 736


def lock_coverage(x, y):
    """White coverage in [0,1] for the padlock at (x,y); 0 = no lock."""
    cov = 0.0
    # Shackle: annulus, only the part at/above the body top (forms the ∩ + legs).
    if y <= BODY_Y0 + 24:
        d = math.hypot(x - CX, y - SHACKLE_CY)
        ring = min(1.0, max(0.0, 0.5 - (abs(d - (SHACKLE_RO + SHACKLE_RI) / 2)
                                        - (SHACKLE_RO - SHACKLE_RI) / 2)))
        cov = max(cov, ring)
    # Body: rounded rect.
    cov = max(cov, rounded_rect_alpha(x, y, BODY_X0, BODY_Y0, BODY_X1, BODY_Y1, BODY_R))
    return cov


def keyhole_coverage(x, y):
    """Indigo keyhole cut into the body (circle + tapering stem)."""
    cov = 0.0
    d = math.hypot(x - CX, y - KEY_CY)
    cov = max(cov, min(1.0, max(0.0, 0.5 - (d - KEY_R))))
    if KEY_CY <= y <= STEM_Y1:
        half = STEM_W / 2 * (1.0 + (y - KEY_CY) / (STEM_Y1 - KEY_CY) * 0.6)
        cov = max(cov, min(1.0, max(0.0, 0.5 - (abs(x - CX) - half))))
    return cov


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/mind-shell-icon-source.png"
    raw = bytearray()
    for y in range(H):
        raw.append(0)  # PNG filter type 0 for this scanline
        bg = lerp(INDIGO_TOP, INDIGO_BOT, y / (H - 1))
        for x in range(W):
            tile = rounded_rect_alpha(x, y, 8, 8, W - 8, H - 8, 180)
            if tile <= 0.0:
                raw += b"\x00\x00\x00\x00"
                continue
            r, g, b = bg
            lock = lock_coverage(x, y)
            if lock > 0.0:
                r = round(r + (WHITE[0] - r) * lock)
                g = round(g + (WHITE[1] - g) * lock)
                b = round(b + (WHITE[2] - b) * lock)
                key = keyhole_coverage(x, y)
                if key > 0.0:
                    kr, kg, kb = lerp(INDIGO_TOP, INDIGO_BOT, 0.5)
                    r = round(r + (kr - r) * key)
                    g = round(g + (kg - g) * key)
                    b = round(b + (kb - b) * key)
            a = round(255 * tile)
            raw += bytes((r, g, b, a))

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(out, "wb") as f:
        f.write(png)
    print(f"wrote {out} ({len(png)} bytes, {W}x{H} RGBA)")


if __name__ == "__main__":
    main()
