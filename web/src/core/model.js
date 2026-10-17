// Project model + editing operations. Pure functions over the project object.
//
// Tracks (array order = layer order, bottom -> top):
//   main  : magnetic, clips play back to back. {id, mid, in, out, speed, volume, mute,
//           afadeIn, afadeOut, fit, zoom, zoomEnd, x, y, effect}
//   video : overlays / B-roll / images. {id, mid, start, in, out, speed, volume, mute,
//           x, y, scale, opacity, cover, fadeIn, fadeOut}
//   text  : {id, start, dur, text, style, x, y, anim, animOut, opacity}
//   audio : music / SFX / voice-over. {id, mid, start, in, out, speed, volume, mute, fadeIn, fadeOut, duck}
import { uid, snapFrame, clamp, FPS } from "./util.js";
import { buildGroups, defaultCaptions, TEXT_PRESETS } from "./layer.js";
import { splitKf, shiftKf } from "./kf.js";

export const MIN_DUR = 2 / FPS;

export const mainTrack = (p) => p.tracks.find((t) => t.kind === "main");
export const durOf = (c, kind) => kind === "text" ? c.dur : (c.out - c.in) / (c.speed || 1);
export const endOf = (c, kind) => c.start + durOf(c, kind);

// Transition into main clip i (overlaps the previous clip). Limited to half of either clip.
export const TRANSITIONS = [
  ["none", "None"], ["fade", "Dissolve"], ["fadeblack", "Dip to black"], ["fadewhite", "Flash white"],
  ["slideleft", "Slide left"], ["slideright", "Slide right"], ["slideup", "Slide up"], ["slidedown", "Slide down"],
  ["wipeleft", "Wipe left"], ["wiperight", "Wipe right"], ["zoomin", "Zoom"], ["circleopen", "Circle"],
];
export function transDur(clips, i) {
  const c = clips[i], prev = clips[i - 1];
  if (!prev || !c.trans || !c.trans.type || c.trans.type === "none") return 0;
  if ((c.gap || 0) > 1e-6) return 0; // transitions only join clips that touch
  const d = Math.min(c.trans.dur || 0.5, durOf(prev, "main") * 0.5, durOf(c, "main") * 0.5);
  return Math.max(0, Math.round(d * FPS) / FPS);
}

// Main track: a sequence of clips. With the magnet on they always touch; with it off each
// clip keeps a gap (seconds of empty space before it), so clips can sit anywhere.
export function relayout(p) {
  let t = 0;
  const clips = mainTrack(p).clips;
  clips.forEach((c, i) => {
    const gap = p.magnet ? 0 : Math.max(0, c.gap || 0);
    c.start = Math.max(0, t + gap - transDur(clips, i));
    t = c.start + durOf(c, "main");
  });
  return t;
}

// Rebuild the main track from absolute positions [{clip, start}] (gaps follow from them).
function setFromAbs(p, list) {
  list.sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  for (const it of list) {
    it.clip.gap = p.magnet ? 0 : Math.max(0, snapFrame(it.start - prevEnd));
    prevEnd = Math.max(prevEnd, it.start) + durOf(it.clip, "main");
  }
  mainTrack(p).clips = list.map((x) => x.clip);
  relayout(p);
}
const absList = (p, except) => { relayout(p); return mainTrack(p).clips.filter((c) => c !== except).map((c) => ({ clip: c, start: c.start })); };

export function setMagnet(p, on) {
  p.magnet = !!on;
  if (on) for (const c of mainTrack(p).clips) c.gap = 0;
  relayout(p);
}

