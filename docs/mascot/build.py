"""Builds the Shorty mascot (docs/mascot/shorty-*.svg) from shared parts.
Cel-shaded cartoon: a tilted clapperboard bean with a dark warm outline, holding scissors (it edits).
Run: python3 build.py [OUTDIR]"""
import sys
from pathlib import Path

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent

C = {
    "body": "#F25C2E",    # tomato
    "shade": "#D2421B",
    "light": "#FF9168",
    "line": "#4A1D12",    # outline: a dark tomato, not black
    "cream": "#FFF4E6",
    "steel": "#E9EEF2",
    "steel2": "#B9C3CC",
    "grip": "#1E9BAA",    # teal: the complementary accent
    "bg": "#1E9BAA",
    "bg2": "#2BB3C3",
}
W = 9

# bean-shaped body (slightly pear, flat-ish top for the clapper)
BODY = "M200 132 C258 130 290 150 294 214 L300 314 C303 362 266 382 200 382 C134 382 97 362 100 314 L106 214 C110 150 142 134 200 132 Z"


def clapper_band():
    stripes = "".join(f'<path d="M{x} 124 L{x + 24} 124 L{x + 8} 168 L{x - 16} 168 Z" fill="{C["cream"]}"/>' for x in (116, 164, 212, 260, 308))
    return (f'<clipPath id="bodyClip"><path d="{BODY}"/></clipPath>'
            f'<path d="{BODY}" fill="{C["body"]}"/>'
            f'<g clip-path="url(#bodyClip)">'
            # cel shading: darker right side
            f'<path d="M258 120 C300 200 306 300 244 392 L320 392 L320 110 Z" fill="{C["shade"]}"/>'
            f'<rect x="90" y="110" width="220" height="56" fill="{C["line"]}"/>{stripes}'
            f'</g>'
            f'<path d="M104 166 L296 166" stroke="{C["line"]}" stroke-width="{W}"/>'
            f'<path d="{BODY}" fill="none" stroke="{C["line"]}" stroke-width="{W}" stroke-linejoin="round"/>'
            # light strokes on the lit side
            f'<g stroke="{C["light"]}" stroke-width="9" stroke-linecap="round" fill="none">'
            f'<path d="M126 250 Q124 220 134 200"/><path d="M124 282 L124 290"/></g>')


def clapper_arm(angle=-18):
    stripes = "".join(f'<path d="M{x} 0 L{x + 24} 0 L{x + 8} 32 L{x - 16} 32 Z" fill="{C["cream"]}"/>' for x in (28, 76, 124, 172))
    return (f'<g transform="rotate({angle} 120 132)">'
            f'<clipPath id="clap"><rect x="0" y="0" width="186" height="32" rx="9"/></clipPath>'
            f'<g transform="translate(110 98)"><rect width="186" height="32" rx="9" fill="{C["line"]}"/>'
            f'<g clip-path="url(#clap)">{stripes}</g>'
            f'<rect width="186" height="32" rx="9" fill="none" stroke="{C["line"]}" stroke-width="{W}"/></g></g>'
            f'<circle cx="120" cy="132" r="10" fill="{C["cream"]}" stroke="{C["line"]}" stroke-width="6"/>')


def limb(d):
    return f'<path d="{d}" fill="none" stroke="{C["line"]}" stroke-width="{W}" stroke-linecap="round" stroke-linejoin="round"/>'


def hand(x, y, r=17):
    return (f'<circle cx="{x}" cy="{y}" r="{r}" fill="{C["cream"]}" stroke="{C["line"]}" stroke-width="{W - 1}"/>'
            f'<path d="M{x + 2} {y + 9} q7 -3 8 -10" fill="none" stroke="{C["line"]}" stroke-width="3.5" stroke-linecap="round" opacity="0.45"/>')


LEGS = (limb("M168 378 C166 396 170 408 166 418") + limb("M232 378 C234 396 230 408 234 418")
        + f'<path d="M134 428 Q134 410 164 412 Q188 414 186 428 Z" fill="{C["line"]}"/>'
        + f'<path d="M266 428 Q266 410 236 412 Q212 414 214 428 Z" fill="{C["line"]}"/>')
SHADOW = f'<ellipse cx="200" cy="436" rx="96" ry="10" fill="{C["line"]}" opacity="0.14"/>'


