import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipBack, SkipForward, DeviceMobile, FrameCorners, ArrowsOut } from "@phosphor-icons/react";
import { S, layer, select, begin, changed, clipById } from "../core/store.js";
import { Player, endOfMain } from "../core/player.js";
import { CAPTION_PRESETS } from "../core/layer.js";
import { fmt, emit, on, clamp } from "../core/util.js";
import { surfaceLevel } from "../core/clean.js";
import { deviceLayout } from "../core/device.js";
import { useBus } from "../lib/hooks.js";
import { IconBtn, Tip, Button, Popover } from "./ui/index.jsx";
import { jumpCut } from "./Editor.jsx";
import * as A from "../core/actions.js";
import * as M from "../core/model.js";
import { commit } from "../core/store.js";

export const timeListeners = new Set();

const RATIOS = [[1080, 1920, "9:16", "Reels, TikTok, Shorts"], [1080, 1350, "4:5", "Instagram feed"], [1080, 1080, "1:1", "Square"], [1920, 1080, "16:9", "YouTube"]];

// Switching between vertical and landscape moves captions to where that format expects them
// (lower third for 16:9), unless they were placed somewhere else by hand.
const LANDSCAPE_POS_Y = 0.84;
function setAspect(p, w, h) {
  const wasWide = p.canvas.w > p.canvas.h, wide = w > h;
  p.canvas.w = w; p.canvas.h = h;
  const cap = p.captions;
  if (!cap || wasWide === wide) return;
  const presetY = CAPTION_PRESETS[cap.preset]?.posY ?? 0.64;
  if (wide && Math.abs(cap.posY - presetY) < 0.02) cap.posY = LANDSCAPE_POS_Y;
  else if (!wide && Math.abs(cap.posY - LANDSCAPE_POS_Y) < 0.02) cap.posY = presetY;
}

// Draw a box on the preview for "Clean surface" (started from the Adjust tab with emit("pick-clean", clipId)).
function CleanPicker({ canvasRef, wrapRef }) {
  const [clipId, setClipId] = useState(null);
  const [box, setBox] = useState(null);
  useEffect(() => on("pick-clean", (id) => { setClipId(id); setBox(null); }), []);
  if (!clipId || !canvasRef.current) return null;
  const cr = canvasRef.current.getBoundingClientRect(), wr = wrapRef.current.getBoundingClientRect();
  // boxes are fractions of the main track's frame: the phone's screen when there is a phone frame
  const dev = deviceLayout(S.p), W = S.p.canvas.w, H = S.p.canvas.h;
  const sr = dev ? { left: cr.left + dev.x / W * cr.width, top: cr.top + dev.y / H * cr.height, width: dev.Ws / W * cr.width, height: dev.Hs / H * cr.height } : cr;
  const frac = (e) => [clamp((e.clientX - sr.left) / sr.width, 0, 1), clamp((e.clientY - sr.top) / sr.height, 0, 1)];
  const finish = () => {
    const c = M.find(S.p, clipId)?.clip;
    if (c && box && box.w > 0.02 && box.h > 0.02) {
      const cv = canvasRef.current, ctx = cv.getContext("2d");
      const ox = dev ? dev.x / W * cv.width : 0, oy = dev ? dev.y / H * cv.height : 0;
      const fw = dev ? dev.Ws / W * cv.width : cv.width, fh = dev ? dev.Hs / H * cv.height : cv.height;
      const level = surfaceLevel(ctx, ox + box.x * fw, oy + box.y * fh, box.w * fw, box.h * fh);
      commit(() => { c.clean = { strength: c.clean?.strength || 2, areas: [...(c.clean?.areas || []), { x: box.x, y: box.y, w: box.w, h: box.h, level }] }; }, null, { noTimeline: true });
    }
    setClipId(null); setBox(null);
  };
  return (
    <div className="absolute z-20 cursor-crosshair" style={{ left: sr.left - wr.left, top: sr.top - wr.top, width: sr.width, height: sr.height }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const [x, y] = frac(e); setBox({ x0: x, y0: y, x, y, w: 0, h: 0 }); }}
      onPointerMove={(e) => { if (!box) return; const [x, y] = frac(e); setBox({ ...box, x: Math.min(x, box.x0), y: Math.min(y, box.y0), w: Math.abs(x - box.x0), h: Math.abs(y - box.y0) }); }}
      onPointerUp={finish} onKeyDown={(e) => e.key === "Escape" && setClipId(null)}>
      <div className="pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded-md bg-black/70 px-2 py-1 text-xs text-white">Drag a box over the surface to clean · Esc to cancel</div>
      {box && <div className="pointer-events-none absolute border-2 border-dashed border-white" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }} />}
    </div>
  );
}

