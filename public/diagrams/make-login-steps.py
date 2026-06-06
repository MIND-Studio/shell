#!/usr/bin/env python3
"""
login-steps — Mind house-style step-by-step Lottie explainer for HOW-LOGIN-WORKS.

The one idea: your master password opens a LOCAL safe; inside is a key card; only
the key card crosses the network; then you read & write your own data. The password
never leaves your device.

Beats (seamless 10s @30fps loop):
  1  YOU TYPE YOUR MASTER PASSWORD      (password station lights, reticle snaps on)
  2  IT OPENS YOUR LOCAL SAFE           (pulse password->safe, lock-open flash)
  3  INSIDE IS YOUR KEY CARD            (pulse safe->key card, reticle on key card)
  4  ONLY THE KEY CARD CROSSES          (bright pulse key card -> server, over the net)
  5  NOW YOU READ & WRITE YOUR DATA     (server reticle + write flash + radar)
  + calm anchor beat before the wrap.
"""
import sys, os
sys.path.insert(0, "/Users/heussers/develop/mind/shell/.claude/skills/mind-animation")
from lottie_kit import *

CW, CH = 120, 120                 # station card size
CY_MID = 222                      # vertical centre of the station row
HW, HH = CW / 2, CH / 2
NET_X = 452                       # network divider x

# (name, cx, accent, body_stroke, title)
ST = [
    ("pw",   92,  CYB,   CYB,   "master password"),
    ("safe", 232, SLATE, SLATE, "the safe"),
    ("key",  372, SLATE, SLATE, "key card"),
    ("data", 558, SLATE, SLATE, "your data"),
]
CX = {n: cx for n, cx, *_ in ST}

# ---------------------------------------------------------------- front text
eyebrow("HOW LOGIN WORKS")
caption_track([
    ("YOU TYPE YOUR MASTER PASSWORD",       (16, 26, 76, 86),    CYB),
    ("IT OPENS YOUR LOCAL SAFE",            (88, 98, 140, 150),  CY),
    ("INSIDE IS YOUR KEY CARD",             (150, 160, 186, 196), CY),
    ("ONLY THE KEY CARD CROSSES THE NETWORK", (196, 206, 250, 260), CYB),
    ("NOW YOU READ & WRITE YOUR DATA",      (262, 270, 286, 294), CYB),
], y=CH + 296)

# zone labels
add(text_layer("zL", "ON YOUR DEVICE", 11, FAINT, (32, 150), tr_=UT, j=0))
add(text_layer("zR", "THE SERVER", 11, FAINT, (498, 150), tr_=UT, j=0))
# network label above the divider
add(text_layer("net", "THE NETWORK", 9.5, C('4a5468'), (NET_X, 168), tr_=UT, j=2))
# persistent reminder under the hero
add(text_layer("never", "never leaves your device", 9.5, CYB, (CX["pw"], CY_MID + HH + 22), tr_=0, j=2))

# ---------------------------------------------------------------- station names
for n, cx, acc, bstroke, title in ST:
    col = CYB if n == "pw" else INK
    add(text_layer("t:" + n, title, 12, col, (cx, CY_MID + 30), tr_=0, j=2))

# ---------------------------------------------------------------- station icons
IY = CY_MID - 18
def icon(nm, shapes, cx):
    add(shape_layer("ic:" + nm, [group(shapes, nm="ic")],
                    ks={"p": stat([cx, IY, 0]), "a": stat([0, 0, 0])}))

# password — four combination dots
icon("pw", [group([ell(8, 8, p=(dx, 0)), fill(CYB)], nm="d") for dx in (-21, -7, 7, 21)], CX["pw"])
# safe — padlock (shackle ring + body covering its lower half)
icon("safe", [
    group([ell(22, 24, p=(0, -3)), stroke(C('aeb6c6'), 2.0, o=95)], nm="shk"),
    group([rect(30, 22, 4, p=(0, 6)), fill(CARDBG), stroke(C('aeb6c6'), 2.0, o=95)], nm="bdy"),
    group([ell(3.5, 3.5, p=(0, 4)), fill(C('aeb6c6'))], nm="kh"),
], CX["safe"])
# key card — chip card
icon("key", [
    group([rect(46, 30, 5), fill(CYD), stroke(CYB, 1.8, o=80)], nm="card"),
    group([rect(11, 9, 1.5, p=(-9, -4)), stroke(CYB, 1.4, o=80)], nm="chip"),
    group([poly([(-21, 8), (21, 8)]), stroke(CYB, 1.6, o=55)], nm="mag"),
], CX["key"])
# your data — document with text lines
icon("data", [
    group([rect(30, 38, 3), stroke(C('aeb6c6'), 2.0, o=90)], nm="doc"),
    group([poly([(-9, -8), (9, -8)]), stroke(MUT, 1.6)], nm="l1"),
    group([poly([(-9, 0), (9, 0)]), stroke(MUT, 1.6)], nm="l2"),
    group([poly([(-9, 8), (3, 8)]), stroke(MUT, 1.6)], nm="l3"),
], CX["data"])

