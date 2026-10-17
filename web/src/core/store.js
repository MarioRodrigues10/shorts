// App state, undo/redo, autosave, selection and the cached caption/text layer.
import { api, emit, on } from "./util.js";
import { relayout, timelineWords, captionGroups, find, mainTrack } from "./model.js";
import * as Media from "./media.js";
import { layerState } from "./layer.js";

export const S = {
  p: null,
  sel: new Set(),
  rev: 0,
  undo: [],
  redo: [],
  player: null,
  timeline: null,
  saveTimer: null,
  saved: true,
};

const snap = () => JSON.stringify({ tracks: S.p.tracks, captions: S.p.captions, wordEdits: S.p.wordEdits,
  canvas: S.p.canvas, audio: S.p.audio, media: S.p.media, markers: S.p.markers });

let histKey = null, histAt = 0;
// Call before mutating. `key` coalesces rapid edits of one control into one undo step.
export function begin(key) {
  const now = Date.now();
  if (key && key === histKey && now - histAt < 1200) { histAt = now; return; }
  S.undo.push(snap());
  if (S.undo.length > 200) S.undo.shift();
  S.redo.length = 0;
  histKey = key || null; histAt = now;
  emit("history");
}

// After mutating: rebuild derived state, refresh views, autosave.
export function changed(opts = {}) {
  relayout(S.p);
  S.rev++;
  // drop selections that no longer exist
  for (const id of [...S.sel]) if (id !== "captions" && !find(S.p, id)) S.sel.delete(id);
  S.player?.invalidate();
  if (!opts.noTimeline) S.timeline?.render();
  emit("changed", opts);
  scheduleSave();
}

export function commit(fn, key, opts) { begin(key); fn(); changed(opts); }

function restore(s) {
  Object.assign(S.p, JSON.parse(s));
  histKey = null;
  changed();
  emit("selection");
  emit("history");
}
export function undo() { if (!S.undo.length) return; S.redo.push(snap()); restore(S.undo.pop()); }
export function redo() { if (!S.redo.length) return; S.undo.push(snap()); restore(S.redo.pop()); }

export function scheduleSave() {
  S.saved = false;
  emit("save", "dirty");
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(save, 600);
}
export async function save() {
  if (!S.p) return;
  clearTimeout(S.saveTimer);
  try {
    await api("/api/projects/" + S.p.id, S.p, "PUT");
    S.saved = true;
    emit("save", "saved");
  } catch (e) { emit("save", "error:" + e.message); }
}

export function select(ids, mode) {
  if (mode === "toggle") for (const id of ids) S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id);
  else if (mode === "add") for (const id of ids) S.sel.add(id);
  else S.sel = new Set(ids);
  S.timeline?.updateSelection();
  S.player?.invalidate();
  emit("selection");
}

// ---- layer (captions + text + flash/fade effects), rebuilt when the project changes
let layerCache = { rev: -1 };
on("words", () => { S.rev++; S.player?.invalidate(); emit("changed", { words: true }); });

export function words() {
  layer(0);
  return layerCache.words;
}

export function layer(t) {
  const p = S.p;
  if (layerCache.rev !== S.rev) {
    const ws = timelineWords(p, Media.getWords);
    const texts = [];
    for (const tr of p.tracks) if (tr.kind === "text") texts.push(...tr.clips);
    const fx = [];
    for (const c of mainTrack(p).clips) if (c.effect === "flash" || c.effect === "fade") fx.push({ t: c.start, kind: c.effect });
    const cap = Object.assign({}, p.captions);
    layerCache = {
      rev: S.rev, words: ws,
      L: { W: p.canvas.w, H: p.canvas.h, groups: captionGroups(p, ws), cap, texts, fx },
    };
  }
  const { L } = layerCache;
  // posY/size can be changed live by canvas drags without a rev bump
  Object.assign(L.cap, { posY: p.captions.posY, size: p.captions.size });
  return { L, st: layerState(L, t) };
}

export function clipById(id) { const f = find(S.p, id); return f ? f.clip : null; }