export default function Stage() {
  useBus(["changed"]);
  const canvasRef = useRef(), wrapRef = useRef(), timeRef = useRef(), totalRef = useRef();
  const [playing, setPlaying] = useState(false);
  const [guides, setGuides] = useState(false);

  useEffect(() => {
    const player = new Player(canvasRef.current, {
      project: () => S.p,
      layer: (t) => layer(t),
      selected: () => S.sel,
      clipById,
      onTime: (t) => {
        S.timeline?.setTime(t);
        if (timeRef.current) timeRef.current.textContent = fmt(t, true);
        for (const f of timeListeners) f(t);
      },
      onSelect: (id, add) => select(id ? [id] : [], add ? "toggle" : undefined),
      onBegin: () => begin("canvas-gesture"),
      onChange: () => changed({ noTimeline: true }),
      onEditText: (id) => { select([id]); setTimeout(() => emit("edit-text", id), 30); },
      onPlayState: (pl) => setPlaying(pl),
    });
    S.player = player;
    player.resize();
    const ro = new ResizeObserver(() => player.resize());
    ro.observe(wrapRef.current);
    return () => { ro.disconnect(); player.pause(); player.destroy(); if (S.player === player) S.player = null; };
  }, []);

  useEffect(() => { if (totalRef.current && S.p) totalRef.current.textContent = fmt(endOfMain(S.p), true); });

  const empty = !M.mainTrack(S.p).clips.length;
  const ratio = RATIOS.find(([w, h]) => w === S.p.canvas.w && h === S.p.canvas.h) || RATIOS[0];

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-stage">
      <div ref={wrapRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <canvas ref={canvasRef} className="rounded-lg bg-black touch-none" />
        <CleanPicker canvasRef={canvasRef} wrapRef={wrapRef} />
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-lg bg-surface/90 px-5 py-3 text-center text-xs text-muted">
              Add a video from <b className="text-fg">Media</b> on the left<br />or drop files onto the timeline
            </div>
          </div>
        )}
      </div>
      <div className="flex h-12 shrink-0 items-center border-t border-line bg-surface px-3">
        <div className="flex w-56 items-baseline gap-1.5 font-mono text-xs tabular-nums">
          <span ref={timeRef} className="text-fg">00:00:00</span>
          <span className="text-subtle">/</span>
          <span ref={totalRef} className="text-subtle">00:00:00</span>
        </div>
        <div className="flex flex-1 items-center justify-center gap-1">
          <IconBtn icon={SkipBack} label="Previous cut" kbd="↑" onClick={() => jumpCut(-1)} />
          <Tip label={playing ? "Pause" : "Play"} kbd="Space">
            <button onClick={() => S.player.toggle()}
              className="mx-1 flex h-9 w-9 items-center justify-center rounded-full bg-fg text-surface transition-colors hover:bg-fg/85 cursor-pointer">
              {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" className="ml-0.5" />}
            </button>
          </Tip>
          <IconBtn icon={SkipForward} label="Next cut" kbd="↓" onClick={() => jumpCut(1)} />
        </div>
        <div className="flex w-56 items-center justify-end gap-1">
          <Popover side="top" align="end" trigger={
            <Button variant="ghost" size="sm"><DeviceMobile size={14} />{ratio[2]}</Button>
          }>
            <div className="w-56">
              <div className="mb-2 text-xs font-medium text-muted">Canvas size</div>
              {RATIOS.map(([w, h, l, d]) => (
                <button key={l} onClick={() => { commit(() => setAspect(S.p, w, h)); S.player.resize(); }}
                  className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-4 cursor-pointer ${ratio[2] === l ? "text-accent" : ""}`}>
                  <span className="flex h-7 w-7 items-center justify-center">
                    <span className="rounded-[3px] border-2 border-current" style={{ width: w > h ? 22 : 22 * w / h, height: h > w ? 22 : 22 * h / w }} />
                  </span>
                  <span><span className="block text-[13px] font-medium">{l}</span><span className="block text-[11px] text-subtle">{d}</span></span>
                </button>
              ))}
            </div>
          </Popover>
          {S.p.canvas.h > S.p.canvas.w && <IconBtn icon={FrameCorners} label={guides ? "Hide safe zones" : "Show where app buttons cover the video"} active={guides}
            onClick={() => { S.player.guides = !guides; setGuides(!guides); S.player.invalidate(); }} />}
          <IconBtn icon={ArrowsOut} label="Bigger preview" kbd={"\\"} onClick={() => emit("toggle-panels")} />
        </div>
      </div>
    </section>
  );
}
