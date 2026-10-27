// Preview compositor + playback engine.
// A master clock drives the timeline; <video>/<audio> elements are slaved to it.
// Elements are pooled, pre-seeked for the next clip (seamless cuts) and
// unloaded when idle to keep memory low.
import { clamp } from "./util.js";
import { durOf, endOf, mainTrack, transDur } from "./model.js";
import { smoothParams, smoothAt, usesCropPath } from "./smooth.js";
import { kfValue, setProp, hasKf, setKf } from "./kf.js";
import * as Media from "./media.js";
import { drawLayer, drawGuides } from "./layer.js";

const LOOKAHEAD = 1.5;   // pre-seek the next clip this many seconds early
const SLOTS = 3;         // main-track <video> elements in rotation (current + next two)
const PREROLL = 0.3;     // start the next clip this early (muted) so cuts don't hitch
const IDLE_UNLOAD = 6;   // unload media elements unused for this long (s)

export class Player {
  constructor(canvas, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.hooks = hooks; // {project(), layer(t) -> {L, st}, selected(), onTime(t), onSelect(id), onBegin(), onChange(), onEnd()}
    this.playing = false;
    this.t = 0;
    this.pool = new Map();
    this.ac = null;              // Web Audio, for sample-accurate silence at cuts (see _gate)
    this.gains = new WeakMap();  // media element -> GainNode
    this.images = new Map();
    this.dirty = true;
    this.boxes = {};
    this.guides = false;
    this.small = document.createElement("canvas");
    this.small.width = 36; this.small.height = 64;
    this.gesture = null;
    this.lastCleanup = 0;
    this.startLag = 0.12; // measured delay between play() and frames advancing
    this._loop = this._loop.bind(this);
    this.raf = requestAnimationFrame(this._loop);
    this._bindPointer();
  }

  get total() { const p = this.hooks.project(); return p ? endOfMain(p) : 0; }
  time() { return this.playing ? this.clockT() : this.t; }
  clockT() { return this.t0 + (performance.now() - this.p0) / 1000; }

  play() {
    if (this.playing || !this.hooks.project()) return;
    if (this.t >= this.total - 0.05) this.t = 0;
    this.t0 = this.t; this.p0 = performance.now();
    this.playing = true;
    // Created on a user action (play), so the browser lets it run.
    try { this.ac = this.ac || new AudioContext(); if (this.ac.state === "suspended") this.ac.resume(); } catch { this.ac = null; }
    this.hooks.onPlayState?.(true);
  }
  pause() {
    if (!this.playing) return;
    this.mainKey = null;
    this.t = Math.min(this.clockT(), this.total);
    this.playing = false;
    for (const e of this.pool.values()) e.el.pause();
    this.dirty = true;
    this.hooks.onPlayState?.(false);
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) {
    t = clamp(t, 0, Math.max(0, this.total));
    this.mainKey = null;
    if (this.playing) { this.t0 = t; this.p0 = performance.now(); }
    this.t = t;
    this.dirty = true;
    this.hooks.onTime?.(t);
  }
  invalidate() { this.dirty = true; }

