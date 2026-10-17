import { useEffect, useRef, useState } from "react";
import { Scissors, ArrowLineLeft, ArrowLineRight, Trash, Copy, Flag, ClosedCaptioning, Waveform, Repeat, CornersIn, TextT, MagnetStraight, MagnifyingGlassPlus, MagnifyingGlassMinus, ArrowsOutLineHorizontal, CircleNotch, Check, Gauge, SpeakerSlash, SpeakerHigh, LinkBreak } from "@phosphor-icons/react";
import { S, select, begin, changed, commit } from "../core/store.js";
import { Timeline } from "../core/timeline.js";
import * as A from "../core/actions.js";
import * as M from "../core/model.js";
import * as Media from "../core/media.js";
import { useBus } from "../lib/hooks.js";
import { IconBtn, Tip, Button, Kbd, Menu } from "./ui/index.jsx";
import { Plus, Stack, MusicNotes, Snowflake, ArrowUp, ArrowDown, PencilSimple, TextT as TypeIcon, LinkSimple, LinkSimpleBreak } from "@phosphor-icons/react";
import { emit } from "../core/util.js";
import { importToProject, uploadFiles } from "./panels/MediaPanel.jsx";

export default function TimelineView({ height = 300 }) {
  const ref = useRef();
  const [snap, setSnap] = useState(true);
  const [menu, setMenu] = useState(null);
  const [trackMenu, setTrackMenu] = useState(null);
  const [zoom, setZoom] = useState(4);

  useEffect(() => {
    const tl = new Timeline(ref.current, {
      project: () => S.p,
      selected: () => S.sel,
      select: (ids, mode) => select(ids, mode),
      time: () => S.player.time(),
      seek: (t) => S.player.seek(t),
      playing: () => S.player.playing,
      begin: () => begin(),
      change: () => changed(),
      preview: () => S.player.invalidate(),
      toggleTrack: (id, prop) => A.toggleTrack(id, prop),
      contextMenu: (e, id) => setMenu({ x: e.clientX, y: e.clientY, id }),
      trackMenu: (e, id, action) => {
        if (action === "rename") return A.renameTrack(id);
        setTrackMenu({ x: e.clientX, y: e.clientY, id });
      },
      openTransition: (id) => { select([id]); emit("insp-tab", "transition"); },
      closeGap: (id) => commit(() => M.closeGap(S.p, id)),
      dropMedia: (mid, t, target) => A.addMedia(mid, t, target),
      dropPath: async (path, t, target) => { const m = await importToProject(path); A.addMedia(m.id, t, target); },
      dropFiles: (files, t, target) => uploadFiles(files, t, target),
      onZoom: (pps) => setZoom(Math.log(pps)),
    });
    S.timeline = tl;
    requestAnimationFrame(() => tl.fit());
    const onTheme = () => { tl.render(); S.player?.invalidate(); };
    window.addEventListener("themechange", onTheme);
    return () => { window.removeEventListener("themechange", onTheme); tl.destroy(); if (S.timeline === tl) S.timeline = null; };
  }, []);

  return (
    <footer className="flex shrink-0 flex-col bg-surface" style={{ height }}>
      <Toolbar snap={snap} setSnap={setSnap} zoom={zoom} setZoom={setZoom} />
      <div ref={ref} className="flex min-h-0 flex-1 flex-col">
        <div className="tl-scroll">
          <div className="tl-content">
            <div className="tl-corner" />
            <div className="tl-ruler"><canvas /></div>
            <div className="tl-rows" />
            <div className="tl-playhead"><i /></div>
            <div className="tl-snapline" />
            <div className="tl-insert" />
          </div>
        </div>
      </div>
      {menu && <ClipMenu {...menu} close={() => setMenu(null)} />}
      {trackMenu && <FloatingMenu {...trackMenu} close={() => setTrackMenu(null)} items={[
        { label: "Rename", icon: PencilSimple, fn: () => A.renameTrack(trackMenu.id) },
        { label: "Move up", icon: ArrowUp, fn: () => A.moveTrack(trackMenu.id, S.p.tracks.find((t) => t.id === trackMenu.id)?.kind === "audio" ? -1 : 1) },
        { label: "Move down", icon: ArrowDown, fn: () => A.moveTrack(trackMenu.id, S.p.tracks.find((t) => t.id === trackMenu.id)?.kind === "audio" ? 1 : -1) },
        "-",
        { label: "Delete track", icon: Trash, danger: true, fn: () => A.deleteTrack(trackMenu.id) },
      ]} />}
    </footer>
  );
}

