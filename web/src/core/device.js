// Phone frame: the main track plays inside a drawn phone (generic, not any brand's artwork), on a
// background. Captions, text and stickers stay on top of everything.
//   p.frame = { device: "black" | "silver", size: 0.86, bg: "blur" | "color" | "gradient",
//               color: "#1c1917", gradient: 0 }
// The phone is drawn in the caption layer (drawDevice), so preview and export are identical; the
// background and placing the video in the screen are done by the player and by server.py.

const SCREEN_ASPECT = 0.4613; // 9 : 19.5, like current phones
export const GRADIENTS = [
  ["#dc4a22", "#f2b880"], ["#1e9baa", "#0d3b45"], ["#2b2d42", "#8d99ae"], ["#f5f3f0", "#d6cdc4"], ["#0f0f10", "#3a3a3c"],
];
const METAL = { black: ["#2c2c2e", "#4a4a4d"], silver: ["#c8c8cd", "#f2f2f5"] };
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

// Geometry in canvas units (= output pixels at the project's size), or null without a frame.
// The main track renders at Ws x Hs and is placed at (x, y).
export function deviceLayout(p) {
  const f = p.frame;
  if (!f || !f.device || f.device === "none") return null;
  const { w: W, h: H } = p.canvas;
  const bodyH = H * (f.size ?? 0.86);
  const b = bodyH * 0.018; // bezel
  let Hs = even(bodyH - 2 * b), Ws = even(Hs * SCREEN_ASPECT);
  if (Ws + 2 * b > W * 0.96) { Ws = even(W * 0.96 - 2 * b); Hs = even(Ws / SCREEN_ASPECT); }
  const x = even((W - Ws) / 2), y = even((H - Hs) / 2);
  return { x, y, Ws, Hs, b, r: Ws * 0.15, W, H };
}

// The size the main track renders at: the phone's screen, or the whole canvas.
// Rounded screen outline, for clipping the video (the export uses the same radius: spec.frame.radius).
export function screenPath(ctx, d) { ctx.beginPath(); rrect(ctx, d.x, d.y, d.Ws, d.Hs, d.r); }

export const mainSize = (p) => { const d = deviceLayout(p); return d ? { w: d.Ws, h: d.Hs } : { w: p.canvas.w, h: p.canvas.h }; };

function rrect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// The phone (shadow, metal rim, black bezel, camera pill, side buttons), screen left open.
export function drawDevice(ctx, d, device) {
  const [m0, m1] = METAL[device] || METAL.black;
  const { x, y, Ws, Hs, b, r } = d;
  const bx = x - b, by = y - b, bw = Ws + 2 * b, bh = Hs + 2 * b, br = r + b, rim = b * 0.38;
  ctx.save();
  // never paint inside the screen (the preview draws this layer over the video itself)
  ctx.beginPath(); ctx.rect(-1e5, -1e5, 2e5, 2e5); rrect(ctx, x, y, Ws, Hs, r); ctx.clip("evenodd");
  // side buttons
  ctx.fillStyle = m0;
  const btn = (side, at, len) => {
    ctx.beginPath(); rrect(ctx, side < 0 ? bx - b * 0.35 : bx + bw - b * 0.3, by + bh * at, b * 0.65, bh * len, b * 0.3); ctx.fill();
  };
  btn(-1, 0.17, 0.045); btn(-1, 0.24, 0.07); btn(-1, 0.33, 0.07); btn(1, 0.27, 0.1);
  // body with a soft shadow
  ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = bh * 0.04; ctx.shadowOffsetY = bh * 0.012;
  const g = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
  g.addColorStop(0, m1); g.addColorStop(0.5, m0); g.addColorStop(1, m1);
  ctx.fillStyle = g;
  ctx.beginPath(); rrect(ctx, bx, by, bw, bh, br); ctx.fill();
  ctx.shadowColor = "transparent";
  // black glass bezel inside the rim
  ctx.fillStyle = "#050505";
  ctx.beginPath(); rrect(ctx, bx + rim, by + rim, bw - 2 * rim, bh - 2 * rim, br - rim); ctx.fill();
  ctx.restore();
  // camera pill, over the top of the screen like on a real phone
  ctx.fillStyle = "#000";
  const pw = Ws * 0.3, ph = Ws * 0.088;
  ctx.beginPath(); rrect(ctx, x + (Ws - pw) / 2, y + Ws * 0.032, pw, ph, ph / 2); ctx.fill();
}