  resize() {
    const p = this.hooks.project();
    if (!p) return;
    const wrap = this.canvas.parentElement;
    const { w: W, h: H } = p.canvas;
    const availW = wrap.clientWidth - 24, availH = wrap.clientHeight - 24;
    const k = Math.min(availW / W, availH / H);
    const cw = Math.max(50, Math.floor(W * k)), ch = Math.max(50, Math.floor(H * k));
    this.canvas.style.width = cw + "px";
    this.canvas.style.height = ch + "px";
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.min(W, Math.round(cw * dpr));
    this.canvas.height = Math.round(this.canvas.width * H / W);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- media pool
  _get(key, mid, kind) {
    let e = this.pool.get(key);
    const url = Media.previewUrl(mid);
    if (e && (e.mid !== mid || e.url !== url)) { this._drop(key); e = null; }
    if (!e) {
      const el = document.createElement(kind === "audio" ? "audio" : "video");
      el.preload = "auto";
      el.playsInline = true;
      el.muted = true;
      el.src = url;
      el.addEventListener("seeked", () => { this.dirty = true; });
      el.addEventListener("loadeddata", () => { this.dirty = true; });
      e = { el, mid, url, used: performance.now() };
      this.pool.set(key, e);
    }
    e.used = performance.now();
    return e.el;
  }
  _drop(key) {
    const e = this.pool.get(key);
    if (!e) return;
    e.el.pause();
    e.el.removeAttribute("src");
    e.el.load();
    this.pool.delete(key);
  }
  _image(mid) {
    let img = this.images.get(mid);
    if (!img) {
      img = new Image();
      img.onload = () => { this.dirty = true; };
      img.src = Media.previewUrl(mid);
      this.images.set(mid, img);
    }
    return img;
  }
  _cleanup(now) {
    if (now - this.lastCleanup < 1000) return;
    this.lastCleanup = now;
    for (const [k, e] of this.pool) {
      // never unload what is on screen (or about to be)
      if (this.liveKeys?.has(k)) { e.used = now; continue; }
      if (now - e.used > IDLE_UNLOAD * 1000) this._drop(k);
    }
    if (this.images.size > 16) this.images.clear(); // decoded bitmaps live in this tab's RAM
  }

  // Silence a main-track element exactly at its clip's out point, on the audio clock. Pausing it
  // from this loop is too late when the page stutters or the sound output buffers audio, and the
  // words after the cut leak through. Through a GainNode the samples past the cut are zeroed
  // before they reach the output, whatever the latency.
  _gate(el, clip) {
    const ac = this.ac;
    if (!ac || ac.state !== "running") return;
    let g = this.gains.get(el);
    if (!g) {
      if (!this.playing) return;
      try {
        g = ac.createGain();
        ac.createMediaElementSource(el).connect(g).connect(ac.destination);
      } catch { return; }
      this.gains.set(el, g);
    }
    const now = ac.currentTime, gain = g.gain;
    gain.cancelScheduledValues(now);
    const left = (clip.out - el.currentTime) / (clip.speed || 1);
    if (!this.playing || el.paused || left > 0.6) { gain.setValueAtTime(1, now); return; }
    if (left <= 0.005) { gain.setValueAtTime(0, now); return; }
    const end = now + left;
    gain.setValueAtTime(1, now);
    gain.setValueAtTime(1, end - 0.004);
    gain.linearRampToValueAtTime(0, end); // 4 ms: no click
  }

  _sync(el, srcT, rate, play, vol, muted, startTol = 0.05) {
    if (el.playbackRate !== rate) el.playbackRate = clamp(rate, 0.0625, 16);
    el.volume = clamp(vol, 0, 1);
    el.muted = muted;
    if (play) {
      if (el.paused) {
        if (Math.abs(el.currentTime - srcT) > startTol) el.currentTime = srcT;
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - srcT) > 0.35 && !el.seeking) el.currentTime = srcT;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - srcT) > 0.02 && !el.seeking) el.currentTime = srcT;
    }
  }

  // ---------------------------------------------------------------- loop
  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const k of [...this.pool.keys()]) this._drop(k);
    this.images.clear();
  }

  _loop(now) {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this._loop);
    const p = this.hooks.project();
    if (!p) return;
    this._cleanup(now);
    let t = this.time();
    const total = this.total;
    if (this.playing && t >= total) { this.pause(); this.t = total; t = total; this.hooks.onEnd?.(); }
    if (!this.playing && !this.dirty) return;
    this.dirty = false;

    const mainT = mainTrack(p);
    const main = mainT.clips;
    const live = new Set();
    const vol = (x) => (this.muteAll ? 0 : x);
    const breath = (c, srcT) => (p.audio?.breaths ? Media.breathGain(c, srcT) : 1); // "Lower breaths"
    // ---- main track (two clips overlap during a transition)
    const ci = mainIndexAt(main, t);
    const c = ci >= 0 ? main[ci] : null;
    const td = c ? transDur(main, ci) : 0;
    const tp = td > 0 && t < c.start + td ? clamp((t - c.start) / td, 0, 1) : 1;
    const prev = tp < 1 ? main[ci - 1] : null;
    let mainEl = null, prevEl = null;
    if (c) {
      const m = Media.meta(c.mid);
      if (m && m.kind === "video" && m.ready.proxy) {
        const key = `m${ci % SLOTS}`;
        live.add(key);
        mainEl = this._get(key, c.mid);
        const srcT = c.in + (t - c.start) * (c.speed || 1);
        const muted = !!(c.mute || mainT.muted);
        if (this.playing && !mainEl.paused && !mainEl.seeking && mainEl.readyState >= 3 && this.mainKey === key) {
          // The playing video drives the clock (no corrective seeks; those click and hitch).
          // Never step backwards: if the video is a bit behind, ease the clock toward it.
          const vt = c.start + (mainEl.currentTime - c.in) / (c.speed || 1);
          if (Math.abs(vt - t) < 0.5) {
            const nt = vt >= t ? vt : t - 0.25 * (t - vt);
            t = Math.max(nt, this.lastT ?? 0);
            this.t0 = t; this.p0 = performance.now();
          }
          mainEl.volume = clamp(vol((c.volume ?? 1) * tp * breath(c, mainEl.currentTime)), 0, 1);
          mainEl.muted = muted;
        } else {
          // Switching to a clip that was pre-seeked: just start it and keep the clock running
          // (its first frame is already decoded). Only a real seek holds the clock.
          this._sync(mainEl, srcT, c.speed || 1, this.playing, vol((c.volume ?? 1) * tp * breath(c, srcT)), muted, 0.12);
          if (this.playing && mainEl.seeking) { this.t0 = t; this.p0 = performance.now(); }
        }
        this.mainKey = key;
        this._gate(mainEl, c);
      }
      if (prev) {
        const pm = Media.meta(prev.mid);
        if (pm && pm.kind === "video" && pm.ready.proxy) {
          const key = `m${(ci - 1) % SLOTS}`;
          live.add(key);
          prevEl = this._get(key, prev.mid);
          const srcT = prev.in + (t - prev.start) * (prev.speed || 1);
          this._sync(prevEl, srcT, prev.speed || 1, this.playing, vol((prev.volume ?? 1) * (1 - tp) * breath(prev, srcT)), !!(prev.mute || mainT.muted));
          this._gate(prevEl, prev);
        }
      }
    }
    {
      // Pre-seek the next clips into their own slots, so cuts play back without a hitch
      // (two ahead: after silence removal clips can be shorter than a seek). In an empty
      // gap, "next" is the first clip after the playhead.
      let base = ci;
      if (ci < 0) { base = main.findIndex((x) => x.start > t) - 1; if (base < -1) base = main.length; }
      for (let k = 1; k <= SLOTS - 1; k++) {
        const ni = base + k;
        const n = main[ni];
        if (!n || n.start - t > LOOKAHEAD * k) break;
        if (prev && ni % SLOTS === (ci - 1) % SLOTS) break; // slot busy with the transition
        const nm = Media.meta(n.mid);
        if (!nm || nm.kind !== "video" || !nm.ready.proxy) continue;
        const key = `m${ni % SLOTS}`;
        live.add(key);
        const el = this._get(key, n.mid);
        const until = n.start - t;
        const sp = n.speed || 1;
        // Where playback must start so the clip reaches its in-point exactly at the cut,
        // given the measured start-up delay. Prepared ahead of time, so starting needs no seek.
        const lead = Math.max(0, PREROLL - this.startLag);
        const prerollPos = n.in - lead * sp;
        const canPreroll = prerollPos >= 0;
        if (k === 1 && this.playing && canPreroll && until <= PREROLL) {
          if (el.paused && !el.seeking) {
            const want = n.in - Math.max(0, until - this.startLag) * sp;
            if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want; // late: fall back to a seek
            if (el.playbackRate !== sp) el.playbackRate = sp;
            const asked = performance.now(), from = el.currentTime;
            const onTick = () => {
              if (el.currentTime > from + 0.001) {
                const lag = (performance.now() - asked) / 1000 - (el.currentTime - from) / sp;
                if (lag > 0 && lag < 0.5) this.startLag = 0.7 * this.startLag + 0.3 * lag;
                el.removeEventListener("timeupdate", onTick);
              }
            };
            el.addEventListener("timeupdate", onTick);
            el.play().catch(() => {});
          }
          el.muted = true;
          continue;
        }
        if (!el.paused && el !== mainEl) el.pause();
        const target = this.playing && canPreroll ? prerollPos : n.in;
        if (!el.seeking && Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
        el.muted = true;
      }
    }
    // ---- overlays & audio
    for (const tr of p.tracks) {
      if (tr.kind !== "video" && tr.kind !== "audio") continue;
      for (const o of tr.clips) {
        const s = o.start, e = endOf(o, tr.kind);
        const m = Media.meta(o.mid);
        if (!m || !m.ready.proxy || m.kind === "image") continue;
        const key = "o" + o.id;
        if (t >= s - LOOKAHEAD && t < e) {
          live.add(key);
          const el = this._get(key, o.mid, m.kind === "audio" ? "audio" : "video");
          const srcT = o.in + Math.max(0, t - s) * (o.speed || 1);
          const inside = t >= s;
          let v = o.volume ?? 1;
          if (tr.kind === "audio") v *= fadeGain(o, t - s);
          this._sync(el, srcT, o.speed || 1, this.playing && inside, vol(v), !!(o.mute || tr.muted || !inside));
        }
      }
    }
    for (const [k, e] of this.pool) if (!live.has(k) && !e.el.paused) e.el.pause();
    this.liveKeys = live;

    // While the clip under the playhead is still loading/seeking, keep showing the
    // last good frame instead of flashing black; retry on the next frame.
    const notReady = (el) => !el || el.readyState < 2 || el.seeking;
    if (c && Media.meta(c.mid)?.kind === "video" && notReady(mainEl) && this.hasFrame) {
      this.dirty = true;
      this.hooks.onTime?.(t);
      return;
    }
    this.lastT = this.playing ? t : null;
    this._draw(p, t, { c, mainEl, prev, prevEl, tp });
    this.hasFrame = !!(c && (mainEl ? mainEl.readyState >= 2 : true));
    this.hooks.onTime?.(t);
  }

  // ---------------------------------------------------------------- drawing
  _src(clip, el) {
    const m = Media.meta(clip.mid);
    const src = m?.kind === "image" ? this._image(clip.mid) : el;
    return src && ready(src) ? { m, src } : null;
  }

  _draw(p, t, { c, mainEl, prev, prevEl, tp }) {
    const ctx = this.ctx;
    const { w: W, h: H } = p.canvas;
    const scale = this.canvas.width / W;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (c && !mainTrack(p).hidden) {
      const cur = this._src(c, mainEl);
      const drawCur = () => cur && this._drawMain(ctx, p, c, cur.m, cur.src, t - c.start, W, H);
      if (prev && tp < 1) {
        const pr = this._src(prev, prevEl);
        const drawPrev = () => pr && this._drawMain(ctx, p, prev, pr.m, pr.src, t - prev.start, W, H);
        drawTransition(ctx, c.trans.type, tp, W, H, drawPrev, drawCur);
      } else drawCur();
    }
    const boxes = {};
    for (const tr of p.tracks) {
      if (tr.kind !== "video" || tr.hidden) continue;
      for (const o of tr.clips) {
        const lt = t - o.start;
        if (lt < 0 || lt >= durOf(o, "video")) continue;
        const m = Media.meta(o.mid);
        if (!m) continue;
        const src = m.kind === "image" ? this._image(o.mid) : this.pool.get("o" + o.id)?.el;
        const v = overlayValues(o, lt);
        const cr = cropRect(o, m.width || 1, m.height || 1);
        const r = overlayRect(v, { width: cr.w, height: cr.h }, W, H);
        if (src && ready(src)) {
          const kx = (src.videoWidth || src.naturalWidth) / (m.width || 1), ky = (src.videoHeight || src.naturalHeight) / (m.height || 1);
          ctx.save();
          ctx.globalAlpha = clamp(v.opacity * fadeGain(o, lt), 0, 1);
          ctx.filter = adjFilter(o.adj);
          ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
          if (v.rotate) ctx.rotate(v.rotate * Math.PI / 180);
          if (o.flip) ctx.scale(-1, 1);
          ctx.drawImage(src, cr.x * kx, cr.y * ky, cr.w * kx, cr.h * ky, -r.w / 2, -r.h / 2, r.w, r.h);
          ctx.restore();
        }
        boxes[o.id] = r;
      }
    }
    const { L, st } = this.hooks.layer(t);
    const hiddenText = new Set(p.tracks.filter((tr) => tr.kind === "text" && tr.hidden).flatMap((tr) => tr.clips.map((x) => x.id)));
    if (hiddenText.size) st.tx = st.tx.filter(([id]) => !hiddenText.has(id));
    Object.assign(boxes, drawLayer(ctx, L, st, scale));
    if (this.guides) drawGuides(ctx, W, H);
    this.boxes = boxes;
    // selection gizmo
    const sel = this.hooks.selected();
    for (const id of sel) {
      const b = boxes[id];
      if (!b) continue;
      ctx.save();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2 / scale;
      ctx.setLineDash([]);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = "#fff";
      const hs = 12 / scale;
      for (const [hx, hy] of corners(b)) { ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs); }
      ctx.restore();
    }
    if (this.snapGuide) {
      ctx.save();
      ctx.strokeStyle = "#ff2d55"; ctx.lineWidth = 2 / scale;
      ctx.beginPath();
      if (this.snapGuide.x) { ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); }
      if (this.snapGuide.y) { ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); }
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawMain(ctx, p, c, m, src, lt, W, H) {
    ctx.save();
    ctx.filter = adjFilter(c.adj);
    const clips = mainTrack(p).clips;
    const sm = smoothAt(smoothParams(p, clips, clips.indexOf(c)), lt, W, H); // smooth cut
    const inCrop = sm && usesCropPath(c);
    if (sm && !inCrop) { ctx.translate(sm.tx, sm.ty); ctx.scale(sm.k, sm.k); } // outermost transform
    if (c.flip) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    this._drawMainInner(ctx, p, c, m, src, lt, W, H, inCrop ? sm : null);
    ctx.restore();
  }

  _drawMainInner(ctx, p, c, m, src, lt, W, H, sm = null) {
    const vw = src.videoWidth || src.naturalWidth, vh = src.videoHeight || src.naturalHeight;
    const kx = vw / (m.width || vw), ky = vh / (m.height || vh);
    // the crop (source units) acts as the whole picture from here on
    const cr = cropRect(c, m.width || vw, m.height || vh);
    const sw = cr.w, sh = cr.h, ox = cr.x, oy = cr.y;
    const z = zoomAt(c, lt);
    const px = kfValue(c, "x", lt, c.x || 0), py = kfValue(c, "y", lt, c.y || 0);
    const fill = (c.fit || "fill") === "fill";
    if (fill && z >= 1 && sm) {
      // smooth cut: scale by k and move the crop window by -t (same as the export's crop expression)
      const s = Math.max(W / sw, H / sh) * z * sm.k;
      const cx = clamp((sw * s - sm.k * W) / 2 * (1 + px) - sm.tx, 0, sw * s - W);
      const cy = clamp((sh * s - sm.k * H) / 2 * (1 + py) - sm.ty, 0, sh * s - H);
      ctx.drawImage(src, (ox + cx / s) * kx, (oy + cy / s) * ky, (W / s) * kx, (H / s) * ky, 0, 0, W, H);
      return;
    }
    if (fill && z >= 1) {
      const s = Math.max(W / sw, H / sh) * z;
      const cropX = (sw * s - W) / 2 * (1 + px), cropY = (sh * s - H) / 2 * (1 + py);
      ctx.drawImage(src, (ox + cropX / s) * kx, (oy + cropY / s) * ky, (W / s) * kx, (H / s) * ky, 0, 0, W, H);
      return;
    }
    const bg = p.canvas.bg || "blur";
    if (bg === "blur") {
      // cheap blur: draw tiny, upscale smoothly
      const sc = this.small.getContext("2d");
      const s0 = Math.max(W / sw, H / sh);
      const cw = W / s0, ch = H / s0;
      sc.drawImage(src, (ox + (sw - cw) / 2) * kx, (oy + (sh - ch) / 2) * ky, cw * kx, ch * ky, 0, 0, this.small.width, this.small.height);
      ctx.save();
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.small, 0, 0, W, H);
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    } else {
      ctx.fillStyle = bg === "black" ? "#000" : bg;
      ctx.fillRect(0, 0, W, H);
    }
    // fill below 100% uses the crop path's x/y meaning (same formula), so scaling across 100% is seamless
    const s = (fill ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh)) * z;
    const fw = sw * s, fh = sh * s;
    const dx = fill ? (W - fw) / 2 * (1 + px) : (W - fw) / 2 + px * W / 2;
    const dy = fill ? (H - fh) / 2 * (1 + py) : (H - fh) / 2 + py * H / 2;
    ctx.drawImage(src, ox * kx, oy * ky, sw * kx, sh * ky, dx, dy, fw, fh);
  }

  // ---------------------------------------------------------------- canvas gestures
  _toCanvas(e) {
    const p = this.hooks.project();
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * p.canvas.w, y: (e.clientY - r.top) / r.height * p.canvas.h };
  }
  _bindPointer() {
    const cv = this.canvas;
    cv.addEventListener("pointerdown", (e) => {
      const p = this.hooks.project();
      if (!p) return;
      const pt = this._toCanvas(e);
      const W = p.canvas.w;
      const hs = 22 * W / 1080;
      // handle of a selected item?
      for (const id of this.hooks.selected()) {
        const b = this.boxes[id];
        if (!b) continue;
        for (const [hx, hy] of corners(b)) {
          if (Math.abs(pt.x - hx) < hs && Math.abs(pt.y - hy) < hs) {
            this._begin(e, id, "scale", pt, b);
            return;
          }
        }
      }
      // topmost item under the pointer (drawn last = on top)
      const ids = Object.keys(this.boxes).reverse();
      const hit = ids.find((id) => { const b = this.boxes[id]; return pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h; });
      if (hit) {
        this.hooks.onSelect(hit, e.shiftKey);
        this._begin(e, hit, "move", pt, this.boxes[hit]);
      } else {
        this.hooks.onSelect(null);
      }
    });
    cv.addEventListener("pointermove", (e) => {
      const g = this.gesture;
      if (!g) return;
      const p = this.hooks.project();
      const pt = this._toCanvas(e);
      const { w: W, h: H } = p.canvas;
      const dx = pt.x - g.pt.x, dy = pt.y - g.pt.y;
      if (!g.started) { if (Math.hypot(dx, dy) < 3) return; g.started = true; this.hooks.onBegin(); }
      const target = g.id === "captions" ? p.captions : this.hooks.clipById(g.id);
      if (!target) return;
      this.snapGuide = null;
      if (g.mode === "move") {
        if (g.id === "captions") { target.posY = clamp(g.orig.posY + dy / H, 0.05, 0.95); }
        else {
          let nx = g.orig.x + dx / W, ny = g.orig.y + dy / H;
          const sg = {};
          if (Math.abs(nx - 0.5) < 0.012) { nx = 0.5; sg.x = true; }
          if (Math.abs(ny - 0.5) < 0.008) { ny = 0.5; sg.y = true; }
          if (sg.x || sg.y) this.snapGuide = sg;
          const lt = this.time() - target.start;
          setProp(target, "x", lt, clamp(nx, -0.5, 1.5));
          setProp(target, "y", lt, clamp(ny, -0.5, 1.5));
        }
      } else {
        const cx = g.box.x + g.box.w / 2, cy = g.box.y + g.box.h / 2;
        const d0 = Math.hypot(g.pt.x - cx, g.pt.y - cy), d1 = Math.hypot(pt.x - cx, pt.y - cy);
        const k = clamp(d1 / Math.max(d0, 1), 0.1, 10);
        if (g.id === "captions") target.size = Math.round(clamp(g.orig.size * k, 20, 300));
        else {
          const lt = this.time() - target.start;
          if (hasKf(target, "scale")) setKf(target, "scale", lt, clamp(g.orig.kscale * k, 0.05, 10));
          else if (target.style) target.style.size = Math.round(clamp(g.orig.size * k, 12, 400));
          else target.scale = clamp(g.orig.scale * k, 0.05, 4);
        }
      }
      this.dirty = true;
    });
    const end = () => {
      if (this.gesture?.started) this.hooks.onChange();
      this.gesture = null;
      this.snapGuide = null;
      this.dirty = true;
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("dblclick", (e) => {
      const ids = Object.keys(this.boxes).reverse();
      const pt = this._toCanvas(e);
      const hit = ids.find((id) => { const b = this.boxes[id]; return pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h; });
      if (hit) this.hooks.onEditText?.(hit);
    });
  }
  _begin(e, id, mode, pt, box) {
    const p = this.hooks.project();
    const target = id === "captions" ? p.captions : this.hooks.clipById(id);
    if (!target) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.gesture = {
      id, mode, pt, box, started: false,
      orig: id === "captions" ? { posY: target.posY, size: target.size } : (() => {
        const lt = this.time() - target.start;
        return { x: kfValue(target, "x", lt, target.x ?? 0.5), y: kfValue(target, "y", lt, target.y ?? 0.3),
          scale: target.scale, kscale: kfValue(target, "scale", lt, target.style ? (target.scale ?? 1) : (target.scale ?? 0.6)),
          size: target.style ? target.style.size : target.size };
      })(),
    };
  }
}

