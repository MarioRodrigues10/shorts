// Editing commands shared by the toolbar, keyboard shortcuts, menus and panels.
import { toast, snapFrame, uid, api } from "./util.js";
import { S, commit, begin, changed, select, undo, words as tlWords } from "./store.js";
import * as M from "./model.js";
import * as Media from "./media.js";

const now = () => S.player.time();

export function ensureMediaInProject(mid) {
  if (!S.p.media.includes(mid)) S.p.media.push(mid);
}

// Add media at time t. target: "main" | "video" | "audio" | {kind, trackId?, newTrack?} (the row under the drop)
export function addMedia(mid, t = now(), target) {
  const m = Media.meta(mid);
  if (!m) return;
  const tg = typeof target === "string" || !target ? { kind: target || "main" } : target;
  let clip;
  commit(() => {
    ensureMediaInProject(mid);
    if (m.kind === "audio") {
      const tid = tg.kind === "audio" && !tg.newTrack ? tg.trackId : tg.newTrack && tg.kind === "audio" ? M.newTrack(S.p, "audio").id : null;
      clip = M.addOnTrack(S.p, "audio", M.newAudioClip(m, snapFrame(t)), tid);
    } else if (tg.kind === "video" || tg.kind === "text") {
      const tid = tg.newTrack || tg.kind === "text" ? M.newTrack(S.p, "video").id : tg.trackId;
      clip = M.addOnTrack(S.p, "video", M.newOverlayClip(m, snapFrame(t), S.p.canvas), tid);
    } else {
      clip = M.insertMain(S.p, M.newMainClip(m), t);
    }
  });
  select([clip.id]);
  return clip;
}

export function addTrack(kind) {
  let tr;
  commit(() => { tr = M.newTrack(S.p, kind); });
  toast(`Added ${tr.name}`);
  return tr;
}

export function renameTrack(id) {
  const tr = S.p.tracks.find((t) => t.id === id);
  if (!tr) return;
  const n = prompt("Track name", tr.name);
  if (n && n.trim()) commit(() => { tr.name = n.trim(); });
}
export function moveTrack(id, dir) { commit(() => M.moveTrack(S.p, id, dir)); }
export function deleteTrack(id) {
  const tr = S.p.tracks.find((t) => t.id === id);
  if (!tr) return;
  if (tr.clips.length && !confirm(`Delete "${tr.name}" and its ${tr.clips.length} clip${tr.clips.length > 1 ? "s" : ""}?`)) return;
  commit(() => M.deleteTrack(S.p, id));
}

export function addSticker(emoji) {
  let c;
  commit(() => {
    c = M.newTextClip(snapFrame(now()), "minimal", emoji);
    Object.assign(c.style, { size: 220, stroke: 0, shadow: 0, bg: "" });
    c.y = 0.4; c.anim = "pop";
    M.addOnTrack(S.p, "text", c);
  });
  select([c.id]);
}

export function addShape(shape) {
  let c;
  commit(() => {
    c = M.newTextClip(snapFrame(now()), "classic", "");
    c.shape = shape;
    c.style = { color: "#ff3b30", stroke: shape === "arrow" ? 18 : 12, fill: "", radius: 28, shadow: 0 };
    c.w = shape === "circle" ? 0.35 : shape === "arrow" ? 0.35 : 0.5;
    c.h = shape === "circle" ? 0.35 : shape === "arrow" ? 0.12 : 0.22;
    c.y = 0.45; c.anim = "pop";
    M.addOnTrack(S.p, "text", c);
  });
  select([c.id]);
}

export function setTransition(id, type, dur) {
  commit(() => {
    const f = M.find(S.p, id);
    if (!f) return;
    if (type === "none") delete f.clip.trans;
    else f.clip.trans = { type, dur: dur ?? f.clip.trans?.dur ?? 0.5 };
  });
}

export function applyTransitionToAll(type, dur) {
  commit(() => M.mainTrack(S.p).clips.forEach((c, i) => { if (i) { if (type === "none") delete c.trans; else c.trans = { type, dur }; } }));
}

