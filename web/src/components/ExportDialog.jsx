import { useEffect, useState } from "react";
import { CheckCircle, FolderOpen, Copy, Warning, CircleNotch } from "@phosphor-icons/react";
import { api, fmt, fmtSize, sleep, FPS, emit, on, tildify } from "../core/util.js";
import { S, save, layer, words as tlWords } from "../core/store.js";
import * as M from "../core/model.js";
import { drawLayer, toSrt, clearLayoutCache } from "../core/layer.js";
import { endOfMain } from "../core/player.js";
import { Dialog, Button, Progress, Segmented } from "./ui/index.jsx";
import { DownloadSimple } from "@phosphor-icons/react";
import { toast } from "sonner";
import { celebrate } from "../lib/mascot.js";
import { smoothParams, alignSmoothCuts } from "../core/smooth.js";
import { deviceLayout, GRADIENTS } from "../core/device.js";

export function startExport() { emit("export"); }

// Yield to the UI without timers (setTimeout is heavily throttled in background tabs).
const yieldNow = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

// PNG of a canvas. toBlob is async and fast, but can stall in some browser states;
// fall back to the synchronous encoder instead of hanging the export.
async function canvasPng(c) {
  const viaBlob = new Promise((res) => c.toBlob((b) => res(b), "image/png"));
  const timeout = new Promise((res) => setTimeout(() => res(null), 4000));
  const b = await Promise.race([viaBlob, timeout]);
  if (b) return b;
  return await (await fetch(c.toDataURL("image/png"))).blob();
}

function buildSpec(opts) {
  const p = S.p;
  M.relayout(p);
  const fps = opts.fps;
  const k = opts.res === "720" ? 720 / Math.min(p.canvas.w, p.canvas.h) : 1;
  const total = Math.round(endOfMain(p) * fps) / fps;
  const main = M.mainTrack(p);
  const overlays = [], audio = [];
  for (const tr of p.tracks) {
    if (tr.kind === "video" && !tr.hidden) for (const c of tr.clips) {
      if (c.start >= total) continue;
      overlays.push({ ...c, dur: Math.min(M.durOf(c, "video"), total - c.start), mute: c.mute || !!tr.muted });
    }
    if (tr.kind === "audio" && !tr.muted) for (const c of tr.clips) {
      if (c.start >= total || c.mute) continue;
      audio.push({ ...c, dur: Math.min(M.durOf(c, "audio"), total - c.start) });
    }
  }
  const even = (x) => Math.round(x / 2) * 2;
  const dev = deviceLayout(p), [c0, c1] = GRADIENTS[p.frame?.gradient || 0] || GRADIENTS[0];
  const frame = dev && { x: even(dev.x * k), y: even(dev.y * k), mainW: even(dev.Ws * k), mainH: even(dev.Hs * k), radius: dev.r * k,
    bg: p.frame.bg || "blur", color: p.frame.color || "#1c1917", c0, c1 };
  return { W: even(p.canvas.w * k), H: even(p.canvas.h * k), scale: k, fps, quality: opts.quality, bg: p.canvas.bg, duration: total, frame,
    main: main.clips.map((c, i) => ({ ...c, mute: c.mute || !!main.muted, tdur: M.transDur(main.clips, i), smooth: smoothParams(p, main.clips, i) })),
    overlays, audio, audioOpts: p.audio, name: p.name };
}

const OPTS_KEY = "shorts.exportOpts";
const loadOpts = () => { try { return { fps: 30, res: "1080", quality: "high", ...JSON.parse(localStorage.getItem(OPTS_KEY) || "{}") }; } catch { return { fps: 30, res: "1080", quality: "high" }; } };