// Free mode: put a main clip at start S. Landing inside a clip snaps to its end; clips in
// the way are pushed right (just as much as needed), everything else stays put.
export function moveMainTo(p, id, S) {
  const c = mainTrack(p).clips.find((x) => x.id === id);
  if (!c) return false;
  const d = durOf(c, "main");
  S = Math.max(0, snapFrame(S));
  const others = absList(p, c).sort((a, b) => a.start - b.start);
  const len = (o) => durOf(o.clip, "main");
  for (const o of others) if (o.start < S - 1e-6 && o.start + len(o) > S + 1e-6) S = snapFrame(o.start + len(o));
  let cursor = S + d;
  for (const o of others) {
    if (o.start + 1e-6 < S) continue;
    if (o.start >= cursor - 1e-6) break;
    o.start = cursor;
    cursor = o.start + len(o);
  }
  delete c.trans;
  setFromAbs(p, [...others, { clip: c, start: S }]);
  return true;
}

// Close the empty space before a main clip (later clips follow).
export function closeGap(p, id) {
  const c = mainTrack(p).clips.find((x) => x.id === id);
  if (c) { c.gap = 0; relayout(p); }
}
export const mainEnd = (p) => { const m = mainTrack(p).clips; return m.length ? endOf(m[m.length - 1], "main") : 0; };

export function find(p, id) {
  for (const track of p.tracks) {
    const i = track.clips.findIndex((c) => c.id === id);
    if (i >= 0) return { track, clip: track.clips[i], index: i };
  }
  return null;
}

export function allClips(p) {
  const out = [];
  for (const track of p.tracks) for (const c of track.clips) out.push({ track, clip: c });
  return out;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------
export function newMainClip(m, dur) {
  return { id: uid(), mid: m.id, in: 0, out: m.kind === "image" ? dur || 3 : m.duration, speed: 1, volume: 1,
    mute: false, afadeIn: 0, afadeOut: 0, fit: "fill", zoom: 1, zoomEnd: null, x: 0, y: 0, effect: "none" };
}
export function newOverlayClip(m, start, canvas) {
  const dur = m.kind === "image" ? 3 : m.duration;
  return { id: uid(), mid: m.id, start, in: 0, out: dur, speed: 1, volume: 1, mute: false,
    x: 0.5, y: canvas.h > canvas.w ? 0.32 : 0.5, scale: 0.7, opacity: 1, cover: false, fadeIn: 0, fadeOut: 0 };
}
export function newTextClip(start, preset = "classic", text = "Your text") {
  return { id: uid(), start, dur: 3, text, style: { ...TEXT_PRESETS[preset], maxWidth: 0.86, lineHeight: 1.25 },
    preset, x: 0.5, y: 0.3, anim: "pop", animOut: "fade", opacity: 1 };
}
export function newAudioClip(m, start) {
  return { id: uid(), mid: m.id, start, in: 0, out: m.duration, speed: 1, volume: 0.6, mute: false,
    fadeIn: 0.5, fadeOut: 1, duck: true };
}

const TRACK_NAMES = { video: "Video", text: "Text", audio: "Audio" };
export function newTrack(p, kind, index) {
  const used = new Set(p.tracks.filter((t) => t.kind === kind).map((t) => t.name));
  let n = 1;
  while (used.has(`${TRACK_NAMES[kind]} ${n}`)) n++;
  const t = { id: uid(), kind, clips: [], name: `${TRACK_NAMES[kind]} ${n}` };
  if (index == null) p.tracks.push(t); else p.tracks.splice(index, 0, t);
  return t;
}

// Visual tracks render bottom -> top in array order; "up" means drawn on top.
export function moveTrack(p, id, dir) {
  const i = p.tracks.findIndex((t) => t.id === id);
  const t = p.tracks[i];
  if (!t || t.kind === "main") return;
  const same = (x) => (t.kind === "audio") === (x.kind === "audio") && x.kind !== "main";
  let j = i + dir;
  while (j >= 0 && j < p.tracks.length && !same(p.tracks[j])) j += dir;
  if (j < 0 || j >= p.tracks.length) return;
  [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]];
}

export function deleteTrack(p, id) {
  p.tracks = p.tracks.filter((t) => t.id !== id || t.kind === "main");
}

export function trackFits(track, start, dur, ignoreId) {
  return track.clips.every((c) => c.id === ignoreId || endOf(c, track.kind) <= start + 1e-6 || c.start >= start + dur - 1e-6);
}