def scissors(x, y, angle, k=1.35):
    """Open scissors, pivot at (x, y), blades pointing along `angle` (degrees, 0 = up)."""
    blade = f'M0 0 L-9 -96 Q-2 -104 6 -96 L9 0 Z'
    return (f'<g transform="translate({x} {y}) rotate({angle}) scale({k})">'
            f'<g transform="rotate(-11)"><path d="{blade}" fill="{C["steel"]}" stroke="{C["line"]}" stroke-width="6" stroke-linejoin="round"/>'
            f'<path d="M-3 -16 L-6 -80" stroke="{C["steel2"]}" stroke-width="4" stroke-linecap="round"/></g>'
            f'<g transform="rotate(11)"><path d="{blade}" fill="{C["steel"]}" stroke="{C["line"]}" stroke-width="6" stroke-linejoin="round"/></g>'
            f'<g fill="none" stroke="{C["line"]}" stroke-width="15">'
            f'<ellipse cx="-17" cy="30" rx="15" ry="19" transform="rotate(20 -17 30)"/><ellipse cx="17" cy="30" rx="15" ry="19" transform="rotate(-20 17 30)"/></g>'
            f'<g fill="none" stroke="{C["grip"]}" stroke-width="8">'
            f'<ellipse cx="-17" cy="30" rx="15" ry="19" transform="rotate(20 -17 30)"/><ellipse cx="17" cy="30" rx="15" ry="19" transform="rotate(-20 17 30)"/></g>'
            f'<circle r="7" fill="{C["grip"]}" stroke="{C["line"]}" stroke-width="5"/></g>')


# ---- faces: pill eyes, no sparkles; personality comes from brows and mouth
def eyes(dx=0, dy=0, h=28):
    return "".join(f'<rect x="{x - 8 + dx}" y="{222 - h / 2 + dy}" width="16" height="{h}" rx="8" fill="{C["line"]}"/>' for x in (172, 228))


BROWS_COCKY = (f'<g stroke="{C["line"]}" stroke-width="8" stroke-linecap="round" fill="none">'
               '<path d="M158 192 L184 196"/><path d="M216 190 Q230 180 244 186"/></g>')
BROWS_UP = (f'<g stroke="{C["line"]}" stroke-width="8" stroke-linecap="round" fill="none">'
            '<path d="M160 190 Q172 182 184 188"/><path d="M216 188 Q228 182 240 190"/></g>')
SMIRK = f'<path d="M178 262 Q206 280 226 252" fill="none" stroke="{C["line"]}" stroke-width="8" stroke-linecap="round"/>'
GRIN = (f'<path d="M172 252 Q200 296 230 250 Z" fill="{C["line"]}" stroke="{C["line"]}" stroke-width="6" stroke-linejoin="round"/>'
        f'<path d="M186 274 Q200 264 214 272 Q202 286 186 274 Z" fill="#FF8C7A"/>')
OPEN_O = f'<ellipse cx="202" cy="262" rx="9" ry="11" fill="{C["line"]}"/>'
EYES_JOY = (f'<g fill="none" stroke="{C["line"]}" stroke-width="9" stroke-linecap="round">'
            '<path d="M160 230 Q172 210 184 230"/><path d="M216 230 Q228 210 240 230"/></g>')
EYES_SLEEP = (f'<g fill="none" stroke="{C["line"]}" stroke-width="8" stroke-linecap="round">'
              '<path d="M160 224 Q172 234 184 224"/><path d="M216 224 Q228 234 240 224"/></g>')
SNOOZE_MOUTH = f'<path d="M192 262 Q202 268 212 262" fill="none" stroke="{C["line"]}" stroke-width="7" stroke-linecap="round"/>'

CONFETTI = "".join(
    f'<rect x="{x}" y="{y}" width="12" height="19" rx="3" fill="{f}" stroke="{C["line"]}" stroke-width="4" transform="rotate({r} {x + 6} {y + 9})"/>'
    for x, y, f, r in [(40, 96, C["grip"], -20), (340, 84, C["light"], 25), (34, 262, C["light"], 40), (350, 256, C["grip"], -35),
                       (150, 30, C["grip"], 15), (252, 22, C["light"], -12), (22, 176, C["cream"], 60), (368, 168, C["cream"], -50)])
BUBBLE = (f'<g transform="translate(272 118)">'
          f'<path d="M22 0 H96 Q118 0 118 22 V44 Q118 66 96 66 H40 L16 88 L24 66 H22 Q0 66 0 44 V22 Q0 0 22 0 Z" fill="{C["cream"]}" stroke="{C["line"]}" stroke-width="7" stroke-linejoin="round"/>'
          + "".join(f'<rect x="{24 + i * 12}" y="{33 - h / 2}" width="7" height="{h}" rx="3.5" fill="{C["grip"]}"/>' for i, h in enumerate([10, 22, 34, 18, 28, 12, 8]))
          + "</g>")
ZZZ = (f'<g fill="{C["line"]}" font-family="Montserrat, Arial, sans-serif" font-weight="900">'
       '<text x="290" y="126" font-size="36">z</text><text x="322" y="92" font-size="27">z</text><text x="346" y="64" font-size="20">z</text></g>')
WAVE_MARKS = (f'<g fill="none" stroke="{C["line"]}" stroke-width="6" stroke-linecap="round">'
              '<path d="M30 176 Q22 190 28 204"/><path d="M44 160 Q38 168 40 176"/></g>')


def figure(*parts, tilt=-6):
    return f'<g transform="rotate({tilt} 200 300)">' + "".join(parts) + "</g>"


