// Multi-track timeline (DOM). Rows: visual tracks (top layer first), the
// magnetic main track, then audio tracks. Trim handles, drag to move/reorder,
// snapping, ruler scrubbing, Ctrl+wheel zoom, drag & drop from the media bin.
import { $, el, clamp, fmt, FPS, on } from "./util.js";
import { durOf, endOf, mainTrack, trimClip, moveClip, moveMain, find, newTrack, relayout, transDur,
  moveMainTo, mainToOverlay, overlayToMain } from "./model.js";
import { kfTimes } from "./kf.js";
import * as Media from "./media.js";
import { icon } from "./icons.js";

const HEAD = 150;
const ROW_H = { text: 34, video: 52, main: 72, audio: 46, ghost: 26 };
const SNAP_PX = 8;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
// theme colors used by canvas drawing (refreshed on every full render)
let COLORS = null;
const colors = () => (COLORS = COLORS || { ruler: cssVar("--ruler-ink"), waveBg: cssVar("--wave-bg"), wave: cssVar("--wave-fg"), waveAudio: cssVar("--wave-audio"), marker: "#f59e0b" });

export class Timeline {
  constructor(root, hooks) {
    this.root = root;
    this.h = hooks;
    this.pps = 60;
    this.snap = true;
    this.scroll = $(".tl-scroll", root);
    this.content = $(".tl-content", root);
    this.rowsEl = $(".tl-rows", root);
    this.ruler = $(".tl-ruler canvas", root);
    this.playhead = $(".tl-playhead", root);
    this.snapLine = $(".tl-snapline", root);
    this.insertLine = $(".tl-insert", root);
    this.clipEls = new Map();
    this.gesture = null;
    this._bind();
    this.offs = [on("assets", () => this.repaintAll()), on("media", () => this.repaintAll())];
    this.ro = new ResizeObserver(() => this.drawRuler());
    this.ro.observe(this.scroll);
  }

  destroy() {
    this.offs.forEach((off) => off());
    this.ro.disconnect();
  }

  // Clip box with a small gap on each side so every cut is visible.
  box(start, dur) {
    const w = dur * this.pps;
    const gap = w > 8 ? 1 : 0;
    return { left: start * this.pps + gap + "px", width: Math.max(2, w - gap * 2) + "px" };
  }