export function trackWithRoom(p, kind, start, dur) {
  // Highest existing track of that kind with room, else a new one.
  const ts = p.tracks.filter((t) => t.kind === kind);
  for (let i = ts.length - 1; i >= 0; i--) if (trackFits(ts[i], start, dur)) return ts[i];
  return newTrack(p, kind);
}

// Insert into the main track at t: into empty space if it fits there (magnet off),
// otherwise at the clip boundary nearest to t (later clips move right).
export function insertMain(p, clip, t) {
  const clips = mainTrack(p).clips;
  relayout(p);
  clip.gap = 0;
  if (!p.magnet) {
    const d = durOf(clip, "main"), S = Math.max(0, snapFrame(t));
    const others = absList(p);
    const end = others.length ? Math.max(...others.map((o) => o.start + durOf(o.clip, "main"))) : 0;
    const free = !others.some((o) => S < o.start + durOf(o.clip, "main") - 1e-6 && S + d > o.start + 1e-6);
    if (free && (others.length || S === 0)) { setFromAbs(p, [...others, { clip, start: S }]); return clip; }
    if (!others.length) { setFromAbs(p, [{ clip, start: 0 }]); return clip; }
    if (S >= end - 1e-6) { setFromAbs(p, [...others, { clip, start: end }]); return clip; }
  }
  let idx = clips.length;
  for (let i = 0; i < clips.length; i++) {
    const mid = clips[i].start + durOf(clips[i], "main") / 2;
    if (t < mid) { idx = i; break; }
  }
  clips.splice(idx, 0, clip);
  relayout(p);
  return clip;
}

// Put a clip on a specific row if it fits there, otherwise the nearest row with room.
export function addOnTrack(p, kind, clip, trackId) {
  const want = trackId && p.tracks.find((t) => t.id === trackId && t.kind === kind);
  const tr = want && trackFits(want, clip.start, durOf(clip, kind)) ? want : trackWithRoom(p, kind, clip.start, durOf(clip, kind));
  tr.clips.push(clip);
  tr.clips.sort((a, b) => a.start - b.start);
  return clip;
}

// ---------------------------------------------------------------------------
// Split / delete / trim / move
// ---------------------------------------------------------------------------
function zoomAt(c, localT) {
  if (c.zoomEnd == null) return c.zoom;
  const d = durOf(c, "main");
  return c.zoom + (c.zoomEnd - c.zoom) * clamp(localT / d, 0, 1);
}

export function splitClip(p, id, t) {
  const f = find(p, id);
  if (!f) return null;
  const { track, clip: c, index } = f;
  const kind = track.kind;
  const lt = t - c.start;
  if (lt < MIN_DUR || durOf(c, kind) - lt < MIN_DUR) return null;
  const right = JSON.parse(JSON.stringify(c));
  right.id = uid();
  delete right.trans;
  right.gap = 0;
  splitKf(c, right, lt);
  if (kind === "text") {
    c.dur = lt; right.start = t; right.dur -= lt;
  } else {
    const src = c.in + lt * (c.speed || 1);
    if (kind === "main" && c.zoomEnd != null) { const z = zoomAt(c, lt); c.zoomEnd = z; right.zoom = z; }
    c.out = src; right.in = src; right.start = t;
    if (kind === "main") { c.afadeOut = 0; right.afadeIn = 0; right.effect = "none"; }
    else { c.fadeOut = 0; right.fadeIn = 0; }
  }
  track.clips.splice(index + 1, 0, right);
  if (kind === "main") relayout(p);
  return right;
}

// Split the selected clips under t, or (nothing selected) everything under t.
export function splitAt(p, t, selIds) {
  const targets = [];
  for (const { track, clip } of allClips(p)) {
    if (selIds.size && !selIds.has(clip.id)) continue;
    if (clip.start < t - MIN_DUR && endOf(clip, track.kind) > t + MIN_DUR) targets.push(clip.id);
  }
  const created = [];
  for (const id of targets) { const r = splitClip(p, id, t); if (r) created.push(r.id); }
  return created;
}