# ---------------------------------------------------------------- reticles (current step)
reticle("pw",   CX["pw"],   CY_MID, HW, HH, CYB, 16, 24, 78, 86)
reticle("safe", CX["safe"], CY_MID, HW, HH, CYB, 88, 96, 140, 148)
reticle("key",  CX["key"],  CY_MID, HW, HH, CYB, 150, 158, 192, 200)
reticle("data", CX["data"], CY_MID, HW, HH, CYB, 216, 224, 288, 296)

# ---------------------------------------------------------------- travelling pulses
travel("pw2safe", (CX["pw"] + HW - 4, CY_MID),   (CX["safe"] - HW + 4, CY_MID), CYB, 60, 84, size=10)
travel("safe2key", (CX["safe"] + HW - 4, CY_MID), (CX["key"] - HW + 4, CY_MID),  CYB, 124, 148, size=10)
# the hero moment — the key card crosses the network
travel("key2data", (CX["key"] + HW - 4, CY_MID),  (CX["data"] - HW + 4, CY_MID), CYB, 196, 220, size=14)

# ---------------------------------------------------------------- flashes
flash("unlock", CX["safe"], IY, CYB, 100, w=44, h=30, peak=60)   # safe opens
flash("write",  CX["data"], CY_MID, CYB, 272, w=84, h=34, peak=58)  # read & write

# ---------------------------------------------------------------- station bodies (behind icons/text)
for n, cx, acc, bstroke, title in ST:
    glow = group([rect(CW + 8, CH + 8, 17), stroke(bstroke, 1.4, o=22)], nm="glow")
    body = group([rect(CW, CH, 14), fill(CARDBG), stroke(bstroke, 2.0, o=(85 if n == "pw" else 65))], nm="body")
    add(shape_layer("card:" + n, [glow, body], ks={"p": stat([cx, CY_MID, 0]), "a": stat([0, 0, 0])}))

# ---------------------------------------------------------------- connectors (steady rail)
connector("rail1", (CX["pw"] + HW, CY_MID),   (CX["safe"] - HW, CY_MID), SLATE, o=40, off_to=-320)
connector("rail2", (CX["safe"] + HW, CY_MID), (CX["key"] - HW, CY_MID),  SLATE, o=40, off_to=-320)
connector("rail3", (CX["key"] + HW, CY_MID),  (CX["data"] - HW, CY_MID), CY,    o=46, off_to=-320)

# ---------------------------------------------------------------- network divider
add(shape_layer("netline",
    [group([poly([(NET_X, 176), (NET_X, CY_MID + HH + 8)]),
            stroke(C('2b3342'), 1.4, o=100, dash=DASH(4, 5))], nm="nl")],
    ks={"p": stat([0, 0, 0]), "a": stat([0, 0, 0])}))

# ---------------------------------------------------------------- breathing glow on the hero
hglow = group([rect(CW + 10, CH + 10, 18), stroke(CYB, 3.0, o=100)], nm="hg")
ho = A([(0, 24, SMOOTH), (75, 42, SMOOTH), (150, 24, SMOOTH), (225, 42, SMOOTH), (300, 24, None)])
hs = A([(0, [100, 100], SMOOTH), (150, [103, 103], SMOOTH), (300, [100, 100], None)])
add(shape_layer("heroglow", [hglow], ks={"p": stat([CX["pw"], CY_MID, 0]), "a": stat([0, 0, 0]), "o": ho, "s": hs}))

# ---------------------------------------------------------------- radar from the live server (back)
radar(CX["data"], CY_MID, 70, 70, color=CYB, peak=28)

finish("public/diagrams/login-steps.json")