  // ------------------------------------------------------------ geometry
  x(t) { return HEAD + t * this.pps; }
  tAt(clientX) {
    const r = this.scroll.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + this.scroll.scrollLeft - HEAD) / this.pps);
  }
  visibleWidth() { return this.scroll.clientWidth - HEAD; }
  fit() {
    const p = this.h.project();
    const total = Math.max(5, this.totalLen(p));
    this.pps = clamp((this.visibleWidth() - 40) / total, 2, 400);
    this.render();
  }
  // Zoom keeps the playhead where it is on screen (if it's off screen, it's brought to the
  // middle). Several zoom events in one frame are merged into a single redraw.
  zoomTo(pps) {
    pps = clamp(pps, 2, 400);
    if (!this.zoomAnchor) {
      const t = this.h.time();
      const vis = this.scroll.clientWidth;
      let off = this.x(t) - this.scroll.scrollLeft;
      if (off < HEAD + 8 || off > vis - 8) off = HEAD + (vis - HEAD) / 2;
      this.zoomAnchor = { t, off };
    }
    this.pps = pps;
    if (this.zoomRaf) return;
    this.zoomRaf = requestAnimationFrame(() => {
      this.zoomRaf = 0;
      const { t, off } = this.zoomAnchor;
      this.zoomAnchor = null;
      this.render();
      this.scroll.scrollLeft = Math.max(0, this.x(t) - off);
      this.drawRuler();
      this.h.onZoom?.(this.pps);
    });
  }
  zoomBy(k) { this.zoomTo(this.pps * k); }
  totalLen(p) {
    let e = 0;
    for (const tr of p.tracks) for (const c of tr.clips) e = Math.max(e, endOf(c, tr.kind));
    return e;
  }

  rowsOrder(p) {
    const visual = p.tracks.filter((t) => t.kind === "video" || t.kind === "text").reverse();
    return [...visual, mainTrack(p), ...p.tracks.filter((t) => t.kind === "audio")];
  }

  // ------------------------------------------------------------ render
  render() {
    const p = this.h.project();
    if (!p) return;
    COLORS = null;
    relayout(p);
    const total = this.totalLen(p);
    const width = HEAD + Math.max(total + 30, this.visibleWidth() / this.pps + 5) * this.pps;
    this.content.style.width = width + "px";
    this.rowsEl.innerHTML = "";
    this.clipEls.clear();
    const sel = this.h.selected();
    let mEnd = 0;  // video length = last visual clip on any row
    for (const x of p.tracks) if (x.kind !== "audio") for (const c of x.clips) mEnd = Math.max(mEnd, endOf(c, x.kind));
    const ghost = (where, label) => {
      const row = el("div", { class: "tl-row tl-ghost", dataset: { ghost: where }, style: { height: ROW_H.ghost + "px" } },
        el("div", { class: "tl-head" }),
        el("div", { class: "tl-lane" }, el("span", {}, icon("plus", 12), label)));
      this.rowsEl.append(row);
    };
    ghost("top", "Drop here for a new layer (video, image or text)");
    for (const tr of this.rowsOrder(p)) {
      const row = el("div", { class: `tl-row kind-${tr.kind}`, dataset: { track: tr.id }, style: { height: ROW_H[tr.kind] + "px" } });
      const ico = { main: "film", video: "layers", text: "type", audio: "music" }[tr.kind];
      const head = el("div", { class: "tl-head" },
        el("span", { class: "tl-icon" }, icon(ico, 14)),
        el("span", { class: "tl-name", title: tr.kind === "main" ? "Main track" : "Double-click to rename",
          ondblclick: () => tr.kind !== "main" && this.h.trackMenu(null, tr.id, "rename") }, tr.kind === "main" ? "Main" : tr.name || tr.kind),
        tr.kind !== "audio" ? el("button", { class: "tl-tog" + (tr.hidden ? " off" : ""), title: tr.hidden ? "Show track" : "Hide track", onclick: () => this.h.toggleTrack(tr.id, "hidden") }, icon(tr.hidden ? "eyeOff" : "eye", 14)) : null,
        tr.kind !== "text" ? el("button", { class: "tl-tog" + (tr.muted ? " off" : ""), title: tr.muted ? "Unmute track" : "Mute track", onclick: () => this.h.toggleTrack(tr.id, "muted") }, icon(tr.muted ? "volumeX" : "volume", 14)) : null,
        tr.kind !== "main" ? el("button", { class: "tl-tog", title: "Track options", onclick: (e) => this.h.trackMenu(e, tr.id) }, icon("more", 14)) : null);
      const lane = el("div", { class: "tl-lane" });
      if (tr.kind === "audio" && mEnd > 0) lane.append(el("div", { class: "tl-past-end", style: { left: mEnd * this.pps + "px" } }));
      for (const c of tr.clips) {
        const ce = this._clipEl(c, tr, sel.has(c.id));
        lane.append(ce);
        this.clipEls.set(c.id, ce);
      }
      if (tr.kind === "main") {
        // empty space between clips (magnet off): shown, with a one-click close
        let prevEnd = 0;
        for (const c of tr.clips) {
          if (c.start - prevEnd > 1 / FPS) {
            lane.append(el("div", { class: "tl-gap", style: { left: prevEnd * this.pps + "px", width: (c.start - prevEnd) * this.pps + "px" } },
              (c.start - prevEnd) * this.pps > 70 ? el("button", { title: "Remove this empty space", onpointerdown: (e) => e.stopPropagation(),
                onclick: (e) => { e.stopPropagation(); this.h.closeGap(c.id); } }, icon("x", 10), "Close gap") : null));
          }
          prevEnd = Math.max(prevEnd, endOf(c, "main"));
        }
        // transition buttons on every cut
        tr.clips.forEach((c, i) => {
          if (!i || (c.gap || 0) > 1e-6) return; // transitions only between clips that touch
          const d = transDur(tr.clips, i);
          const has = d > 0;
          const b = el("button", {
            class: "tl-trans" + (has ? " on" : ""), title: has ? `Transition: ${c.trans.type} (${d.toFixed(2)}s)` : "Add a transition",
            style: { left: (c.start + d / 2) * this.pps + "px", width: Math.max(18, d * this.pps) + "px" },
            onpointerdown: (e) => e.stopPropagation(),
            onclick: (e) => { e.stopPropagation(); this.h.openTransition(c.id); },
          }, icon(has ? "split" : "plus", 11));
          lane.append(b);
        });
        if (!tr.clips.length) lane.append(el("div", { class: "tl-empty" }, "Drag videos or photos here to start"));
      }
      if (tr.kind !== "main" && !tr.clips.length) lane.append(el("div", { class: "tl-empty small" }, el("span", {}, "Drag clips here")));
      row.append(head, lane);
      this.rowsEl.append(row);
    }
    ghost("bottom", "Drop audio here for a new audio track");
    this.drawRuler();
    this.setTime(this.h.time());
  }

  _clipEl(c, tr, selected) {
    const kind = tr.kind;
    const d = durOf(c, kind);
    const m = c.mid ? Media.meta(c.mid) : null;
    const ce = el("div", {
      class: `tl-clip k-${kind}${m ? " m-" + m.kind : ""}${selected ? " sel" : ""}${c.mute ? " muted" : ""}`,
      dataset: { id: c.id },
      style: this.box(c.start, d),
    });
    if (kind === "text") {
      const label = c.shape ? { rect: "Box", circle: "Circle", arrow: "Arrow", underline: "Underline" }[c.shape] : c.text.replace(/\n/g, " ");
      ce.append(el("span", { class: "tl-label" }, icon(c.shape ? "focus" : "type", 12), el("span", {}, label)));
    } else {
      const cv = el("canvas", { class: "tl-film" });
      ce.append(cv);
      ce._cv = cv;
      const badges = [];
      if ((c.speed || 1) !== 1) badges.push(c.speed + "×");
      if (c.effect && c.effect !== "none") badges.push({ zoom: "Zoom in", flash: "Flash", fade: "Fade in" }[c.effect] || "");
      if (c.zoomEnd != null) badges.push("Slow zoom");
      if (c.adj && Object.values(c.adj).some((v) => v)) badges.push("Adjusted");
      if (c.mute) badges.push("Muted");
      if (c.phone) badges.push("Phone");
      if (kind === "audio" && c.duck) badges.push("Ducking");
      const name = m ? m.name : "Missing media";
      const wpx = d * this.pps;
      if (wpx > 46) ce.append(el("span", { class: "tl-label" }, ...badges.map((b) => el("b", { class: "tl-badge" }, b)), wpx > 90 ? el("span", {}, name) : null));
      if (wpx > 60) ce.append(el("span", { class: "tl-dur" }, d < 60 ? d.toFixed(1) + "s" : fmt(d).replace(/\.\d$/, "")));
      requestAnimationFrame(() => this._paint(ce, c, tr));
    }
    if (selected) {
      for (const t of kfTimes(c)) ce.append(el("i", { class: "tl-kf", style: { left: t * this.pps - 4 + "px" }, title: "Keyframe" }));
    }
    ce.append(el("div", { class: "tl-h l" }), el("div", { class: "tl-h r" }));
    return ce;
  }

  repaintAll() {
    const p = this.h.project();
    if (!p) return;
    for (const tr of p.tracks) for (const c of tr.clips) {
      const ce = this.clipEls.get(c.id);
      if (ce && ce._cv) this._paint(ce, c, tr);
    }
  }

  _paint(ce, c, tr) {
    const cv = ce._cv;
    if (!cv || !ce.isConnected) return;
    const kind = tr.kind;
    const wpx = Math.max(2, durOf(c, kind) * this.pps); // CSS px
    const hpx = ROW_H[kind] - 2;
    // Draw at screen density (sharp on HiDPI); cap the canvas size for memory.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const CW = Math.min(8192, Math.ceil(wpx * dpr)), CH = Math.round(hpx * dpr);
    if (cv.width !== CW) cv.width = CW;
    if (cv.height !== CH) cv.height = CH;
    const kx = CW / wpx, ky = CH / hpx; // device px per CSS px
    const ctx = cv.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, CW, CH);
    ctx.imageSmoothingQuality = "high";
    const m = Media.meta(c.mid);
    if (!m) return;
    const sp = c.speed || 1;
    const filmH = (kind === "main" && m.has_audio ? hpx - 20 : hpx) * ky;
    const tAt = (X) => c.in + (X / kx / this.pps) * sp; // source time at device x
    if (m.kind === "video" && kind !== "audio") {
      const s = Media.getSprite(c.mid);
      if (s) {
        const cols = s.cols || s.n;
        const tw = s.tw * filmH / s.th;
        for (let X = 0; X < CW; X += tw) {
          const idx = clamp(Math.round(tAt(X + tw / 2) / s.step - 0.5), 0, s.n - 1);
          ctx.drawImage(s.img, (idx % cols) * s.tw, Math.floor(idx / cols) * s.th, s.tw, s.th, Math.round(X), 0, Math.ceil(tw), filmH);
        }
      }
    } else if (m.kind === "image") {
      const img = new Image();
      img.src = Media.previewUrl(c.mid);
      const drawImg = () => {
        const tw = img.naturalWidth / img.naturalHeight * filmH;
        for (let X = 0; X < CW; X += tw) ctx.drawImage(img, X, 0, tw, filmH);
      };
      if (img.complete && img.naturalWidth) drawImg(); else img.onload = drawImg;
    }
    if (m.has_audio && (kind === "main" || kind === "audio" || kind === "video")) {
      const pk = Media.getPeaks(c.mid);
      if (pk) {
        const top = (kind === "audio" ? 0 : kind === "main" ? hpx - 20 : hpx - 16) * ky;
        const hh = (kind === "audio" ? hpx : kind === "main" ? 20 : 16) * ky;
        if (kind !== "audio") { ctx.fillStyle = colors().waveBg; ctx.fillRect(0, top, CW, hh); }
        ctx.fillStyle = kind === "audio" ? colors().waveAudio : colors().wave;
        const mid = top + hh / 2;
        const n = pk.peaks.length;
        const step = Math.max(1, Math.round(kx)); // one bar per CSS px, drawn in device px
        for (let X = 0; X < CW; X += step) {
          const a = Math.floor(tAt(X) * pk.rate), b = Math.max(a + 1, Math.floor(tAt(X + step) * pk.rate));
          let mx = 0;
          for (let i = a; i < b && i < n; i++) mx = Math.max(mx, pk.peaks[i]);
          const h = Math.max(0.6 * ky, Math.sqrt(mx) * (hh / 2 - ky) * Math.min(1.5, c.volume ?? 1));
          ctx.fillRect(X, mid - h, Math.max(1, step - (step > 1 ? 1 : 0)), h * 2);
        }
      }
    }
  }

  // Cheap update during drags: move/resize clip elements without repainting.
  layoutOnly() {
    const p = this.h.project();
    relayout(p);
    for (const tr of p.tracks) for (const c of tr.clips) {
      const ce = this.clipEls.get(c.id);
      if (!ce) continue;
      Object.assign(ce.style, this.box(c.start, durOf(c, tr.kind)));
    }
  }

  updateSelection() {
    const sel = this.h.selected();
    const p = this.h.project();
    const needs = p && [...sel, ...this._lastSel || []].some((id) => { const f = find(p, id); return f && kfTimes(f.clip).length; });
    this._lastSel = [...sel];
    if (needs) { this.render(); return; }
    for (const [id, ce] of this.clipEls) ce.classList.toggle("sel", sel.has(id));
  }

  setTime(t) {
    const x = this.x(t);
    this.playhead.style.transform = `translateX(${x}px)`;
    if (this.h.playing() && !this.gesture) {
      const sl = this.scroll.scrollLeft, vw = this.scroll.clientWidth;
      if (x > sl + vw - 60 || x < sl + HEAD) this.scroll.scrollLeft = x - HEAD - 40;
    }
  }

  drawRuler() {
    const cv = this.ruler;
    const w = this.scroll.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = 24 * dpr;
    cv.style.width = w + "px"; cv.style.height = "24px";
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, 24);
    const sl = this.scroll.scrollLeft;
    const steps = [1 / FPS, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];
    const major = steps.find((s) => s * this.pps >= 80) || 600;
    const minor = steps.slice().reverse().find((s) => s < major && s * this.pps >= 10) || major;
    const t0 = Math.max(0, (sl - HEAD) / this.pps), t1 = (sl + w) / this.pps;
    ctx.fillStyle = colors().ruler; ctx.font = "10px Inter, sans-serif";
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = HEAD + t * this.pps - sl;
      if (x < HEAD - 1) continue;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.fillRect(x, isMajor ? 12 : 18, 1, isMajor ? 12 : 6);
      if (isMajor) ctx.fillText(major < 1 ? fmt(t, true) : fmt(t).replace(/\.\d$/, ""), x + 3, 10);
    }
    // markers (M)
    ctx.fillStyle = colors().marker;
    for (const mk of this.h.project()?.markers || []) {
      const x = HEAD + mk.t * this.pps - sl;
      if (x < HEAD || x > w) continue;
      ctx.beginPath(); ctx.moveTo(x - 5, 13); ctx.lineTo(x + 5, 13); ctx.lineTo(x, 22); ctx.closePath(); ctx.fill();
    }
    // keep the ruler pinned while scrolling horizontally
    cv.style.transform = `translateX(${sl}px)`;
  }

  // ------------------------------------------------------------ snapping
  snapPoints(excludeIds) {
    const p = this.h.project();
    const pts = [0, this.h.time()];
    for (const tr of p.tracks) for (const c of tr.clips) {
      if (excludeIds.has(c.id)) continue;
      pts.push(c.start, endOf(c, tr.kind));
    }
    for (const m of p.markers || []) pts.push(m.t);
    return pts;
  }
  snapT(t, pts) {
    if (!this.snap) return { t, hit: null };
    let best = null, bd = SNAP_PX / this.pps;
    for (const q of pts) { const d = Math.abs(q - t); if (d < bd) { bd = d; best = q; } }
    return best == null ? { t, hit: null } : { t: best, hit: best };
  }
  showSnap(t) {
    if (t == null) { this.snapLine.style.display = "none"; return; }
    this.snapLine.style.display = "block";
    this.snapLine.style.transform = `translateX(${this.x(t)}px)`;
  }

  // ------------------------------------------------------------ interactions
  _rowAt(clientY) {
    for (const row of this.rowsEl.children) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return row;
    }
    return null;
  }

  _bind() {
    const sc = this.scroll;
    sc.addEventListener("scroll", () => this.drawRuler());
    sc.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+wheel / trackpad pinch: smooth, proportional, anchored on the playhead
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0025;
        this.zoomTo(this.pps * Math.exp(-clamp(e.deltaY, -300, 300) * unit));
      }
      else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.rowsEl.scrollHeight <= sc.clientHeight + 30) {
        e.preventDefault(); sc.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    sc.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".tl-head")) return;
      const clipEl = e.target.closest(".tl-clip");
      const t = this.tAt(e.clientX);
      if (!clipEl) {
        // ruler / empty space: seek + scrub
        if (!e.shiftKey) this.h.select([]);
        this.h.seek(t);
        this.gesture = { kind: "scrub" };
        sc.setPointerCapture(e.pointerId);
        return;
      }
      const id = clipEl.dataset.id;
      const p = this.h.project();
      const f = find(p, id);
      if (!f) return;
      if (e.shiftKey || e.ctrlKey) this.h.select([id], "toggle");
      else if (!this.h.selected().has(id)) this.h.select([id]);
      const edge = e.target.classList.contains("tl-h") ? (e.target.classList.contains("l") ? "l" : "r") : null;
      this.gesture = {
        kind: edge ? "trim" : (f.track.kind === "main" ? "mainmove" : "move"),
        id, edge, x0: e.clientX, y0: e.clientY, t0: t, started: false,
        orig: { start: f.clip.start, end: endOf(f.clip, f.track.kind) }, track: f.track,
        pts: this.snapPoints(new Set([id])),
      };
      sc.setPointerCapture(e.pointerId);
    });

    sc.addEventListener("pointermove", (e) => {
      const g = this.gesture;
      if (!g) return;
      const p = this.h.project();
      const t = this.tAt(e.clientX);
      if (g.kind === "scrub") { this.h.seek(t); return; }
      if (!g.started) {
        if (Math.abs(e.clientX - g.x0) < 4 && Math.abs(e.clientY - g.y0) < 4) return;
        g.started = true;
        this.h.begin();
      }
      if (g.kind === "trim") {
        const f = find(p, g.id);
        if (!f) return;
        const s = this.snapT(t, g.pts);
        this.showSnap(s.hit);
        trimClip(p, g.id, g.edge, s.t, f.clip.mid ? Media.meta(f.clip.mid) : null);
        this.layoutOnly();
        this.h.preview();
      } else if (g.kind === "move") {
        const f = find(p, g.id);
        const dur = g.orig.end - g.orig.start;
        let ns = Math.max(0, g.orig.start + (t - g.t0));
        const a = this.snapT(ns, g.pts), b = this.snapT(ns + dur, g.pts);
        if (a.hit != null && (b.hit == null || Math.abs(a.t - ns) <= Math.abs(b.t - ns - dur))) { ns = a.t; this.showSnap(a.hit); }
        else if (b.hit != null) { ns = b.t - dur; this.showSnap(b.hit); }
        else this.showSnap(null);
        f.clip.start = Math.max(0, ns);
        const ce = this.clipEls.get(g.id);
        ce.style.left = this.box(f.clip.start, dur).left;
        // vertical: target row of the same kind
        const row = this._rowAt(e.clientY);
        const rowTrack = row && p.tracks.find((x) => x.id === row.dataset.track);
        g.toTrack = rowTrack && rowTrack.kind === f.track.kind ? rowTrack.id : null;
        g.toMain = !!(rowTrack && rowTrack.kind === "main" && f.track.kind === "video");
        const gh = row?.dataset.ghost;
        g.newTrack = (gh === "top" && f.track.kind !== "audio") || (gh === "bottom" && f.track.kind === "audio");
        const target = (g.toTrack && g.toTrack !== f.track.id) || g.toMain || g.newTrack ? row : null;
        const dy = target ? target.getBoundingClientRect().top - ce.parentElement.getBoundingClientRect().top : 0;
        ce.style.transform = `translateY(${dy}px)`;
        this._markRow(target);
        this.h.preview();
      } else if (g.kind === "mainmove") {
        const dur = g.orig.end - g.orig.start;
        let ns = Math.max(0, g.orig.start + (t - g.t0));
        const a = this.snapT(ns, g.pts), b = this.snapT(ns + dur, g.pts);
        if (a.hit != null && (b.hit == null || Math.abs(a.t - ns) <= Math.abs(b.t - ns - dur))) { ns = a.t; this.showSnap(a.hit); }
        else if (b.hit != null) { ns = b.t - dur; this.showSnap(b.hit); }
        else this.showSnap(null);
        g.S = Math.max(0, ns);
        const ce = this.clipEls.get(g.id);
        const row = this._rowAt(e.clientY);
        const rowTrack = row && p.tracks.find((x) => x.id === row.dataset.track);
        // up onto a video row / the "new layer" lane -> becomes an overlay
        g.toOverlay = rowTrack?.kind === "video" ? rowTrack.id : row?.dataset.ghost === "top" ? "new" : null;
        const dy = g.toOverlay ? row.getBoundingClientRect().top - ce.parentElement.getBoundingClientRect().top : 0;
        this._markRow(g.toOverlay ? row : null);
        const clips = mainTrack(p).clips;
        if (!g.toOverlay && p.magnet) {
          let idx = clips.length;
          for (let i = 0; i < clips.length; i++) if (t < clips[i].start + durOf(clips[i], "main") / 2) { idx = i; break; }
          g.toIndex = idx;
          const bx = idx < clips.length ? clips[idx].start : endOf(clips.at(-1), "main");
          this.insertLine.style.display = "block";
          this.insertLine.style.transform = `translateX(${this.x(bx)}px)`;
        } else this.insertLine.style.display = "none";
        // free placement: clips in the way get pushed right (show where it lands)
        if (!g.toOverlay && !p.magnet) {
          this.insertLine.style.display = "block";
          this.insertLine.style.transform = `translateX(${this.x(g.S)}px)`;
        }
        ce.style.transform = `translate(${(g.S - g.orig.start) * this.pps}px, ${dy}px)`;
        ce.classList.add("dragging");
      }
    });

        const end = (e) => {
      const g = this.gesture;
      this.gesture = null;
      this.showSnap(null);
      this.insertLine.style.display = "none";
      if (!g || g.kind === "scrub") return;
      if (!g.started) {
        // plain click on a clip: seek there (CapCut keeps the playhead) — no-op
        return;
      }
      const p = this.h.project();
      this._markRow(null);
      if (g.kind === "move") {
        const f = find(p, g.id);
        if (g.toMain) {
          overlayToMain(p, g.id, f.clip.start);
        } else {
          let to = g.toTrack;
          if (g.newTrack) to = newTrack(p, f.track.kind).id;
          moveClip(p, g.id, f.clip.start, to);
          // overlapping on the target track? push to a free (or new) track
          const f2 = find(p, g.id);
          const clash = f2.track.clips.some((c) => c.id !== g.id && c.start < endOf(f2.clip, f2.track.kind) - 1e-6 && endOf(c, f2.track.kind) > f2.clip.start + 1e-6);
          if (clash) moveClip(p, g.id, f2.clip.start, (this._freeTrack(p, f2) || newTrack(p, f2.track.kind)).id);
        }
      } else if (g.kind === "mainmove") {
        if (g.toOverlay) mainToOverlay(p, g.id, g.toOverlay === "new" ? null : g.toOverlay, g.S);
        else if (p.magnet) { if (g.toIndex != null) moveMain(p, g.id, g.toIndex); }
        else moveMainTo(p, g.id, g.S);
      }
      this.h.change();
    };
    sc.addEventListener("pointerup", end);
    sc.addEventListener("pointercancel", end);

    sc.addEventListener("contextmenu", (e) => {
      const clipEl = e.target.closest(".tl-clip");
      if (!clipEl) return;
      e.preventDefault();
      if (!this.h.selected().has(clipEl.dataset.id)) this.h.select([clipEl.dataset.id]);
      this.h.contextMenu(e, clipEl.dataset.id);
    });

    // drag & drop from the media bin or the file manager
    sc.addEventListener("dragover", (e) => {
      e.preventDefault();
      const t = this.tAt(e.clientX);
      this.insertLine.style.display = "block";
      this.insertLine.style.transform = `translateX(${this.x(t)}px)`;
    });
    sc.addEventListener("dragleave", () => { this.insertLine.style.display = "none"; });
    sc.addEventListener("drop", (e) => {
      e.preventDefault();
      this.insertLine.style.display = "none";
      const t = this.tAt(e.clientX);
      const row = this._rowAt(e.clientY);
      const p = this.h.project();
      const tr = row ? p.tracks.find((x) => x.id === row.dataset.track) : null;
      const gh = row?.dataset.ghost;
      // target: {kind, trackId?, newTrack?}
      const target = tr ? { kind: tr.kind, trackId: tr.id } : gh === "top" ? { kind: "video", newTrack: true }
        : gh === "bottom" ? { kind: "audio", newTrack: true } : { kind: "main" };
      const mid = e.dataTransfer.getData("text/x-mid");
      const path = e.dataTransfer.getData("text/x-path");
      if (mid) this.h.dropMedia(mid, t, target);
      else if (path) this.h.dropPath(path, t, target);
      else if (e.dataTransfer.files.length) this.h.dropFiles([...e.dataTransfer.files], t, target);
    });
  }

  _markRow(row) {
    if (this._marked && this._marked !== row) this._marked.classList.remove("drop-target");
    if (row) row.classList.add("drop-target");
    this._marked = row;
  }

  _freeTrack(p, f) {
    const s = f.clip.start, e = endOf(f.clip, f.track.kind);
    return p.tracks.filter((t) => t.kind === f.track.kind && t.id !== f.track.id)
      .find((t) => t.clips.every((c) => endOf(c, t.kind) <= s + 1e-6 || c.start >= e - 1e-6));
  }
}