export function deleteClips(p, ids) {
  // with the magnet off, the rest of the main track stays where it is
  const keepAbs = !p.magnet ? absList(p).filter((o) => !ids.has(o.clip.id)) : null;
  for (const track of p.tracks) track.clips = track.clips.filter((c) => !ids.has(c.id));
  if (keepAbs) setFromAbs(p, keepAbs); else relayout(p);
}

export function mediaBound(c, meta, kind) {
  if (!meta || meta.kind === "image" || kind === "text") return Infinity;
  return meta.duration;
}

// Trim one edge to timeline time t. Main clips ripple (the start stays put).
export function trimClip(p, id, edge, t, meta) {
  const f = find(p, id);
  if (!f) return;
  const { track, clip: c } = f;
  const kind = track.kind, sp = c.speed || 1;
  const end = endOf(c, kind);
  if (kind === "text") {
    if (edge === "l") { const ns = clamp(t, 0, end - MIN_DUR); shiftKf(c, c.start - ns); c.dur = end - ns; c.start = ns; }
    else c.dur = Math.max(MIN_DUR, t - c.start);
    return;
  }
  const bound = mediaBound(c, meta, kind);
  if (kind === "main" && !p.magnet) {
    const others = absList(p, c);
    const prevEnd = Math.max(0, ...others.filter((o) => o.start < c.start).map((o) => o.start + durOf(o.clip, "main")));
    const nextStart = Math.min(Infinity, ...others.filter((o) => o.start >= c.start).map((o) => o.start));
    let start = c.start;
    if (edge === "l") {
      let ns = clamp(t, prevEnd, end - MIN_DUR);
      let nin = c.in + (ns - c.start) * sp;
      if (nin < 0 && meta?.kind !== "image") { ns -= nin / sp; nin = 0; }
      if (meta?.kind === "image") { c.out = end - ns; nin = 0; }
      shiftKf(c, c.start - ns);
      c.in = nin; start = ns;
    } else {
      c.out = clamp(c.in + (Math.min(t, nextStart) - c.start) * sp, c.in + MIN_DUR * sp, bound);
    }
    setFromAbs(p, [...others, { clip: c, start }]);
    return;
  }
  if (edge === "l") {
    if (kind === "main") {
      // drag the left edge: delta in timeline -> delta in source
      const delta = t - c.start;
      const oldIn = c.in;
      c.in = clamp(c.in + delta * sp, meta && meta.kind === "image" ? -Infinity : 0, c.out - MIN_DUR * sp);
      shiftKf(c, -(c.in - oldIn) / sp);
      if (meta && meta.kind === "image") { c.out = c.out - c.in; c.in = 0; }
    } else {
      let ns = clamp(t, 0, end - MIN_DUR);
      let nin = c.in + (ns - c.start) * sp;
      if (nin < 0 && meta?.kind !== "image") { ns -= nin / sp; nin = 0; }
      if (meta?.kind === "image") { c.out = (end - ns); nin = 0; }
      shiftKf(c, c.start - ns);
      c.in = nin; c.start = ns;
    }
  } else {
    c.out = clamp(c.in + (t - c.start) * sp, c.in + MIN_DUR * sp, bound);
  }
  if (kind === "main") relayout(p);
}

export function moveClip(p, id, start, toTrackId) {
  const f = find(p, id);
  if (!f || f.track.kind === "main") return;
  const c = f.clip;
  c.start = Math.max(0, start);
  if (toTrackId && toTrackId !== f.track.id) {
    const to = p.tracks.find((t) => t.id === toTrackId);
    if (to && to.kind === f.track.kind) {
      f.track.clips.splice(f.index, 1);
      to.clips.push(c);
    }
  }
  for (const t of p.tracks) if (t.kind !== "main") t.clips.sort((a, b) => a.start - b.start);
}

export function moveMain(p, id, toIndex) {
  const clips = mainTrack(p).clips;
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return;
  const [c] = clips.splice(i, 1);
  clips.splice(toIndex > i ? toIndex - 1 : toIndex, 0, c);
  relayout(p);
}

