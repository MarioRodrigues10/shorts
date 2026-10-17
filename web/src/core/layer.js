// The "layer": everything drawn by canvas on top of the video — text clips,
// auto captions and flash/fade intro effects. Used by the live preview AND by
// the export (as a PNG sequence), so the export matches the preview exactly.

import { kfValue } from "./kf.js";
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const q2 = (x) => Math.round(clamp(x, 0, 1) * 100) / 100;

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
export const CAPTION_PRESETS = {
  "bold-pop": {
    label: "Bold Pop", font: "Montserrat", weight: 900, size: 84, uppercase: true, stripPunct: true,
    color: "#ffffff", activeColor: "#ffe500", futureColor: "", emphColor: "#4ade80",
    highlight: "color", boxColor: "#ffe500", stroke: 11, strokeColor: "#000000",
    shadow: 18, shadowColor: "rgba(0,0,0,0.55)", mode: "group", maxWords: 3, maxChars: 16,
    posY: 0.64, maxWidth: 0.84, lineHeight: 1.12, enter: "pop", activeScale: 1.12,
  },
  "box": {
    label: "Box Highlight", font: "Poppins", weight: 900, size: 76, uppercase: true, stripPunct: true,
    color: "#ffffff", activeColor: "#ffffff", futureColor: "", emphColor: "#ffe500",
    highlight: "box", boxColor: "#7c3aed", stroke: 6, strokeColor: "#000000",
    shadow: 14, shadowColor: "rgba(0,0,0,0.5)", mode: "group", maxWords: 3, maxChars: 16,
    posY: 0.64, maxWidth: 0.84, lineHeight: 1.2, enter: "pop", activeScale: 1.06,
  },
  "one-word": {
    label: "One Word", font: "Anton", weight: 400, size: 150, uppercase: true, stripPunct: true,
    color: "#ffffff", activeColor: "#ffffff", futureColor: "", emphColor: "#ffe500",
    highlight: "none", boxColor: "#ffe500", stroke: 13, strokeColor: "#000000",
    shadow: 24, shadowColor: "rgba(0,0,0,0.6)", mode: "single", maxWords: 1, maxChars: 12,
    posY: 0.6, maxWidth: 0.9, lineHeight: 1.0, enter: "pop", activeScale: 1.0,
  },
  "karaoke": {
    label: "Karaoke", font: "Montserrat", weight: 800, size: 70, uppercase: false, stripPunct: false,
    color: "#ffffff", activeColor: "#4ade80", futureColor: "rgba(255,255,255,0.55)", emphColor: "#4ade80",
    highlight: "color", boxColor: "#4ade80", stroke: 8, strokeColor: "#000000",
    shadow: 16, shadowColor: "rgba(0,0,0,0.6)", mode: "group", maxWords: 5, maxChars: 26,
    posY: 0.66, maxWidth: 0.86, lineHeight: 1.15, enter: "fade", activeScale: 1.0,
  },
  "comic": {
    label: "Comic", font: "Bangers", weight: 400, size: 116, uppercase: true, stripPunct: true,
    color: "#ffe500", activeColor: "#ffffff", futureColor: "", emphColor: "#ff4d4d",
    highlight: "color", boxColor: "#ff4d4d", stroke: 12, strokeColor: "#000000",
    shadow: 0, shadowColor: "rgba(0,0,0,0.6)", mode: "group", maxWords: 2, maxChars: 14,
    posY: 0.62, maxWidth: 0.86, lineHeight: 1.0, enter: "pop", activeScale: 1.15,
  },
  "clean": {
    label: "Clean", font: "Inter", weight: 800, size: 62, uppercase: false, stripPunct: false,
    color: "#ffffff", activeColor: "#ffffff", futureColor: "", emphColor: "#fde047",
    highlight: "none", boxColor: "#000000", stroke: 0, strokeColor: "#000000",
    shadow: 22, shadowColor: "rgba(0,0,0,0.8)", mode: "group", maxWords: 6, maxChars: 30,
    posY: 0.7, maxWidth: 0.84, lineHeight: 1.2, enter: "slide", activeScale: 1.0,
  },
  "beast": {
    label: "Beast", font: "Archivo Black", weight: 400, size: 92, uppercase: true, stripPunct: true,
    color: "#ffffff", activeColor: "#22c55e", futureColor: "", emphColor: "#ffe500",
    highlight: "color", boxColor: "#22c55e", stroke: 12, strokeColor: "#000000",
    shadow: 0, shadowColor: "rgba(0,0,0,0.6)", mode: "reveal", maxWords: 3, maxChars: 16,
    posY: 0.62, maxWidth: 0.86, lineHeight: 1.08, enter: "pop", activeScale: 1.1,
  },
};