// Phone as an element (an overlay clip with o.phone = "black" | "silver"): the clip's video plays in
// the screen of a phone image. Reference geometry in image pixels; the export gets the same phone as
// a PNG (phonePng) and places the video under it (server.py, overlay_clip_chain).
export const PHONE = (() => {
  const Hs = 1600, Ws = even(Hs * SCREEN_ASPECT), b = 30, m = 100; // screen, bezel, margin for shadow/buttons
  return { Ws, Hs, b, m, W: Ws + 2 * b + 2 * m, H: Hs + 2 * b + 2 * m, sx: m + b, sy: m + b, r: Ws * 0.15 };
})();

// Phone geometry for drawDevice, for a phone image drawn at (x, y) and scale s.
export const phoneAt = (x, y, s) => ({ x: x + PHONE.sx * s, y: y + PHONE.sy * s, Ws: PHONE.Ws * s, Hs: PHONE.Hs * s, b: PHONE.b * s, r: PHONE.r * s });

// Draw a video frame into a phone image's screen: cover-cropped, rounded corners. src rect = (cx, cy, cw, ch).
export function drawInPhone(ctx, src, cx, cy, cw, ch, d, flip) {
  const k = Math.max(d.Ws / cw, d.Hs / ch), vw = d.Ws / k, vh = d.Hs / k;
  ctx.save();
  ctx.beginPath(); rrect(ctx, d.x, d.y, d.Ws, d.Hs, d.r); ctx.clip();
  if (flip) { ctx.translate(2 * d.x + d.Ws, 0); ctx.scale(-1, 1); }
  ctx.drawImage(src, cx + (cw - vw) / 2, cy + (ch - vh) / 2, vw, vh, d.x, d.y, d.Ws, d.Hs);
  ctx.restore();
}

// The phone image (transparent screen) as PNG, for the export.
export async function phonePng(kind) {
  const c = document.createElement("canvas");
  c.width = PHONE.W; c.height = PHONE.H;
  drawDevice(c.getContext("2d"), phoneAt(0, 0, 1), kind);
  return await new Promise((res) => c.toBlob(res, "image/png"));
}

// Background behind the phone (preview). `screen` is the frame drawn for the screen, for "blur".
export function drawDeviceBackground(ctx, p, d, screen, small) {
  const f = p.frame, { W, H } = d;
  if (f.bg === "color") { ctx.fillStyle = f.color || "#1c1917"; ctx.fillRect(0, 0, W, H); return; }
  if (f.bg === "gradient") {
    const [c0, c1] = GRADIENTS[f.gradient || 0] || GRADIENTS[0];
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    return;
  }
  // blur: the screen's picture, covering the canvas, blurred and darkened (like the export)
  const sc = small.getContext("2d"), k = Math.max(W / screen.width, H / screen.height);
  const cw = W / k, ch = H / k;
  sc.drawImage(screen, (screen.width - cw) / 2, (screen.height - ch) / 2, cw, ch, 0, 0, small.width, small.height);
  ctx.save();
  // ~ the export's boxblur 12x2 at quarter size (sigma ~40 px at 1920), in canvas pixels
  ctx.filter = `blur(${Math.max(2, (40 * ctx.canvas.width) / 1920).toFixed(1)}px)`;
  ctx.drawImage(small, -W * 0.05, -H * 0.05, W * 1.1, H * 1.1); // overscan: no dark edges from the blur
  ctx.filter = "none";
  ctx.fillStyle = "rgba(0,0,0,0.14)"; ctx.fillRect(0, 0, W, H);
  ctx.restore();
}