export function duplicate(p, ids) {
  const out = [];
  for (const id of ids) {
    const f = find(p, id);
    if (!f) continue;
    const c = JSON.parse(JSON.stringify(f.clip));
    c.id = uid();
    if (f.track.kind === "main") {
      c.gap = 0;
      if (p.magnet) { f.track.clips.splice(f.index + 1, 0, c); relayout(p); }
      else insertMain(p, c, endOf(f.clip, "main"));
    }
    else { c.start = endOf(f.clip, f.track.kind); addOnTrack(p, f.track.kind, c); }
    out.push(c.id);
  }
  return out;
}

// Q / W in CapCut: delete the part of the clip left/right of the playhead.
export function trimToPlayhead(p, ids, t, side, metaOf) {
  const targets = ids.size ? [...ids] : allClips(p).filter(({ track, clip }) => track.kind === "main" && clip.start < t && endOf(clip, "main") > t).map((x) => x.clip.id);
  for (const id of targets) {
    const f = find(p, id);
    if (!f || !(f.clip.start < t && endOf(f.clip, f.track.kind) > t)) continue;
    trimClip(p, id, side === "left" ? "l" : "r", t, f.clip.mid ? metaOf(f.clip.mid) : null);
  }
}

// Remove a timeline range from the main track (ripple). Other tracks after the
// range shift left so overlays/text/music stay in sync with the speech.
export function cutRange(p, t0, t1) {
  t0 = snapFrame(t0); t1 = snapFrame(t1);
  if (t1 - t0 < 1 / FPS) return;
  relayout(p);
  const d = t1 - t0;
  const list = [];
  for (const c of mainTrack(p).clips) {
    const s = c.start, e = endOf(c, "main"), sp = c.speed || 1;
    if (e <= t0 + 1e-6) { list.push({ clip: c, start: s }); continue; }
    if (s >= t1 - 1e-6) { list.push({ clip: c, start: s - d }); continue; }
    if (s < t0 - MIN_DUR / 2) {
      const left = { ...JSON.parse(JSON.stringify(c)), out: c.in + (t0 - s) * sp, afadeOut: 0 };
      if (c.zoomEnd != null) left.zoomEnd = zoomAt(c, t0 - s);
      splitKf(left, {}, t0 - s);
      list.push({ clip: left, start: s });
    }
    if (e > t1 + MIN_DUR / 2) {
      const right = { ...JSON.parse(JSON.stringify(c)), id: uid(), in: c.in + (t1 - s) * sp, afadeIn: 0, effect: "none", gap: 0 };
      delete right.trans;
      if (c.zoomEnd != null) right.zoom = zoomAt(c, t1 - s);
      splitKf(JSON.parse(JSON.stringify(c)), right, t1 - s);
      list.push({ clip: right, start: Math.max(t0, s) });
    }
  }
  // keep transitions where clips still touch
  const trans = new Map(mainTrack(p).clips.map((c) => [c.id, c.trans]));
  setFromAbs(p, list);
  for (const c of mainTrack(p).clips) if (trans.get(c.id) && !c.gap) c.trans = trans.get(c.id);
  relayout(p);
  for (const tr of p.tracks) {
    if (tr.kind === "main") continue;
    for (const c of tr.clips) if (c.start >= t1 - 1e-6) c.start = Math.max(0, c.start - d);
  }
}

// Move a main-track clip to an overlay row (keeps how it looks: full frame).
export function mainToOverlay(p, id, trackId, S) {
  const f = find(p, id);
  if (!f || f.track.kind !== "main") return null;
  const c = f.clip;
  const others = absList(p, c);
  const o = {
    id: c.id, mid: c.mid, start: Math.max(0, snapFrame(S)), in: c.in, out: c.out, speed: c.speed || 1,
    volume: c.volume ?? 1, mute: !!c.mute, x: 0.5, y: 0.5, scale: 1, opacity: 1, cover: true,
    fadeIn: 0, fadeOut: 0, adj: c.adj, flip: c.flip, look: c.look,
  };
  if (p.magnet) { f.track.clips.splice(f.index, 1); relayout(p); }
  else setFromAbs(p, others);
  const tr = trackId ? p.tracks.find((t) => t.id === trackId && t.kind === "video") : null;
  addOnTrack(p, "video", o, tr ? tr.id : newTrack(p, "video").id);
  return o;
}