export const TEXT_PRESETS = {
  "classic": { label: "Classic", font: "Montserrat", weight: 900, size: 78, color: "#ffffff", bg: "", stroke: 9, strokeColor: "#000000", shadow: 12, uppercase: false },
  "title-box": { label: "Title box", font: "Montserrat", weight: 900, size: 64, color: "#000000", bg: "#ffffff", stroke: 0, strokeColor: "#000000", shadow: 0, uppercase: false },
  "dark-box": { label: "Dark box", font: "Inter", weight: 800, size: 56, color: "#ffffff", bg: "rgba(0,0,0,0.75)", stroke: 0, strokeColor: "#000000", shadow: 0, uppercase: false },
  "yellow": { label: "Marker", font: "Poppins", weight: 900, size: 70, color: "#000000", bg: "#ffe500", stroke: 0, strokeColor: "#000000", shadow: 0, uppercase: true },
  "red-alert": { label: "Alert", font: "Anton", weight: 400, size: 110, color: "#ffffff", bg: "#ef4444", stroke: 0, strokeColor: "#000000", shadow: 0, uppercase: true },
  "impact": { label: "Impact", font: "Anton", weight: 400, size: 140, color: "#ffe500", bg: "", stroke: 12, strokeColor: "#000000", shadow: 20, uppercase: true },
  "comic": { label: "Comic", font: "Bangers", weight: 400, size: 120, color: "#ffffff", bg: "", stroke: 12, strokeColor: "#000000", shadow: 0, uppercase: true },
  "minimal": { label: "Minimal", font: "Inter", weight: 600, size: 52, color: "#ffffff", bg: "", stroke: 0, strokeColor: "#000000", shadow: 26, uppercase: false },
  "neon": { label: "Neon", font: "Bebas Neue", weight: 400, size: 120, color: "#5ef0ff", bg: "", stroke: 0, strokeColor: "#000000", shadow: 40, shadowColor: "#00d0ff", uppercase: true },
  "green": { label: "Money", font: "Archivo Black", weight: 400, size: 96, color: "#22c55e", bg: "", stroke: 10, strokeColor: "#000000", shadow: 0, uppercase: true },
};

export function defaultCaptions() {
  return Object.assign({ enabled: true, preset: "bold-pop" }, CAPTION_PRESETS["bold-pop"]);
}