// ---------------------------------------------------------------- colour adjustments
// SVG filters that mirror source_filters() in server.py exactly:
// per-channel gain (brightness x temperature) -> contrast around mid-grey -> saturate matrix.
const svgFilters = new Map();
let svgRoot = null;
export function adjFilter(adj) {
  if (!adj) return "none";
  const b = +adj.brightness || 0, c = +adj.contrast || 0, s = +adj.saturation || 0, t = +adj.temperature || 0;
  if (!b && !c && !s && !t) return "none";
  const key = [b, c, s, t].map((v) => v.toFixed(3)).join("_").replace(/[.-]/g, (m) => (m === "." ? "p" : "m"));
  if (!svgFilters.has(key)) {
    if (!svgRoot) {
      svgRoot = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svgRoot.setAttribute("width", "0"); svgRoot.setAttribute("height", "0");
      svgRoot.style.position = "absolute";
      document.body.append(svgRoot);
    }
    const k = 1 + b, cc = 1 + c, gr = 1 + 0.12 * t, gb = 1 - 0.12 * t;
    const f = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    f.setAttribute("id", "adj_" + key);
    f.setAttribute("color-interpolation-filters", "sRGB");
    f.innerHTML =
      `<feComponentTransfer><feFuncR type="linear" slope="${k * gr}"/><feFuncG type="linear" slope="${k}"/><feFuncB type="linear" slope="${k * gb}"/></feComponentTransfer>` +
      `<feComponentTransfer><feFuncR type="linear" slope="${cc}" intercept="${0.5 - 0.5 * cc}"/><feFuncG type="linear" slope="${cc}" intercept="${0.5 - 0.5 * cc}"/><feFuncB type="linear" slope="${cc}" intercept="${0.5 - 0.5 * cc}"/></feComponentTransfer>` +
      `<feColorMatrix type="saturate" values="${Math.max(0, 1 + s)}"/>`;
    svgRoot.append(f);
    svgFilters.set(key, `url(#adj_${key})`);
  }
  return svgFilters.get(key);
}

