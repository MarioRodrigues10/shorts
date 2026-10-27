// "Clean surface": remove lint, dust and crumbs from a box drawn over a desk or mat.
// Brightness only (colour is kept): on a dark surface, light specks are pulled down to the
// surface level (min filter, median, highlights compressed toward the surface); on a light
// surface it's the mirror image. Edges fade over a few pixels. Mirrors clean_filter() in server.py.

// strength -> [min/max passes (3x3 each), median radius], in output pixels at 1080p
export const CLEAN_STRENGTH = { 1: [1, 2], 2: [2, 3], 3: [3, 5] };
const FEATHER = 0.04; // edge fade, as a fraction of the box's short side (export uses the same)

const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// Typical brightness (0-255) of a box on the current frame, read when the box is drawn.
export function surfaceLevel(ctx, x, y, w, h) {
  const d = ctx.getImageData(x, y, Math.max(1, w), Math.max(1, h)).data;
  const v = [];
  for (let i = 0; i < d.length; i += 16) v.push(luma(d, i)); // every 4th pixel is plenty
  v.sort((a, b) => a - b);
  return Math.round(v[v.length >> 1] ?? 0);
}

function minmax3(src, w, h, takeMin) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = takeMin ? 255 : 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const v = src[yy * w + Math.min(w - 1, Math.max(0, x + dx))];
          m = takeMin ? Math.min(m, v) : Math.max(m, v);
        }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

function median(src, w, h, r) {
  const out = new Float32Array(src.length), win = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      win.length = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) win.push(src[yy * w + Math.min(w - 1, Math.max(0, x + dx))]);
      }
      win.sort((a, b) => a - b);
      out[y * w + x] = win[win.length >> 1];
    }
  }
  return out;
}

// Clean one box of the canvas in place. box = {x, y, w, h} in canvas pixels; scale = canvas px per
// output px (radii shrink with the preview); level = surfaceLevel at draw time.
export function cleanBox(ctx, box, strength, level, scale) {
  const x = Math.round(box.x), y = Math.round(box.y), w = Math.round(box.w), h = Math.round(box.h);
  if (w < 4 || h < 4) return;
  const img = ctx.getImageData(x, y, w, h), d = img.data;
  const Y = new Float32Array(w * h);
  for (let i = 0, p = 0; p < Y.length; i += 4, p++) Y[p] = luma(d, i);
  const [passes, rad] = CLEAN_STRENGTH[strength] || CLEAN_STRENGTH[2];
  const dark = level < 128, k = Math.max(scale, 0.25);
  let v = Y;
  for (let i = 0; i < Math.max(1, Math.round(passes * k)); i++) v = minmax3(v, w, h, dark);
  v = median(v, w, h, Math.max(1, Math.round(rad * k)));
  const L = dark ? level + 4 : level - 4;
  const f = Math.max(1, Math.min(w, h) * FEATHER);
  for (let yy = 0, p = 0, i = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++, p++, i += 4) {
      let t = v[p];
      if (dark ? t > L : t < L) t = L + (t - L) * 0.35;
      const a = Math.min(1, Math.min(xx, w - 1 - xx, yy, h - 1 - yy) / f);
      const delta = (t - Y[p]) * a;
      d[i] += delta; d[i + 1] += delta; d[i + 2] += delta; // brightness only: colour is kept
    }
  }
  ctx.putImageData(img, x, y);
}