// ---------------------------------------------------------------------------
// Caption groups
// ---------------------------------------------------------------------------
export function displayText(w, style) {
  let t = w.text;
  if (style.stripPunct) t = t.replace(/[.,;:"“”]+/g, "").replace(/^[-–—]+|[-–—]+$/g, "");
  if (style.uppercase) t = t.toUpperCase();
  return t;
}

// words: [{text, os, oe, emph, emoji, br, key}] in output time
export function buildGroups(words, style) {
  const groups = [];
  let cur = [];
  const flush = () => { if (cur.length) groups.push({ words: cur }); cur = []; };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + displayText(x, style).length + 1, 0) + displayText(w, style).length;
    if (cur.length && (cur.length >= style.maxWords || chars > style.maxChars || w.br ||
        (prev && w.os - prev.oe > 0.6) || style.mode === "single")) flush();
    cur.push(w);
    if (/[.?!]["')]*$/.test(w.text)) flush();
  }
  flush();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    g.start = g.words[0].os;
    const lastEnd = g.words[g.words.length - 1].oe;
    const next = groups[i + 1];
    g.end = next && next.words[0].os - lastEnd < 0.5 ? next.words[0].os : lastEnd + 0.12;
    if (next) g.end = Math.min(g.end, next.words[0].os);
  }
  return groups;
}

function findGroup(groups, t) {
  let lo = 0, hi = groups.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, g = groups[mid];
    if (t < g.start) hi = mid - 1;
    else if (t >= g.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

const ENTER_DUR = { pop: 0.18, fade: 0.15, slide: 0.2, none: 0 };

function captionState(groups, cap, t) {
  const st = { g: -1, a: -1, n: 0, ge: 1, ae: 1, em: -1, ee: 1 };
  if (!cap || !cap.enabled) return st;
  const gi = findGroup(groups, t);
  if (gi < 0) return st;
  const g = groups[gi];
  st.g = gi;
  const ed = ENTER_DUR[cap.enter] || 0;
  st.ge = ed ? q2((t - g.start) / ed) : 1;
  let a = -1;
  for (let i = 0; i < g.words.length; i++) if (g.words[i].os <= t) a = i;
  if (a >= 0 && t > g.words[a].oe + 0.25 && a === g.words.length - 1 && cap.mode !== "single") a = -1;
  st.a = a;
  st.n = cap.mode === "reveal" ? Math.max(1, a + 1) : cap.mode === "single" ? 1 : g.words.length;
  if (a >= 0 && cap.activeScale > 1) st.ae = q2((t - g.words[a].os) / 0.12);
  for (let i = 0; i < g.words.length; i++) {
    if (g.words[i].emoji && g.words[i].os <= t) { st.em = i; st.ee = q2((t - g.words[i].os) / 0.22); break; }
  }
  return st;
}

// ---------------------------------------------------------------------------
// Layer state (everything time-dependent; draw is a pure function of it)
// ---------------------------------------------------------------------------
// L = { W, H, groups, cap, texts: [text clips], fx: [{t, kind}] }
export function layerState(L, t) {
  const st = { cap: captionState(L.groups, L.cap, t), tx: [], fx: [] };
  for (const c of L.texts) {
    if (t < c.start || t >= c.start + c.dur) continue;
    const lt = t - c.start;
    const ind = { pop: 0.25, fade: 0.25, slide: 0.3, typewriter: Math.min(1.2, c.dur * 0.5), none: 0 }[c.anim || "pop"] || 0;
    const outd = c.animOut && c.animOut !== "none" ? 0.2 : 0;
    const r = (v, k) => Math.round(v * k) / k;
    // keyframed transform (quantised so identical frames still dedupe on export)
    st.tx.push([c.id, ind ? q2(lt / ind) : 1, outd ? q2((c.dur - lt) / outd) : 1,
      r(kfValue(c, "x", lt, c.x ?? 0.5), 4000), r(kfValue(c, "y", lt, c.y ?? 0.3), 4000),
      r(kfValue(c, "scale", lt, c.scale ?? 1), 400), r(kfValue(c, "opacity", lt, c.opacity ?? 1), 100),
      r(kfValue(c, "rotate", lt, c.rotate || 0), 4)]);
  }
  for (const f of L.fx) {
    const d = f.kind === "flash" ? 0.28 : 0.35;
    if (t >= f.t && t < f.t + d) st.fx.push([f.kind, q2((t - f.t) / d)]);
  }
  return st;
}

export const layerKey = (s) => JSON.stringify(s);

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function fontStr(style, size) {
  return `${style.weight} ${size}px "${style.font}", "Noto Color Emoji", sans-serif`;
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const layoutCache = new Map();
export function clearLayoutCache() { layoutCache.clear(); }

function layoutGroup(ctx, g, style, W) {
  const key = [style.font, style.weight, style.size, style.uppercase, style.stripPunct, style.maxWidth,
    style.lineHeight, style.highlight, style.activeScale, W, ...g.words.map((w) => w.text)].join("|");
  const hit = layoutCache.get(key);
  if (hit) return hit;
  ctx.font = fontStr(style, style.size);
  let space = Math.max(ctx.measureText(" ").width, style.size * 0.26);
  if (style.highlight === "box") space = Math.max(space, style.size * 0.44);
  // Leave room for the active word to pop without overlapping its neighbours.
  const pop = Math.max(0, (style.activeScale || 1) - 1) / 2;
  const gap = (a, b) => space + pop * Math.max(a.w, b.w);
  const maxW = W * style.maxWidth;
  const lines = [];
  let line = { items: [], w: 0 };
  for (let i = 0; i < g.words.length; i++) {
    const text = displayText(g.words[i], style);
    const it = { i, text, w: ctx.measureText(text).width };
    const prev = line.items[line.items.length - 1];
    if (prev && line.w + gap(prev, it) + it.w > maxW) { lines.push(line); line = { items: [], w: 0 }; }
    const p = line.items[line.items.length - 1];
    line.w += (p ? gap(p, it) : 0) + it.w;
    line.items.push(it);
  }
  if (line.items.length) lines.push(line);
  const lh = style.size * style.lineHeight;
  lines.forEach((ln, li) => {
    let x = -ln.w / 2;
    ln.items.forEach((it, k) => {
      if (k) x += gap(ln.items[k - 1], it);
      it.x = x; it.y = li * lh - (lines.length - 1) * lh / 2;
      x += it.w;
    });
  });
  const res = { lines, height: lines.length * lh, width: Math.max(...lines.map((l) => l.w)) };
  if (layoutCache.size > 4000) layoutCache.clear();
  layoutCache.set(key, res);
  return res;
}

// Returns the caption bounding box (canvas units) or null.
export function drawCaptions(ctx, L, st, scale) {
  const style = L.cap;
  if (!style || st.g < 0) return null;
  const { W, H } = L;
  const g = L.groups[st.g];
  const lay = layoutGroup(ctx, g, style, W);
  const cx = W / 2, cy = H * style.posY;
  ctx.save();
  ctx.translate(cx, cy);
  const p = st.ge;
  if (style.enter === "pop") { const s = 0.72 + 0.28 * easeOutBack(p); ctx.scale(s, s); }
  else if (style.enter === "fade") ctx.globalAlpha = easeOutCubic(p);
  else if (style.enter === "slide") { ctx.globalAlpha = easeOutCubic(p); ctx.translate(0, 40 * (1 - easeOutCubic(p))); }
  ctx.font = fontStr(style, style.size);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  const items = [];
  for (const ln of lay.lines) for (const it of ln.items) items.push(it);
  const single = style.mode === "single";
  const vis = items.filter((it) => single ? it.i === Math.max(st.a, 0) : it.i < st.n);
  const offX = (it) => single ? -it.w / 2 - it.x : 0;
  const offY = (it) => single ? -it.y : 0;
  const wordScale = (it) => it.i === st.a && style.activeScale > 1 ? 1 + (style.activeScale - 1) * easeOutBack(st.ae) : 1;
  const withWord = (it, fn) => {
    const s = wordScale(it);
    const x = it.x + offX(it), y = it.y + offY(it);
    ctx.save();
    if (s !== 1) { ctx.translate(x + it.w / 2, y); ctx.scale(s, s); ctx.translate(-(x + it.w / 2), -y); }
    fn(x, y);
    ctx.restore();
  };
  if (style.highlight === "box" && st.a >= 0) {
    for (const it of vis) if (it.i === st.a) withWord(it, (x, y) => {
      const padX = style.size * 0.18, padY = style.size * 0.1;
      ctx.fillStyle = style.boxColor;
      roundRect(ctx, x - padX, y - style.size * 0.55 - padY, it.w + padX * 2, style.size * 1.1 + padY * 2, style.size * 0.22);
      ctx.fill();
    });
  }
  if (style.stroke > 0 || style.shadow > 0) {
    for (const it of vis) withWord(it, (x, y) => {
      ctx.shadowColor = style.shadowColor || "rgba(0,0,0,.6)";
      ctx.shadowBlur = style.shadow * scale;
      ctx.shadowOffsetY = style.shadow * 0.25 * scale;
      if (style.stroke > 0) {
        ctx.strokeStyle = style.strokeColor;
        ctx.lineWidth = style.stroke * 2;
        ctx.strokeText(it.text, x, y);
      } else {
        ctx.fillStyle = style.shadowColor || "rgba(0,0,0,.6)";
        ctx.fillText(it.text, x, y);
      }
    });
  }
  ctx.shadowColor = "transparent";
  for (const it of vis) withWord(it, (x, y) => {
    const w = g.words[it.i];
    let c = style.color;
    if (style.futureColor && st.a >= 0 && it.i > st.a) c = style.futureColor;
    if (w.emph) c = style.emphColor;
    if (it.i === st.a && style.highlight !== "none") c = style.activeColor;
    ctx.fillStyle = c;
    ctx.fillText(it.text, x, y);
  });
  if (st.em >= 0) {
    const e = g.words[st.em].emoji;
    const size = style.size * 1.35;
    ctx.font = `${size}px "Noto Color Emoji"`;
    ctx.textAlign = "center";
    const top = single ? -style.size * 0.5 : -lay.height / 2;
    const s = 0.3 + 0.7 * easeOutBack(st.ee);
    ctx.save();
    ctx.translate(0, top - size * 0.7);
    ctx.scale(s, s);
    ctx.fillText(e, 0, 0);
    ctx.restore();
  }
  ctx.restore();
  const bw = single ? style.size * 3 : lay.width;
  return { x: cx - bw / 2 - 20, y: cy - lay.height / 2 - 20, w: bw + 40, h: lay.height + 40 };
}

function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const t = line ? line + " " + word : word;
      if (line && ctx.measureText(t).width > maxW) { lines.push(line); line = word; } else line = t;
    }
    lines.push(line);
  }
  return lines;
}

// Text clip. Returns its bounding box (canvas units).
export function drawText(ctx, L, c, pin, pout, scale, v) {
  v = v || { x: c.x ?? 0.5, y: c.y ?? 0.3, sc: 1, op: c.opacity ?? 1, rot: c.rotate || 0 };
  if (c.shape) return drawShape(ctx, L, c, pin, pout, v);
  const { W, H } = L;
  const s = c.style;
  let text = s.uppercase ? c.text.toUpperCase() : c.text;
  if (c.anim === "typewriter" && pin < 1) text = text.slice(0, Math.ceil(text.length * pin));
  ctx.save();
  ctx.font = fontStr(s, s.size);
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  const full = s.uppercase ? c.text.toUpperCase() : c.text;
  const lines = wrapText(ctx, full, W * (s.maxWidth || 0.86));
  const shown = c.anim === "typewriter" ? wrapText(ctx, text, W * (s.maxWidth || 0.86)) : lines;
  const lh = s.size * (s.lineHeight || 1.25);
  const widths = lines.map((l) => ctx.measureText(l).width);
  const bw = Math.max(...widths, 10), bh = lines.length * lh;
  const cx = v.x * W, cy = v.y * H;
  ctx.translate(cx, cy);
  if (v.rot) ctx.rotate(v.rot * Math.PI / 180);
  let alpha = 1, sc = v.sc, dy = 0;
  if (c.anim === "pop") sc *= 0.7 + 0.3 * easeOutBack(pin);
  if (c.anim === "fade") alpha *= easeOutCubic(pin);
  if (c.anim === "slide") { alpha *= easeOutCubic(pin); dy = 60 * (1 - easeOutCubic(pin)); }
  if (c.animOut === "fade") alpha *= easeOutCubic(pout);
  if (c.animOut === "pop") { alpha *= easeOutCubic(pout); sc *= 0.8 + 0.2 * pout; }
  ctx.globalAlpha = clamp(alpha * v.op, 0, 1);
  ctx.translate(0, dy);
  ctx.scale(sc, sc);
  shown.forEach((ln, i) => {
    const y = i * lh - (lines.length - 1) * lh / 2;
    const w = ctx.measureText(ln).width;
    if (s.bg) {
      ctx.fillStyle = s.bg;
      const pad = s.size * 0.32;
      roundRect(ctx, -w / 2 - pad, y - lh / 2 + 2, w + pad * 2, lh - 4, s.size * 0.25);
      ctx.fill();
    }
    if (s.stroke > 0 || s.shadow > 0) {
      ctx.shadowColor = s.shadowColor || "rgba(0,0,0,0.6)";
      ctx.shadowBlur = (s.shadow || 0) * scale;
      ctx.shadowOffsetY = (s.shadow || 0) * 0.2 * scale;
      if (s.stroke > 0) { ctx.strokeStyle = s.strokeColor; ctx.lineWidth = s.stroke * 2; ctx.strokeText(ln, 0, y); }
      else { ctx.fillStyle = s.color; ctx.fillText(ln, 0, y); }
      ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = s.color;
    ctx.fillText(ln, 0, y);
  });
  ctx.restore();
  const pad = s.bg ? s.size * 0.32 : 10;
  const k = v.sc;
  return { x: cx - (bw / 2 + pad) * k, y: cy - (bh / 2 + 6) * k, w: (bw + pad * 2) * k, h: (bh + 12) * k };
}

// Shapes & arrows (text-track elements). Size in canvas widths (c.w, c.h).
function drawShape(ctx, L, c, pin, pout, v) {
  const { W, H } = L;
  const s = c.style || {};
  const w = (c.w || 0.4) * W, h = (c.h || 0.2) * W;
  const cx = v.x * W, cy = v.y * H;
  ctx.save();
  ctx.translate(cx, cy);
  if (v.rot) ctx.rotate(v.rot * Math.PI / 180);
  let sc = v.sc, alpha = v.op;
  if (c.anim === "pop") sc *= 0.7 + 0.3 * easeOutBack(pin);
  if (c.anim === "fade" || c.anim === "slide") alpha *= easeOutCubic(pin);
  if (c.animOut === "fade" || c.animOut === "pop") alpha *= easeOutCubic(pout);
  ctx.scale(sc, sc);
  ctx.globalAlpha = clamp(alpha, 0, 1);
  const lw = s.stroke ?? 12;
  ctx.lineWidth = lw; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = s.color || "#ff3b30";
  ctx.fillStyle = s.fill || "transparent";
  if (s.shadow) { ctx.shadowColor = "rgba(0,0,0,.5)"; ctx.shadowBlur = s.shadow; }
  if (c.shape === "rect") {
    roundRect(ctx, -w / 2, -h / 2, w, h, s.radius ?? 24);
    if (s.fill) ctx.fill();
    if (lw > 0) ctx.stroke();
  } else if (c.shape === "circle") {
    ctx.beginPath(); ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    if (s.fill) ctx.fill();
    if (lw > 0) ctx.stroke();
  } else if (c.shape === "arrow") {
    const hw = Math.max(lw * 2.6, 40);
    ctx.beginPath(); ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2 - hw * 0.6, 0); ctx.stroke();
    ctx.fillStyle = s.color || "#ff3b30";
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2 - hw, -hw * 0.7); ctx.lineTo(w / 2 - hw, hw * 0.7); ctx.closePath(); ctx.fill();
  } else if (c.shape === "underline") {
    ctx.beginPath(); ctx.moveTo(-w / 2, 0); ctx.quadraticCurveTo(0, h * 0.25, w / 2, -h * 0.05); ctx.stroke();
  }
  ctx.restore();
  const k = v.sc, ext = Math.max(w, c.shape === "arrow" ? w : 0) / 2 + lw;
  return { x: cx - ext * k, y: cy - (h / 2 + lw) * k, w: 2 * ext * k, h: (h + 2 * lw) * k };
}