// ---------------------------------------------------------------- helpers
function ready(src) { return src instanceof HTMLImageElement ? src.complete && src.naturalWidth : src.readyState >= 2; }
function corners(b) { return [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]; }

// Length of the video: the last visual clip on any row (main, video or text).
// Audio past that point is cut, like CapCut.
export function endOfMain(p) {
  let e = 0;
  for (const tr of p.tracks) {
    if (tr.kind === "audio") continue;
    for (const c of tr.clips) e = Math.max(e, endOf(c, tr.kind));
  }
  return e;
}

// Clips can overlap during transitions: the later clip wins.
export function mainIndexAt(clips, t) {
  let lo = 0, hi = clips.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (clips[mid].start <= t + 1e-9) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best >= 0 && t < clips[best].start + durOf(clips[best], "main")) return best;
  return -1;
}

// Mirrors ffmpeg's xfade transitions (A = outgoing, B = incoming, p = 0..1).
export function drawTransition(ctx, type, p, W, H, drawA, drawB) {
  const clipRect = (x, y, w, h, fn) => { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); fn(); ctx.restore(); };
  const shifted = (dx, dy, fn) => { ctx.save(); ctx.translate(dx, dy); fn(); ctx.restore(); };
  switch (type) {
    case "fadeblack": case "fadewhite": {
      const col = type === "fadeblack" ? "0,0,0" : "255,255,255";
      if (p < 0.5) { drawA(); ctx.fillStyle = `rgba(${col},${p * 2})`; }
      else { drawB(); ctx.fillStyle = `rgba(${col},${(1 - p) * 2})`; }
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case "slideleft": shifted(-p * W, 0, drawA); shifted((1 - p) * W, 0, drawB); break;
    case "slideright": shifted(p * W, 0, drawA); shifted(-(1 - p) * W, 0, drawB); break;
    case "slideup": shifted(0, -p * H, drawA); shifted(0, (1 - p) * H, drawB); break;
    case "slidedown": shifted(0, p * H, drawA); shifted(0, -(1 - p) * H, drawB); break;
    case "wipeleft": drawA(); clipRect(W * (1 - p), 0, W * p, H, drawB); break;
    case "wiperight": drawA(); clipRect(0, 0, W * p, H, drawB); break;
    case "zoomin": {
      // ffmpeg: A zooms in during the first half, then cross-fades into B.
      const ss = (e0, e1, x) => { const k = clamp((x - e0) / (e1 - e0), 0, 1); return k * k * (3 - 2 * k); };
      const prog = 1 - p;
      const z = 1 / Math.max(ss(0.5, 1, prog), 0.02);
      drawB();
      ctx.save();
      ctx.globalAlpha = ss(0, 0.5, prog);
      ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2);
      drawA();
      ctx.restore();
      break;
    }
    case "circleopen": {
      drawA();
      ctx.save();
      ctx.beginPath(); ctx.arc(W / 2, H / 2, p * Math.hypot(W, H) / 2, 0, Math.PI * 2); ctx.clip();
      drawB();
      ctx.restore();
      break;
    }
    default: // fade / dissolve
      drawA();
      ctx.save(); ctx.globalAlpha = p; drawB(); ctx.restore();
  }
}

