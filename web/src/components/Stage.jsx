import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipBack, SkipForward, DeviceMobile, FrameCorners } from "@phosphor-icons/react";
import { S, layer, select, begin, changed, clipById } from "../core/store.js";
import { Player, endOfMain } from "../core/player.js";
import { fmt, emit } from "../core/util.js";
import { useBus } from "../lib/hooks.js";
import { IconBtn, Tip, Button, Popover } from "./ui/index.jsx";
import { jumpCut } from "./Editor.jsx";
import * as A from "../core/actions.js";
import * as M from "../core/model.js";
import { commit } from "../core/store.js";

export const timeListeners = new Set();

const RATIOS = [[1080, 1920, "9:16", "Reels, TikTok, Shorts"], [1080, 1350, "4:5", "Instagram feed"], [1080, 1080, "1:1", "Square"], [1920, 1080, "16:9", "YouTube"]];

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
                <button key={l} onClick={() => { commit(() => { S.p.canvas.w = w; S.p.canvas.h = h; }); S.player.resize(); }}
                  className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-4 cursor-pointer ${ratio[2] === l ? "text-accent" : ""}`}>
                  <span className="flex h-7 w-7 items-center justify-center">
                    <span className="rounded-[3px] border-2 border-current" style={{ width: w > h ? 22 : 22 * w / h, height: h > w ? 22 : 22 * h / w }} />
                  </span>
                  <span><span className="block text-[13px] font-medium">{l}</span><span className="block text-[11px] text-subtle">{d}</span></span>
                </button>
              ))}
            </div>
          </Popover>
          <IconBtn icon={FrameCorners} label={guides ? "Hide safe zones" : "Show where app buttons cover the video"} active={guides}
            onClick={() => { S.player.guides = !guides; setGuides(!guides); S.player.invalidate(); }} />
        </div>
      </div>
    </section>
  );
}