export default function ExportDialog() {
  const [st, setSt] = useState(null); // {phase, progress, msg, result, error}
  const [opts, setOpts] = useState(loadOpts);
  const [exportDir, setExportDir] = useState("");
  useEffect(() => { api("/api/config").then((c) => setExportDir(c.export_dir)).catch(() => {}); }, []);

  useEffect(() => on("export", () => { if (S.p) { toast.dismiss(); setSt({ phase: "settings" }); } }), []);
  const setOpt = (k, v) => { const o = { ...opts, [k]: v }; setOpts(o); try { localStorage.setItem(OPTS_KEY, JSON.stringify(o)); } catch { /* private mode */ } };

  async function run() {
    if (!S.p) return;
    await alignSmoothCuts(); // smooth cuts changed since they were measured
    const spec = buildSpec(opts);
    const fps = spec.fps;
    if (!spec.duration) { toast("The timeline is empty"); return; }
    S.player.pause();
    setSt({ phase: "Preparing", progress: 0, msg: "" });
    try {
      await save();
      await Promise.race([document.fonts.ready, sleep(2000)]);
      clearLayoutCache();
      const { job } = await api(`/api/projects/${S.p.id}/export/begin`, {});
      const N = Math.max(1, Math.round(spec.duration * fps));
      const { L } = layer(0);
      const hidden = new Set(S.p.tracks.filter((t) => t.kind === "text" && t.hidden).flatMap((t) => t.clips.map((c) => c.id)));
      const c = document.createElement("canvas");
      c.width = spec.W; c.height = spec.H;
      const ctx = c.getContext("2d");
      const keyToFile = new Map(), overlay = [], uploads = [];
      let prevKey = null, nextFile = 0;
      for (let f = 0; f < N; f++) {
        const s = layer(f / fps).st;
        if (hidden.size) s.tx = s.tx.filter(([id]) => !hidden.has(id));
        const key = JSON.stringify(s);
        if (key === prevKey) { overlay[overlay.length - 1].frames++; continue; }
        prevKey = key;
        let file = keyToFile.get(key);
        if (file === undefined) {
          file = nextFile++;
          keyToFile.set(key, file);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, spec.W, spec.H);
          ctx.setTransform(spec.W / L.W, 0, 0, spec.H / L.H, 0, 0);
          drawLayer(ctx, L, s, spec.W / L.W);
          const blob = await canvasPng(c);
          uploads.push(fetch(`/api/export/${job}/frame?i=${file}`, { method: "POST", body: blob }));
          if (uploads.length >= 6) await uploads.shift();
        }
        overlay.push({ file, frames: 1 });
        if (f % 20 === 0) { setSt({ phase: "Rendering text & captions", progress: f / N * 0.15, msg: `${f} / ${N} frames` }); await yieldNow(); }
      }
      await Promise.all(uploads);
      spec.overlay = overlay;
      spec.srt = S.p.captions.enabled ? toSrt(L.groups) : "";
      spec.text = tlWords().map((w) => w.text).join(" ");
      await api(`/api/export/${job}/start`, spec);
      const t0 = Date.now();
      for (;;) {
        const j = await api("/api/jobs/" + job);
        if (j.status === "error") throw new Error(j.error);
        const secs = Math.round((Date.now() - t0) / 1000);
        if (j.status === "done") {
          setSt({ phase: "done", progress: 1, result: j.result, secs });
          S.p.exports = [...(S.p.exports || []), j.result];
          emit("changed", {});
          return;
        }
        setSt({ phase: j.message || "Rendering", progress: 0.15 + j.progress * 0.85, msg: `${Math.round(j.progress * 100)}% · ${secs}s` });
        await sleep(500);
      }
    } catch (e) {
      setSt({ phase: "error", error: e.message });
    }
  }

  const open = !!st;
  const close = () => { if (["done", "error", "settings"].includes(st?.phase)) setSt(null); };
  const p = S.p;
  const estW = p ? (opts.res === "720" ? Math.round(p.canvas.w * 720 / Math.min(p.canvas.w, p.canvas.h)) : p.canvas.w) : 0;
  const estH = p ? (opts.res === "720" ? Math.round(p.canvas.h * 720 / Math.min(p.canvas.w, p.canvas.h)) : p.canvas.h) : 0;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}
      title={st?.phase === "settings" ? "Export video" : st?.phase === "done" ? <span className="flex items-center gap-2"><img src={celebrate} alt="" className="-my-3 h-12 w-auto" />Ready to post</span> : st?.phase === "error" ? "Export failed" : "Exporting"}
      description={st?.phase === "done" ? `${fmtSize(st.result.size)} · ${fmt(st.result.duration)} · rendered in ${st.secs}s` :
        st?.phase === "error" ? null : `${estW}×${estH} · ${opts.fps} fps · H.264 + AAC 320k${p?.audio?.normalize ? " · −14 LUFS" : ""}`}>
      {st?.phase === "settings" && (
        <div className="mt-4 space-y-1">
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">Saves to <b className="text-fg">{exportDir ? tildify(exportDir) : "your export folder"}/{p?.name}.mp4</b></div>
          <Segmented label="Frame rate" value={opts.fps} onChange={(v) => setOpt("fps", v)} options={[[30, "30 fps"], [60, "60 fps"]]} />
          <Segmented label="Resolution" value={opts.res} onChange={(v) => setOpt("res", v)} options={[["1080", "1080p"], ["720", "720p"]]} />
          <Segmented label="Quality" value={opts.quality} onChange={(v) => setOpt("quality", v)} options={[["high", "High"], ["max", "Maximum"], ["small", "Small"]]} />
          <div className="flex justify-end gap-2 pt-3">
            <Button variant="ghost" onClick={() => setSt(null)}>Cancel</Button>
            <Button variant="primary" onClick={run}><DownloadSimple size={15} />Export</Button>
          </div>
        </div>
      )}
      {st && !["done", "error", "settings"].includes(st.phase) && (
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-2 text-[13px]"><CircleNotch size={14} className="animate-spin text-accent" />{st.phase}<span className="flex-1" /><span className="font-mono text-xs text-subtle">{st.msg}</span></div>
          <Progress value={st.progress} />
        </div>
      )}
      {st?.phase === "done" && (
        <div className="mt-4">
          <video src={"/api/file?path=" + encodeURIComponent(st.result.path)} controls autoPlay className="max-h-[52vh] w-full rounded-xl bg-black" />
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] text-muted">
            <CheckCircle size={14} className="shrink-0 text-success" /><span className="truncate">{tildify(st.result.path)}</span>
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => api("/api/reveal", { path: st.result.path })}><FolderOpen size={14} />Show in folder</Button>
            <Button onClick={() => { navigator.clipboard.writeText(tlWords().map((w) => w.text).join(" ")); toast.success("Transcript copied"); }}><Copy size={14} />Copy transcript</Button>
            <span className="flex-1" />
            <Button variant="primary" onClick={() => setSt(null)}>Done</Button>
          </div>
        </div>
      )}
      {st?.phase === "error" && (
        <div className="mt-4">
          <div className="flex gap-2 rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs text-danger">
            <Warning size={15} className="shrink-0" />
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{st.error}</pre>
          </div>
          <div className="mt-4 flex justify-end"><Button onClick={() => setSt(null)}>Close</Button></div>
        </div>
      )}
    </Dialog>
  );
}
