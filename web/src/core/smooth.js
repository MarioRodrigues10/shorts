// Smooth cuts: the clip after a cut starts lined up with the face in the frame before it, then
// glides back to its own framing. The server measures each cut (/api/smooth); the result is
// stored on the clip with a key of everything it depends on, so any change re-measures it.
import { api } from "./util.js";
import { S, changed } from "./store.js";
import * as M from "./model.js";
import { mainSize } from "./device.js";

const FRAMING = ["mid", "in", "out", "speed", "fit", "zoom", "zoomEnd", "x", "y", "crop", "flip", "kf", "effect"];
const pick = (c) => FRAMING.map((k) => c[k] ?? null);
export const smoothKey = (p, prev, c) => { const s = mainSize(p); return JSON.stringify([2, pick(prev), pick(c), s.w, s.h, p.canvas.bg]); };

// "Fill frame" clips that never go below 100% are framed by a crop, and a smooth cut moves that
// crop window. Mirrors uses_crop_path() in server.py.
export function usesCropPath(c) {
  if ((c.fit || "fill") !== "fill") return false;
  const zs = [c.zoom ?? 1, ...(c.zoomEnd != null ? [c.zoomEnd] : []), ...((c.kf?.zoom || []).map((k) => k.v))];
  return Math.min(...zs) >= 1 - 1e-6;
}

const isSmooth = (c) => c.trans?.type === "smooth";

// The measured transform if it is still valid for this cut (else null: plays as a plain cut).
export function smoothParams(p, clips, i) {
  const c = clips[i], prev = clips[i - 1];
  if (!prev || !isSmooth(c) || (c.gap || 0) > 1e-6) return null;
  const al = c.trans.align;
  return al && !al.error && al.key === smoothKey(p, prev, c) ? { k: al.k, tx: al.tx, ty: al.ty, dur: c.trans.dur ?? 0.5 } : null;
}

// Transform at local time lt into the clip: {k, tx, ty} in canvas units, or null.
// Mirrors smooth_filter() in server.py.
export function smoothAt(sm, lt, W, H) {
  if (!sm || lt >= sm.dur) return null;
  const x = Math.min(Math.max(lt / Math.max(sm.dur, 0.04), 0), 1);
  const lam = 1 - x * x * (3 - 2 * x);
  return { k: 1 + (sm.k - 1) * lam, tx: sm.tx * W * lam, ty: sm.ty * H * lam };
}

// Measure every smooth cut whose measurement is missing or out of date (one at a time).
let running = null;
export function alignSmoothCuts() {
  if (running) return running;
  running = (async () => {
    try {
      for (;;) {
        const p = S.p;
        if (!p) return;
        const clips = M.mainTrack(p).clips;
        const i = clips.findIndex((c, j) => j > 0 && isSmooth(c) && !(c.gap > 1e-6) && c.trans.align?.key !== smoothKey(p, clips[j - 1], c));
        if (i < 0) return;
        const c = clips[i], prev = clips[i - 1], key = smoothKey(p, prev, c);
        let r;
        try {
          const s = mainSize(p);
          r = await api("/api/smooth", { W: s.w, H: s.h, bg: p.canvas.bg || "blur", fps: p.canvas.fps || 30, a: prev, b: c });
        } catch (e) { r = { error: e.message }; }
        if (S.p !== p) return;
        if (c.trans?.type !== "smooth") continue;
        c.trans.align = { ...r, key }; // a measurement, not an edit: no undo step
        changed({ noTimeline: true });
      }
    } finally { running = null; }
  })();
  return running;
}