// Move an overlay video/image clip down onto the main track at time S.
export function overlayToMain(p, id, S) {
  const f = find(p, id);
  if (!f || f.track.kind !== "video") return null;
  const o = f.clip;
  f.track.clips.splice(f.index, 1);
  const c = { id: o.id, mid: o.mid, in: o.in, out: o.out, speed: o.speed || 1, volume: o.volume ?? 1, mute: !!o.mute,
    afadeIn: 0, afadeOut: 0, fit: "fill", zoom: 1, zoomEnd: null, x: 0, y: 0, effect: "none", adj: o.adj, flip: o.flip, look: o.look };
  insertMain(p, c, S);
  return c;
}

// ---------------------------------------------------------------------------
// Words on the timeline (from each main clip's media transcript)
// ---------------------------------------------------------------------------
// wordsOf(mid) -> [{id, text, start, end, p, seg}] or null
export function timelineWords(p, wordsOf) {
  relayout(p);
  const out = [];
  const edits = p.wordEdits || {};
  mainTrack(p).clips.forEach((c, ci) => {
    const ws = wordsOf(c.mid);
    if (!ws) return;
    const sp = c.speed || 1;
    for (const w of ws) {
      const mid = (w.start + w.end) / 2;
      if (mid < c.in || mid >= c.out) continue;
      const e = edits[c.mid]?.[w.id] || {};
      const s = Math.max(w.start, c.in), en = Math.min(w.end, c.out);
      out.push({
        key: c.mid + ":" + w.id, mid: c.mid, wid: w.id, clipId: c.id, clipIndex: ci,
        text: e.text ?? w.text, emph: !!e.emph, emoji: e.emoji || "", br: !!e.br, p: w.p, seg: w.seg,
        src0: w.start, src1: w.end,
        os: c.start + (s - c.in) / sp, oe: c.start + (en - c.in) / sp,
      });
    }
  });
  return out;
}

export function captionGroups(p, words) {
  const cap = p.captions || defaultCaptions();
  return buildGroups(words.filter((w) => w.oe - w.os > 0.01), cap);
}

export function editWord(p, w, patch) {
  p.wordEdits = p.wordEdits || {};
  if (p.magnet === undefined) p.magnet = false; // CapCut-style free placement by default
  const m = (p.wordEdits[w.mid] = p.wordEdits[w.mid] || {});
  m[w.wid] = Object.assign(m[w.wid] || {}, patch);
}

// Cut whole words (by timeline word indices lo..hi) and the pause after them.
export function cutWords(p, words, lo, hi) {
  const first = words[lo], last = words[hi], next = words[hi + 1], prev = words[lo - 1];
  let t0 = first.os, t1 = last.oe;
  // take the pause that follows (if it's in the same clip) so the edit is tight
  if (next && next.clipId === last.clipId) t1 = Math.max(t1, next.os - 0.04);
  else if (prev && prev.clipId === first.clipId) t0 = Math.min(t0, prev.oe + 0.08);
  cutRange(p, t0, t1);
}

