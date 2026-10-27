// "Clean surface": remove lint, dust and dust haze from a box drawn over a desk or mat.
// Only pixels that look like the surface (neutral colour, near its brightness, away from objects'
// edges) are touched, and only their brightness:
//   lint/dust  min filter (max on light surfaces) + median
//   dust haze  mid-size variation flattened toward the large-scale lighting
//   texture    a fine, clamped grain from the original is put back, so fabric still looks real
// Box edges fade in. Mirrors clean_filter() in server.py (radii are in output pixels at 1080p).

// strength -> [min/max passes, median radius, haze kept, grain kept]
export const CLEAN_STRENGTH = { 1: [1, 2, 0.6, 0.8], 2: [2, 3, 0.35, 0.6], 3: [3, 4, 0.15, 0.4] };
const FEATHER = 0.04;

const lumaOf = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// Typical brightness (0-255) of a box on the current frame, read when the box is drawn.
export function surfaceLevel(ctx, x, y, w, h) {
  const d = ctx.getImageData(x, y, Math.max(1, w), Math.max(1, h)).data;
  const v = [];
  for (let i = 0; i < d.length; i += 16) v.push(lumaOf(d, i));
  v.sort((a, b) => a - b);
  return Math.round(v[v.length >> 1] ?? 0);
}

// Separable 3x3 min/max (horizontal then vertical pass), edges clamped.
function minmax3(src, w, h, takeMin) {
  const f = takeMin ? Math.min : Math.max, tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0, o = 0; y < h; y++, o += w) {
    for (let x = 0; x < w; x++) tmp[o + x] = f(src[o + Math.max(0, x - 1)], src[o + x], src[o + Math.min(w - 1, x + 1)]);
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w, mid = y * w, dn = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) out[mid + x] = f(tmp[up + x], tmp[mid + x], tmp[dn + x]);
  }
  return out;
}

// Median approximated as a row median then a column median (cheap; at these small radii it
// looks the same as the export's full 2-D median).
function median(src, w, h, r) {
  const n = 2 * r + 1, win = new Float32Array(n), tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const med = () => { win.sort(); return win[r]; };
  for (let y = 0, o = 0; y < h; y++, o += w) {
    for (let x = 0; x < w; x++) { for (let j = 0; j < n; j++) win[j] = src[o + Math.min(w - 1, Math.max(0, x + j - r))]; tmp[o + x] = med(); }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { for (let j = 0; j < n; j++) win[j] = tmp[Math.min(h - 1, Math.max(0, y + j - r)) * w + x]; out[y * w + x] = med(); }
  }
  return out;
}

// Gaussian blur approximated by three running box blurs (separable, edges clamped).
function blur(src, w, h, sigma) {
  if (sigma < 0.3) return src;
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2)), n = 2 * r + 1;
  let a = src;
  const tmp = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    const out = new Float32Array(src.length);
    for (let y = 0, o = 0; y < h; y++, o += w) {
      let s = a[o] * (r + 1);
      for (let x = 1; x <= r; x++) s += a[o + Math.min(w - 1, x)];
      for (let x = 0; x < w; x++) {
        tmp[o + x] = s / n;
        s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = tmp[x] * (r + 1);
      for (let y = 1; y <= r; y++) s += tmp[Math.min(h - 1, y) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / n;
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    a = out;
  }
  return a;
}

// Clean one box of the canvas in place. box = {x, y, w, h} in canvas pixels; k = canvas px per
// 1080p output px (radii shrink with the preview); level = surfaceLevel when the box was drawn.
export function cleanBox(ctx, box, strength, level, k) {
  const x = Math.round(box.x), y = Math.round(box.y), w = Math.round(box.w), h = Math.round(box.h);
  if (w < 8 || h < 8) return;
  const img = ctx.getImageData(x, y, w, h), d = img.data, n = w * h;
  const Y = new Float32Array(n), sat = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    Y[p] = lumaOf(d, i);
    const cb = -0.1687 * d[i] - 0.3313 * d[i + 1] + 0.5 * d[i + 2], cr = 0.5 * d[i] - 0.4187 * d[i + 1] - 0.0813 * d[i + 2];
    sat[p] = Math.max(Math.abs(cb), Math.abs(cr));
  }
  const [passes, rad, flat, grain] = CLEAN_STRENGTH[strength] || CLEAN_STRENGTH[2];
  const dark = level < 128, s = Math.max(k, 0.2);
  // which pixels are the surface (thresholds are the export's, converted to full range)
  const yb = blur(Y, w, h, 2 * s), sb = blur(sat, w, h, 2 * s);
  let wm = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    wm[p] = Math.min(1, Math.max(0, 1 - (Math.abs(yb[p] - level) - 17.5) / 10.5)) * Math.min(1, Math.max(0, 1 - (sb[p] - 9.1) / 6.8));
  }
  for (let i = 0; i < Math.max(1, Math.round(5 * s)); i++) wm = minmax3(wm, w, h, true);
  wm = blur(wm, w, h, Math.max(0.6, 3 * s));
  // the cleaned surface
  let m = Y;
  for (let i = 0; i < Math.max(1, Math.round(passes * s)); i++) m = minmax3(m, w, h, dark);
  m = median(m, w, h, Math.max(1, Math.round(rad * s)));
  const light = blur(m, w, h, 25 * s), fine = blur(Y, w, h, Math.max(0.5, 1.2 * s));
  const L = dark ? level + 4 : level - 4;
  const f = Math.max(1, Math.min(w, h) * FEATHER);
  for (let yy = 0, p = 0, i = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++, p++, i += 4) {
      let t = light[p] + (m[p] - light[p]) * flat + Math.min(3, Math.max(-3, Y[p] - fine[p])) * grain;
      if (dark ? t > L : t < L) t = L + (t - L) * 0.35;
      const edge = Math.min(1, Math.min(xx, w - 1 - xx, yy, h - 1 - yy) / f);
      const delta = (t - Y[p]) * wm[p] * edge;
      d[i] += delta; d[i + 1] += delta; d[i + 2] += delta; // brightness only: colour is kept
    }
  }
  ctx.putImageData(img, x, y);
}