// Freeze frame: hold the current frame for 2 s (inserted at the playhead).
export async function freezeFrame() {
  const t = now();
  const main = M.mainTrack(S.p).clips;
  const c = main.find((x) => x.start <= t && M.endOf(x, "main") > t);
  if (!c || Media.meta(c.mid)?.kind !== "video") { toast("Put the playhead over a video on the main track"); return; }
  const src = c.in + (t - c.start) * (c.speed || 1);
  const m = await api(`/api/media/${c.mid}/still`, { t: src });
  Media.add(m);
  let clip;
  commit(() => {
    ensureMediaInProject(m.id);
    M.splitAt(S.p, t, new Set([c.id]));
    clip = M.newMainClip(m, 2);
    Object.assign(clip, { fit: c.fit, zoom: c.zoom, x: c.x, y: c.y, adj: c.adj, flip: c.flip });
    M.insertMain(S.p, clip, t);
  });
  select([clip.id]);
  toast("Freeze frame added");
}

export function addText(preset = "classic", text, trackId) {
  let c;
  commit(() => { c = M.addOnTrack(S.p, "text", M.newTextClip(snapFrame(now()), preset, text), trackId); });
  select([c.id]);
  return c;
}

export function split() {
  const t = now();
  let created = [];
  commit(() => { created = M.splitAt(S.p, t, new Set([...S.sel].filter((id) => id !== "captions"))); });
  if (!created.length) toast("Nothing to split under the playhead");
}

export function del() {
  const ids = new Set([...S.sel].filter((id) => id !== "captions"));
  if (!ids.size) return;
  commit(() => M.deleteClips(S.p, ids));
  select([]);
}

export function trimTo(side) {
  commit(() => M.trimToPlayhead(S.p, new Set([...S.sel].filter((id) => id !== "captions")), now(), side, Media.meta));
  if (side === "left") S.player.seek(Math.max(0, now()));
}

export function duplicate() {
  let ids = [];
  commit(() => { ids = M.duplicate(S.p, [...S.sel].filter((id) => id !== "captions")); });
  select(ids);
}

let clipboard = null;
export function copy() {
  const items = [...S.sel].map((id) => M.find(S.p, id)).filter(Boolean);
  if (!items.length) return;
  const t0 = Math.min(...items.map((f) => f.clip.start));
  clipboard = items.map((f) => ({ kind: f.track.kind, clip: JSON.parse(JSON.stringify(f.clip)), off: f.clip.start - t0 }));
  toast(`Copied ${items.length} clip${items.length > 1 ? "s" : ""}`);
}
export function paste() {
  if (!clipboard) return;
  const t = now();
  const ids = [];
  commit(() => {
    for (const it of clipboard) {
      const c = JSON.parse(JSON.stringify(it.clip));
      c.id = uid();
      if (it.kind === "main") M.insertMain(S.p, c, t + it.off);
      else { c.start = snapFrame(t + it.off); M.addOnTrack(S.p, it.kind, c); }
      ids.push(c.id);
    }
  });
  select(ids);
}

export async function removeSilences(opt) {
  if (!(await hasWords())) return;
  let r;
  commit(() => { r = M.removeSilences(S.p, Media.getWords, opt); });
  toast(r.cuts ? `Removed ${r.cuts} pauses (${r.removed.toFixed(1)}s)` : "No long pauses found", r.cuts ? { label: "Undo", fn: undo } : null);
}

export async function cutRetakes() {
  if (!(await hasWords())) return;
  const ws = tlWords();
  const ranges = M.findRetakes(ws);
  if (!ranges.length) { toast("No retakes found"); return; }
  const n = ranges.reduce((a, [lo, hi]) => a + hi - lo + 1, 0);
  commit(() => M.cutWordRanges(S.p, ws, ranges));
  toast(`Cut ${ranges.length} retake${ranges.length > 1 ? "s" : ""} (${n} words)`, { label: "Undo", fn: undo });
}