function Toolbar({ snap, setSnap, zoom, setZoom }) {
  useBus(["changed", "media", "selection"]);
  const busy = A.transcribing(), miss = A.captionsMissing();
  const hasAny = M.mainTrack(S.p).clips.some((c) => Media.meta(c.mid)?.ready?.words);
  const ccLabel = busy ? "Transcribing…" : miss > 1 ? (hasAny ? "Update captions" : "Auto captions") : "Captions";
  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-2">
      <IconBtn icon={Scissors} label="Split at playhead" kbd="S" onClick={A.split} />
      <IconBtn icon={ArrowLineLeft} label="Delete everything left of the playhead" kbd="Q" onClick={() => A.trimTo("left")} />
      <IconBtn icon={ArrowLineRight} label="Delete everything right of the playhead" kbd="W" onClick={() => A.trimTo("right")} />
      <IconBtn icon={Trash} label="Delete selected" kbd="Del" onClick={A.del} disabled={!S.sel.size} />
      <IconBtn icon={Copy} label="Duplicate selected" kbd="Ctrl D" onClick={A.duplicate} disabled={!S.sel.size} />
      <IconBtn icon={Flag} label="Add marker" kbd="M" onClick={A.addMarker} />
      <IconBtn icon={Snowflake} label="Freeze frame (hold this frame for 2s)" onClick={A.freezeFrame} />
      <Menu align="start" trigger={<Button size="sm" variant="ghost" className="ml-1"><Plus size={14} />Track</Button>} items={[
        { label: "Video / image track", icon: Stack, onSelect: () => A.addTrack("video") },
        { label: "Text track", icon: TypeIcon, onSelect: () => A.addTrack("text") },
        { label: "Audio track", icon: MusicNotes, onSelect: () => A.addTrack("audio") },
      ]} />
      <span className="mx-2 h-5 w-px bg-line" />
      <Tip label={miss > 1 ? `Transcribe the ${Math.round(miss)}s of speech on the timeline that has no captions yet` : "Captions are up to date with the timeline"}>
        <Button size="sm" variant={miss > 1 && !busy ? "soft" : "ghost"} onClick={() => A.autoCaptions()} disabled={busy}>
          {busy ? <CircleNotch size={14} className="animate-spin" /> : miss > 1 ? <ClosedCaptioning size={14} /> : <Check size={14} />}{ccLabel}
        </Button>
      </Tip>
      <Tip label="Cut pauses longer than 0.3s on the main track"><Button size="sm" variant="ghost" onClick={() => A.removeSilences()}><Waveform size={14} />Remove silences</Button></Tip>
      <Tip label="Cut false starts and repeated takes"><Button size="sm" variant="ghost" onClick={A.cutRetakes}><Repeat size={14} />Cut retakes</Button></Tip>
      <Tip label="Alternate a punch-in zoom on every cut"><Button size="sm" variant="ghost" onClick={() => A.autoZoom()}><CornersIn size={14} />Punch-in</Button></Tip>
      <Tip label="Add text at the playhead" kbd="T"><Button size="sm" variant="ghost" onClick={() => A.addText()}><TextT size={14} />Text</Button></Tip>
      <span className="flex-1" />
      <Tip label={S.p.magnet ? "Main track magnet ON: clips stick together. Click to place clips freely." : "Main track magnet OFF: place clips anywhere. Click to make them stick together."}>
        <Button size="sm" variant={S.p.magnet ? "soft" : "ghost"} onClick={() => commit(() => M.setMagnet(S.p, !S.p.magnet))}>
          {S.p.magnet ? <LinkSimple size={14} /> : <LinkSimpleBreak size={14} />}{S.p.magnet ? "MagnetStraight" : "Free"}
        </Button>
      </Tip>
      <IconBtn icon={MagnetStraight} label={snap ? "Snapping on" : "Snapping off"} active={snap} onClick={() => { S.timeline.snap = !snap; setSnap(!snap); }} />
      <span className="mx-2 h-5 w-px bg-line" />
      <IconBtn icon={MagnifyingGlassMinus} label="Zoom out" kbd="−" onClick={() => S.timeline.zoomBy(1 / 1.4)} />
      <input type="range" min="0.7" max="6" step="0.01" value={zoom} aria-label="Timeline zoom"
        onChange={(e) => { const v = parseFloat(e.target.value); setZoom(v); S.timeline.zoomTo(Math.exp(v)); }}
        className="w-24 accent-accent" />
      <IconBtn icon={MagnifyingGlassPlus} label="Zoom in" kbd="+" onClick={() => S.timeline.zoomBy(1.4)} />
      <IconBtn icon={ArrowsOutLineHorizontal} label="Fit timeline to window" onClick={() => S.timeline.fit()} />
    </div>
  );
}