// Overlay transform at local time lt (keyframes win over static values).
export function overlayValues(o, lt) {
  return {
    ...o,
    x: kfValue(o, "x", lt, o.x ?? 0.5), y: kfValue(o, "y", lt, o.y ?? 0.5),
    scale: kfValue(o, "scale", lt, o.scale ?? 0.6), opacity: kfValue(o, "opacity", lt, o.opacity ?? 1),
    rotate: kfValue(o, "rotate", lt, o.rotate || 0),
  };
}

// Mirrors zoom_expr() in server.py
export function zoomAt(c, lt) {
  const d = durOf(c, "main");
  let z = c.zoomEnd == null ? c.zoom ?? 1 : c.zoom + (c.zoomEnd - c.zoom) * clamp(lt / Math.max(d, 0.01), 0, 1);
  z = kfValue(c, "zoom", lt, z);
  if (c.effect === "zoom") z *= 1 + 0.25 * Math.pow(Math.max(0, 1 - lt / 0.35), 2);
  return z;
}

// Mirrors overlay_clip_chain() in server.py
// Crop c.crop = {l, r, t, b} (fraction removed from each side) as a source rect. Mirrors crop_box() in server.py.
export function cropRect(c, sw, sh) {
  const k = (v) => clamp(+v || 0, 0, 0.45);
  const cr = c.crop || {}, l = k(cr.l), r = k(cr.r), t = k(cr.t), b = k(cr.b);
  if (!(l || r || t || b)) return { x: 0, y: 0, w: sw, h: sh };
  const ev = (v) => Math.floor(v / 2) * 2; // round down to even, like crop_box()
  return { x: ev(sw * l), y: ev(sh * t), w: Math.max(2, ev(sw * (1 - l - r))), h: Math.max(2, ev(sh * (1 - t - b))) };
}

export function overlayRect(o, m, W, H) {
  const sw = m.width || 1, sh = m.height || 1;
  const s = o.cover ? Math.max(W / sw, H / sh) : (o.scale ?? 0.6) * W / sw;
  const w = sw * s, h = sh * s;
  if (o.cover) return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  return { x: (o.x ?? 0.5) * W - w / 2, y: (o.y ?? 0.5) * H - h / 2, w, h };
}

export function fadeGain(o, lt) {
  const d = durOf(o, o.mid ? "video" : "text");
  let g = 1;
  if (o.fadeIn > 0) g *= clamp(lt / o.fadeIn, 0, 1);
  if (o.fadeOut > 0) g *= clamp((d - lt) / o.fadeOut, 0, 1);
  return g;
}