export async function cutFillers() {
  if (!(await hasWords())) return;
  const ws = tlWords();
  const ranges = [];
  ws.forEach((w, i) => { if (M.isFiller(w)) ranges.push([i, i]); });
  if (!ranges.length) { toast("No filler words found"); return; }
  commit(() => M.cutWordRanges(S.p, ws, ranges));
  toast(`Cut ${ranges.length} filler word${ranges.length > 1 ? "s" : ""}`, { label: "Undo", fn: undo });
}

export function autoZoom(amount = 1.15) {
  commit(() => M.autoZoom(S.p, amount));
  toast("Punch-in zoom on alternate clips", { label: "Undo", fn: undo });
}

// Source ranges of each media used on the main track: {mid: [[in, out], ...]}
export function usedRanges() {
  const by = {};
  for (const c of M.mainTrack(S.p).clips) {
    const m = Media.meta(c.mid);
    if (!m || !m.has_audio) continue;
    (by[c.mid] = by[c.mid] || []).push([c.in, c.out]);
  }
  return by;
}

// Seconds of main-track speech not transcribed yet.
export function captionsMissing() {
  let miss = 0;
  for (const [mid, rs] of Object.entries(usedRanges())) miss += Media.uncovered(mid, rs);
  return miss;
}

export function transcribing() {
  return Object.keys(usedRanges()).some((mid) => ["queued", "running"].includes(Media.meta(mid)?.status?.transcript));
}

// CapCut-style "Auto captions": transcribe only what's on the timeline.
export async function autoCaptions(opts = {}) {
  const by = usedRanges();
  if (!Object.keys(by).length) { toast("Add a video with speech to the main track first"); return; }
  let secs = 0;
  for (const [mid, rs] of Object.entries(by)) secs += await Media.transcribe(mid, rs, opts.model, opts.force);
  if (secs > 0) toast(`Transcribing ${Math.round(secs)}s of speech…`);
  else toast("Captions are up to date");
  if (S.p.captions && !S.p.captions.enabled) commit(() => { S.p.captions.enabled = true; }, null, { noTimeline: true });
}

async function hasWords() {
  if (!M.mainTrack(S.p).clips.length) { toast("Add a video to the main track first"); return false; }
  if (transcribing()) { toast("Still transcribing"); return false; }
  if (captionsMissing() > 1) {
    toast("This needs the transcript of the timeline", { label: "Transcribe now", fn: () => autoCaptions() });
    return false;
  }
  await Promise.all(Object.keys(usedRanges()).map(Media.loadWords));
  return true;
}

export function addMarker() {
  commit(() => { S.p.markers.push({ id: uid(), t: snapFrame(now()) }); });
}

export function toggleTrack(id, prop) {
  commit(() => { const t = S.p.tracks.find((x) => x.id === id); if (t) t[prop] = !t[prop]; });
}

// Freeze-frame-less "detach audio": copy the clip's audio to an audio track and mute the clip.
export function detachAudio(id) {
  const f = M.find(S.p, id);
  if (!f || !f.clip.mid) return;
  const m = Media.meta(f.clip.mid);
  if (!m?.has_audio) return;
  commit(() => {
    const a = M.newAudioClip(m, f.clip.start);
    Object.assign(a, { in: f.clip.in, out: f.clip.out, speed: f.clip.speed || 1, volume: f.clip.volume ?? 1, fadeIn: 0, fadeOut: 0, duck: false });
    M.addOnTrack(S.p, "audio", a);
    f.clip.mute = true;
  });
}

export function setSpeed(id, speed) {
  commit(() => { const c = S.p && M.find(S.p, id)?.clip; if (c) c.speed = speed; });
}

export { begin, changed };