def svg(title, *parts, w=400, h=460, bg=""):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">\n'
            f'<title>{title}</title>\n{bg}' + "\n".join(parts) + "\n</svg>\n")


ARM_R_SCISSORS = limb("M290 282 C316 280 330 266 334 246") + scissors(338, 236, 28) + hand(334, 246)
ARM_L_HIP = limb("M108 276 C86 284 84 304 98 316") + hand(100, 318)
ARM_L_WAVE = limb("M108 270 C84 262 70 236 70 206") + hand(68, 196)
ARM_L_REST = limb("M108 282 C88 292 84 314 90 334") + hand(90, 340)
ARM_R_REST = limb("M292 282 C312 292 316 314 310 334") + hand(310, 340)
ARM_L_UP = limb("M108 262 C84 244 74 212 76 176") + hand(76, 166)
ARM_R_UP = limb("M292 262 C316 244 326 212 324 176") + hand(324, 166)

POSES = {
    "hero": svg("Shorty", SHADOW, figure(LEGS, ARM_L_HIP, clapper_band(), clapper_arm(), BROWS_COCKY, eyes(), SMIRK, ARM_R_SCISSORS)),
    "wave": svg("Shorty waving", SHADOW, figure(LEGS, ARM_R_REST, clapper_band(), clapper_arm(), ARM_L_WAVE, WAVE_MARKS, BROWS_UP, eyes(), GRIN)),
    "celebrate": svg("Shorty celebrating", CONFETTI, SHADOW, figure(LEGS, clapper_band(), clapper_arm(-26), ARM_L_UP, ARM_R_UP, EYES_JOY, GRIN, tilt=0)),
    "listen": svg("Shorty listening", SHADOW, figure(LEGS, ARM_L_REST, ARM_R_REST, clapper_band(), clapper_arm(-10), BROWS_UP, eyes(4, -2, 30), OPEN_O, tilt=4), BUBBLE),
    "sleep": svg("Shorty sleeping", SHADOW, figure(LEGS, ARM_L_REST, ARM_R_REST, clapper_band(), clapper_arm(-4), EYES_SLEEP, SNOOZE_MOUTH, tilt=-3), ZZZ),
}

# App-icon style: the hero on teal rings, like an App Store icon
rings = "".join(f'<circle cx="256" cy="256" r="{r}" fill="none" stroke="{C["bg2"]}" stroke-width="22" opacity="0.55"/>' for r in (120, 190, 260, 330))
ICON = svg("Shorty icon",
           f'<g clip-path="url(#iconClip)"><rect width="512" height="512" fill="{C["bg"]}"/>{rings}'
           f'<g transform="translate(-58 -40) scale(1.4)">{figure(ARM_L_HIP, clapper_band(), clapper_arm(), BROWS_COCKY, eyes(), SMIRK, ARM_R_SCISSORS)}</g></g>',
           w=512, h=512, bg='<clipPath id="iconClip"><rect width="512" height="512" rx="112"/></clipPath>')

# Logo / favicon mark: just the head, readable at 16-24 px
mark_stripes = "".join(f'<path d="M{x} 0 L{x + 10} 0 L{x + 4} 18 L{x - 6} 18 Z" fill="{C["cream"]}"/>' for x in (12, 32, 52, 72))
MARK = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><title>Shorts</title>'
        f'<clipPath id="m"><rect x="6" y="6" width="84" height="84" rx="24"/></clipPath>'
        f'<g clip-path="url(#m)"><rect width="96" height="96" fill="{C["body"]}"/>'
        f'<path d="M70 0 C86 30 88 66 62 96 L96 96 L96 0 Z" fill="{C["shade"]}"/>'
        f'<rect y="0" width="96" height="30" fill="{C["line"]}"/><g transform="translate(0 12)">{mark_stripes}</g></g>'
        f'<rect x="6" y="6" width="84" height="84" rx="24" fill="none" stroke="{C["line"]}" stroke-width="6"/>'
        f'<path d="M6 30 H90" stroke="{C["line"]}" stroke-width="6"/>'
        f'<rect x="31" y="44" width="10" height="18" rx="5" fill="{C["line"]}"/><rect x="55" y="44" width="10" height="18" rx="5" fill="{C["line"]}"/>'
        f'<path d="M36 72 Q49 80 61 70" fill="none" stroke="{C["line"]}" stroke-width="6" stroke-linecap="round"/></svg>\n')

outs = [OUT] + ([] if len(sys.argv) > 1 else [Path(__file__).resolve().parents[2] / "web/src/assets/mascot"])
for out in outs:
    out.mkdir(parents=True, exist_ok=True)
    for name, s in POSES.items():
        (out / f"shorty-{name}.svg").write_text(s)
    (out / "shorty-icon.svg").write_text(ICON)
    (out / "mark.svg").write_text(MARK)
    print("wrote mascot to", out)