// Draws the whole layer. Returns bounding boxes by id ("captions" for captions).
export function drawLayer(ctx, L, st, scale) {
  const boxes = {};
  for (const [kind, p] of st.fx) {
    ctx.save();
    if (kind === "flash") { ctx.fillStyle = `rgba(255,255,255,${(0.9 * (1 - p)).toFixed(3)})`; }
    else { ctx.fillStyle = `rgba(0,0,0,${(1 - easeOutCubic(p)).toFixed(3)})`; }
    ctx.fillRect(0, 0, L.W, L.H);
    ctx.restore();
  }
  const byId = new Map(L.texts.map((c) => [c.id, c]));
  for (const [id, pin, pout, x, y, sc, op, rot] of st.tx) {
    const c = byId.get(id);
    if (c) boxes[id] = drawText(ctx, L, c, pin, pout, scale, { x, y, sc, op, rot });
  }
  const cb = drawCaptions(ctx, L, st.cap, scale);
  if (cb) boxes.captions = cb;
  return boxes;
}

export function drawGuides(ctx, W, H) {
  if (H <= W) return;
  const k = W / 1080;
  ctx.save();
  ctx.fillStyle = "rgba(255,45,85,0.07)";
  ctx.fillRect(0, H - 420 * k, W, 420 * k);
  ctx.fillRect(W - 150 * k, 700 * k, 150 * k, H - 1120 * k);
  ctx.fillRect(0, 0, W, 160 * k);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.setLineDash([16, 14]);
  ctx.lineWidth = 3;
  ctx.strokeRect(60 * k, 160 * k, W - 210 * k, H - 580 * k);
  ctx.restore();
}

export function toSrt(groups) {
  const f = (t) => {
    const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60,
      s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
  };
  return groups.map((g, i) => `${i + 1}\n${f(g.start)} --> ${f(g.end)}\n${g.words.map((w) => w.text).join(" ")}\n`).join("\n");
}