// ---------------------------------------------------------------------------
// Smart tools
// ---------------------------------------------------------------------------
// Remove pauses longer than maxPause from every main clip with a transcript.
export function removeSilences(p, wordsOf, opt) {
  const { maxPause = 0.3, padBefore = 0.06, padAfter = 0.14 } = opt || {};
  relayout(p);
  const cuts = [];
  for (const c of mainTrack(p).clips) {
    const ws = (wordsOf(c.mid) || []).filter((w) => w.end > c.in && w.start < c.out);
    if (!ws.length) continue;
    const sp = c.speed || 1;
    const toT = (src) => c.start + (src - c.in) / sp;
    // keep ranges in source time
    const keep = [];
    for (const w of ws) {
      const r = [Math.max(c.in, w.start - padBefore), Math.min(c.out, w.end + padAfter)];
      const last = keep[keep.length - 1];
      if (last && r[0] - last[1] <= maxPause - padBefore - padAfter) last[1] = Math.max(last[1], r[1]);
      else if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else keep.push(r);
    }
    let prev = c.in;
    for (const [a, b] of keep) {
      if (a - prev > 1 / FPS) cuts.push([toT(prev), toT(a)]);
      prev = b;
    }
    if (c.out - prev > 1 / FPS) cuts.push([toT(prev), toT(c.out)]);
  }
  cuts.sort((a, b) => b[0] - a[0]);
  let removed = 0;
  for (const [a, b] of cuts) { cutRange(p, a, b); removed += b - a; }
  return { cuts: cuts.length, removed };
}

const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

// False starts: a phrase that is restarted within the next few words.
export function findRetakes(words) {
  const tok = words.map((w) => norm(w.text));
  const ranges = [];
  for (let a = 0; a < words.length; a++) {
    const prev = words[a - 1];
    const phraseStart = a === 0 || /[.?!,]["')]*$/.test(prev.text) || words[a].os - prev.oe > 0.25;
    if (!phraseStart || !tok[a]) continue;
    let best = null;
    for (let b = a + 2; b < Math.min(words.length, a + 30); b++) {
      if (words[b].os - words[a].os > 15) break;
      let k = 0;
      while (b + k < tok.length && a + k < b && tok[a + k] && tok[a + k] === tok[b + k]) k++;
      if (k >= 2 && k >= Math.min(3, b - a)) best = b;
    }
    if (best !== null) { ranges.push([a, best - 1]); a = best - 1; }
  }
  return ranges;
}

export function cutWordRanges(p, words, ranges) {
  // back to front so earlier times stay valid
  const tr = ranges.map(([lo, hi]) => {
    const next = words[hi + 1];
    let t1 = words[hi].oe;
    if (next && next.clipId === words[hi].clipId) t1 = Math.max(t1, next.os - 0.04);
    return [words[lo].os, t1];
  }).sort((a, b) => b[0] - a[0]);
  for (const [a, b] of tr) cutRange(p, a, b);
}

export const FILLER = /^(um+|uh+|uhm+|erm+|ah+|hmm+|mm+|eh+)$/i;
export const isFiller = (w) => FILLER.test(norm(w.text));

// Alternate a punch-in zoom on consecutive main clips (jump-cut style).
export function autoZoom(p, amount = 1.15) {
  mainTrack(p).clips.forEach((c, i) => {
    const base = c.zoomEnd == null ? 1 : c.zoom;
    if (c.zoomEnd == null) c.zoom = i % 2 ? amount : 1;
    else c.zoom = base;
  });
}

// Normalise a project loaded from disk (fill defaults; old files).
export function normalize(p) {
  p.canvas = Object.assign({ w: 1080, h: 1920, fps: 30, bg: "blur" }, p.canvas || {});
  p.tracks = p.tracks || [{ id: "main", kind: "main", clips: [] }];
  if (!mainTrack(p)) p.tracks.unshift({ id: "main", kind: "main", clips: [] });
  for (const t of p.tracks) {
    t.name = t.name || (t.kind === "main" ? "Main" : t.kind);
    for (const c of t.clips) {
      if (t.kind === "main") Object.assign(c, Object.assign({ speed: 1, volume: 1, mute: false, afadeIn: 0, afadeOut: 0, fit: "fill", zoom: 1, zoomEnd: null, x: 0, y: 0, effect: "none" }, c));
    }
  }
  p.captions = Object.assign(defaultCaptions(), p.captions || {});
  p.audio = Object.assign({ normalize: true, lufs: -14, enhance: false, repair: true }, p.audio || {});
  p.wordEdits = p.wordEdits || {};
  p.media = p.media || [];
  p.markers = p.markers || [];
  relayout(p);
  return p;
}