function FloatingMenu({ x, y, items, close }) {
  const ref = useRef();
  useEffect(() => {
    const h = (e) => { if (!ref.current?.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener("mousedown", h), 0);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} className="fixed z-[90] min-w-[190px] rounded-lg border border-line-strong bg-surface-2 p-1 shadow-lg"
      style={{ left: Math.min(x, innerWidth - 210), top: Math.min(y, innerHeight - 40 - items.length * 30) }}>
      {items.map((it, i) => it === "-" ? <div key={i} className="my-1 h-px bg-line" /> : (
        <button key={i} onClick={() => { close(); it.fn(); }}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-4 cursor-pointer ${it.danger ? "text-danger" : ""}`}>
          <it.icon size={14} className="text-muted" /><span className="flex-1">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

function ClipMenu({ x, y, id, close }) {
  const ref = useRef();
  useEffect(() => {
    const h = (e) => { if (!ref.current?.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener("mousedown", h), 0);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const f = M.find(S.p, id);
  if (!f) return null;
  const media = !!f.clip.mid;
  const run = (fn) => () => { close(); fn(); };
  const items = [
    { label: "Split at playhead", icon: Scissors, kbd: "S", fn: A.split },
    { label: "Duplicate", icon: Copy, kbd: "Ctrl D", fn: A.duplicate },
    { label: "Delete", icon: Trash, kbd: "Del", fn: A.del, danger: true },
    "-",
    ...(media ? [
      { label: "Speed 0.5×", icon: Gauge, fn: () => A.setSpeed(id, 0.5) },
      { label: "Speed 1×", icon: Gauge, fn: () => A.setSpeed(id, 1) },
      { label: "Speed 1.5×", icon: Gauge, fn: () => A.setSpeed(id, 1.5) },
      { label: "Speed 2×", icon: Gauge, fn: () => A.setSpeed(id, 2) },
      "-",
      { label: f.clip.mute ? "Unmute" : "Mute", icon: f.clip.mute ? SpeakerHigh : SpeakerSlash, fn: () => commit(() => { f.clip.mute = !f.clip.mute; }) },
      ...(f.track.kind !== "audio" ? [{ label: "Detach audio", icon: LinkBreak, fn: () => A.detachAudio(id) },
        { label: f.clip.flip ? "Unflip" : "Flip horizontally", icon: Repeat, fn: () => commit(() => { f.clip.flip = !f.clip.flip; }) }] : []),
    ] : []),
  ];
  return (
    <div ref={ref} className="fixed z-[90] min-w-[210px] rounded-lg border border-line-strong bg-surface-2 p-1 shadow-lg"
      style={{ left: Math.min(x, innerWidth - 230), top: Math.min(y, innerHeight - 40 - items.length * 30) }}>
      {items.map((it, i) => it === "-" ? <div key={i} className="my-1 h-px bg-line" /> : (
        <button key={i} onClick={run(it.fn)}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-4 cursor-pointer ${it.danger ? "text-danger" : ""}`}>
          <it.icon size={14} className="text-muted" /><span className="flex-1">{it.label}</span>{it.kbd && <Kbd>{it.kbd}</Kbd>}
        </button>
      ))}
    </div>
  );
}