// ---------------------------------------------------------------------------
// Smart tools (server jobs)
// ---------------------------------------------------------------------------
export async function pollJob(job, onProgress) {
  for (;;) {
    const j = await api("/api/jobs/" + job);
    if (j.status === "error") throw new Error(j.error);
    onProgress && onProgress(j.progress, j.message);
    if (j.status === "done") return j.result;
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Auto-reframe: follow the face with smooth pan keyframes (camera holds, then glides).
export async function autoReframe(id, onProgress) {
  const f = M.find(S.p, id);
  if (!f) return;
  const c = f.clip, m = Media.meta(c.mid);
  const { job } = await api(`/api/media/${c.mid}/faces`, { start: c.in, end: c.out });
  const res = await pollJob(job, onProgress);
  const smp = res.samples;
  if (smp.length < 2) { toast("No face found in this clip"); return; }
  const { w: W, h: H } = S.p.canvas;
  const sw = m.width, sh = m.height, sp = c.speed || 1;
  const s = Math.max(W / sw, H / sh) * Math.max(c.zoom || 1, 1);
  const cw = W / s, ch = H / s;
  const roomX = sw - cw, roomY = sh - ch;
  const toPx = (fx) => roomX > 1 ? Math.max(-1, Math.min(1, ((fx * sw - cw / 2) / (roomX / 2)) - 1)) : 0;
  const toPy = (fy) => roomY > 1 ? Math.max(-1, Math.min(1, ((fy * sh - ch * 0.42) / (roomY / 2)) - 1)) : 0;
  // median-smooth the samples
  const med = (arr, i, k) => { const w = arr.slice(Math.max(0, i - k), i + k + 1).sort((a, b) => a - b); return w[w.length >> 1]; };
  const xs = smp.map((p) => p.x), ys = smp.map((p) => p.y);
  const pts = smp.map((p, i) => ({ t: (p.t - c.in) / sp, x: toPx(med(xs, i, 3)), y: toPy(med(ys, i, 3)) }));
  // hold the frame until the face leaves a dead zone, then glide there
  const kx = [], ky = [];
  let cur = { x: pts[0].x, y: pts[0].y };
  kx.push({ t: 0, v: cur.x }); ky.push({ t: 0, v: cur.y });
  for (const q of pts) {
    if (Math.abs(q.x - cur.x) > 0.18 || Math.abs(q.y - cur.y) > 0.18) {
      const t0 = Math.max(kx[kx.length - 1].t + 0.05, q.t - 0.45);
      if (roomX > 1) { kx.push({ t: +t0.toFixed(3), v: cur.x }); kx.push({ t: +q.t.toFixed(3), v: q.x }); }
      if (roomY > 1) { ky.push({ t: +t0.toFixed(3), v: cur.y }); ky.push({ t: +q.t.toFixed(3), v: q.y }); }
      cur = { x: q.x, y: q.y };
    }
  }
  commit(() => {
    c.fit = "fill";
    c.kf = c.kf || {};
    if (roomX > 1) c.kf.x = kx; else delete c.kf.x;
    if (roomY > 1) c.kf.y = ky; else delete c.kf.y;
  });
  toast(roomX > 1 || roomY > 1 ? "Reframed to face" : "Clip already fits the frame");
}

// Replace the background behind the person; the clip switches to the processed file.
export async function removeBackground(id, bg, onProgress) {
  const f = M.find(S.p, id);
  if (!f) return;
  const c = f.clip;
  const { job } = await api(`/api/media/${c.mid}/removebg`, { start: c.in, end: c.out, bg });
  const m = await pollJob(job, onProgress);
  Media.add(m);
  commit(() => {
    ensureMediaInProject(m.id);
    const len = c.out - c.in;
    c.origin = c.origin || { mid: c.mid, in: c.in, out: c.out };
    c.mid = m.id; c.in = 0; c.out = Math.min(len, m.duration);
  });
  toast("Background replaced", { label: "Undo", fn: undo });
}

export function restoreOriginal(id) {
  const f = M.find(S.p, id);
  if (!f?.clip.origin) return;
  commit(() => { const c = f.clip; Object.assign(c, c.origin); delete c.origin; });
}
