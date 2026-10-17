// Media metadata + lazily loaded assets (filmstrip sprites, waveform peaks, words).
import { api, emit } from "./util.js";

const metas = new Map();
const peaks = new Map();
const words = new Map();
const sprites = new Map();
let pollTimer = null;

export const meta = (mid) => metas.get(mid);
export const allMeta = () => [...metas.values()];
// The version in the URL makes the player switch cleanly when a proxy is regenerated.
export const previewUrl = (mid) => `/media/${mid}/preview?v=${metas.get(mid)?.proxy_rev || 0}`;

function pending(m) {
  return !m.ready.proxy || (m.kind === "video" && !m.ready.sprite) || (m.has_audio && !m.ready.peaks) ||
    (m.status?.transcript && ["queued", "running"].includes(m.status.transcript));
}

export async function load(ids) {
  ids = [...new Set(ids)].filter(Boolean);
  if (!ids.length) return;
  const list = await api("/api/media?ids=" + ids.join(","));
  for (const m of list) set(m);
  schedulePoll();
}

function set(m) {
  const old = metas.get(m.id);
  metas.set(m.id, m);
  if (old) {
    if (!old.ready.peaks && m.ready.peaks) peaks.delete(m.id);
    if (!old.ready.sprite && m.ready.sprite) sprites.delete(m.id);
    if (JSON.stringify(old.covered) !== JSON.stringify(m.covered)) { words.delete(m.id); wordsLoading.delete(m.id); }
  }
  if (!old || JSON.stringify(old.ready) !== JSON.stringify(m.ready) || JSON.stringify(old.working) !== JSON.stringify(m.working)
      || JSON.stringify(old.status) !== JSON.stringify(m.status) || JSON.stringify(old.covered) !== JSON.stringify(m.covered)) emit("media", m);
}

export function add(m) { set(m); schedulePoll(); }

function schedulePoll() {
  if (pollTimer) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    const ids = [...metas.values()].filter(pending).map((m) => m.id);
    if (!ids.length) return;
    try { const list = await api("/api/media?ids=" + ids.join(",")); for (const m of list) set(m); } catch { /* retry */ }
    schedulePoll();
  }, 1200);
}

export function getPeaks(mid) {
  const m = metas.get(mid);
  if (!m || !m.ready.peaks) return null;
  if (!peaks.has(mid)) {
    peaks.set(mid, null);
    fetch(`/media/${mid}/peaks.json`).then((r) => r.json()).then((d) => { peaks.set(mid, d); emit("assets", mid); });
  }
  return peaks.get(mid);
}

export function getSprite(mid) {
  const m = metas.get(mid);
  if (!m || !m.ready.sprite || !m.sprite) return null;
  if (!sprites.has(mid)) {
    const img = new Image();
    img.onload = () => emit("assets", mid);
    img.src = `/media/${mid}/sprite.jpg`;
    sprites.set(mid, img);
  }
  const img = sprites.get(mid);
  return img.complete && img.naturalWidth ? { img, ...m.sprite } : null;
}

const wordsLoading = new Map(); // mid -> promise of the fetch in flight

export function getWords(mid) {
  const m = metas.get(mid);
  if (!m || !m.ready.words) return null;
  if (!words.has(mid)) loadWords(mid);
  return words.get(mid);
}

// Resolves once the transcript is in memory (tools that read words must not run on a half-loaded cache).
export function loadWords(mid) {
  const m = metas.get(mid);
  if (!m || !m.ready.words) return Promise.resolve(null);
  if (words.get(mid)) return Promise.resolve(words.get(mid));
  if (!wordsLoading.has(mid)) {
    words.set(mid, null);
    const p = fetch(`/media/${mid}/words.json`).then((r) => r.json()).then((d) => {
      if (wordsLoading.get(mid) === p) { words.set(mid, d.words); wordsLoading.delete(mid); emit("words", mid); }
      return d.words;
    }).catch((e) => { wordsLoading.delete(mid); words.delete(mid); throw e; });
    wordsLoading.set(mid, p);
  }
  return wordsLoading.get(mid);
}

// ranges: [[srcStart, srcEnd], ...] — only these parts of the file are transcribed (cached).
export async function transcribe(mid, ranges, model, force) {
  const r = await api(`/api/media/${mid}/transcribe`, { ranges, model, force });
  if (r.seconds > 0) {
    const m = metas.get(mid);
    if (m) { m.status = Object.assign({}, m.status, { transcript: "queued" }); emit("media", m); }
    schedulePoll();
  }
  return r.seconds || 0;
}

// Seconds of `ranges` not yet transcribed for this media.
export function uncovered(mid, ranges) {
  const cov = metas.get(mid)?.covered || [];
  let miss = 0;
  for (const [a, b] of ranges) {
    let segs = [[a, b]];
    for (const [c, d] of cov) {
      const next = [];
      for (const [x, y] of segs) {
        if (d <= x || c >= y) { next.push([x, y]); continue; }
        if (c > x) next.push([x, c]);
        if (d < y) next.push([d, y]);
      }
      segs = next;
    }
    miss += segs.reduce((s, [x, y]) => s + Math.max(0, y - x - 0.6), 0);
  }
  return miss;
}

export async function importPath(path) {
  const m = await api("/api/media/import", { path });
  add(m);
  return m;
}

export async function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media/upload?name=" + encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => onProgress && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const j = JSON.parse(xhr.responseText);
      if (xhr.status !== 200 || j.error) reject(new Error(j.error || xhr.statusText));
      else { add(j); resolve(j); }
    };
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(file);
  });
}
