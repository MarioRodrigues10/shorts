import { useEffect, useRef, useState } from "react";
import * as RTabs from "@radix-ui/react-tabs";
import { FilmStrip, Stack, TextT, MusicNotes, Trash, Copy, LinkBreak, ClosedCaptioning, Waveform, Repeat, FilmSlate } from "@phosphor-icons/react";
import { S, commit } from "../core/store.js";
import * as M from "../core/model.js";
import * as Media from "../core/media.js";
import * as A from "../core/actions.js";
import { api, on } from "../core/util.js";
import { TEXT_PRESETS } from "../core/layer.js";
import { kfValue, kfAt, hasKf, setKf, removeKf, kfTimes } from "../core/kf.js";
import { timeListeners } from "./Stage.jsx";
import { Diamond, CaretLeft as Prev, CaretRight as Next } from "@phosphor-icons/react";
import * as RSlider from "@radix-ui/react-slider";
import { useBus, cn } from "../lib/hooks.js";
import { Button, Section, Slider, Switch, Select, Segmented, ColorField, Kbd } from "./ui/index.jsx";
import { startExport } from "./ExportDialog.jsx";
import { toast } from "sonner";

const pct = (v) => Math.round(v * 100) + "%";
const sec = (v) => v.toFixed(1) + "s";
const FONTS = ["Montserrat", "Poppins", "Inter", "Anton", "Bebas Neue", "Bangers", "Archivo Black"].map((f) => [f, f]);

// Re-render with the playhead (throttled) so keyframed values follow it.
function usePlayhead() {
  const [, force] = useState(0);
  useEffect(() => {
    // throttled: re-rendering the inspector every frame made playback stutter
    let timer = 0;
    const f = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = 0; force((x) => x + 1); }, S.player?.playing ? 250 : 40);
    };
    timeListeners.add(f);
    return () => { timeListeners.delete(f); clearTimeout(timer); };
  }, []);
  return S.player ? S.player.time() : 0;
}

// Slider with a keyframe diamond: animate the property over time.
function KfSlider({ c, prop, label, base, setStatic, min, max, step = 0.01, format, resetTo }) {
  const t = usePlayhead();
  const dur = c.dur ?? (c.out - c.in) / (c.speed || 1);
  const lt = Math.max(0, Math.min(dur, t - c.start));
  const inside = t >= c.start - 1e-3 && t <= c.start + dur + 1e-3;
  const animated = hasKf(c, prop);
  const at = kfAt(c, prop, lt);
  const v = kfValue(c, prop, lt, base);
  const times = (c.kf?.[prop] || []).map((k) => k.t);
  const prevT = [...times].reverse().find((x) => x < lt - 1e-3), nextT = times.find((x) => x > lt + 1e-3);
  const change = (nv) => commit(() => { if (animated) setKf(c, prop, lt, nv); else setStatic(nv); }, `kf.${c.id}.${prop}`, { noTimeline: !animated || !!at });
  const toggle = () => commit(() => { if (at) removeKf(c, prop, lt); else setKf(c, prop, lt, v); });
  const shown = format ? format(v) : (Number.isInteger(step) ? Math.round(v) : v.toFixed(2));
  return (
    <div className="group/f py-1.5">
      <div className="mb-1.5 flex items-center gap-1 text-xs text-muted">
        <span className="font-medium">{label}</span>
        {animated && (
          <>
            <button disabled={prevT == null} onClick={() => S.player.seek(c.start + prevT)} title="Previous keyframe" className="text-subtle hover:text-fg disabled:opacity-30 cursor-pointer"><Prev size={12} /></button>
            <button disabled={nextT == null} onClick={() => S.player.seek(c.start + nextT)} title="Next keyframe" className="text-subtle hover:text-fg disabled:opacity-30 cursor-pointer"><Next size={12} /></button>
          </>
        )}
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-fg/80 tabular-nums">{shown}</span>
        <button onClick={toggle} disabled={!inside} title={at ? "Remove keyframe here" : animated ? "Add keyframe here" : "Animate: add a keyframe at the playhead"}
          className={cn("ml-1 rounded p-0.5 transition-colors cursor-pointer disabled:opacity-30", at ? "text-[#facc15]" : animated ? "text-[#facc15]/60 hover:text-[#facc15]" : "text-subtle hover:text-fg")}>
          <Diamond size={12} fill={at ? "currentColor" : "none"} />
        </button>
      </div>
      <RSlider.Root className="relative flex h-4 w-full touch-none items-center select-none" value={[v]} min={min} max={max} step={step}
        onValueChange={([x]) => change(x)} onDoubleClick={() => resetTo !== undefined && change(resetTo)}>
        <RSlider.Track className="relative h-1 grow rounded-full bg-surface-4">
          <RSlider.Range className={cn("absolute h-full rounded-full", animated ? "bg-[#facc15]" : "bg-accent")} />
        </RSlider.Track>
        <RSlider.Thumb className="block h-3.5 w-3.5 rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.5)] outline-none hover:scale-110 transition-transform" />
      </RSlider.Root>
    </div>
  );
}

// bind a field of a live clip object to a control
function useSetter(obj, prefix, opts) {
  return (k, v, timeline) => commit(() => {
    const ks = k.split("."), last = ks.pop();
    ks.reduce((o, x) => (o[x] = o[x] ?? {}), obj)[last] = v;
  }, prefix + k, { noTimeline: !timeline, ...opts });
}

export default function Inspector({ width = 300 }) {
  useBus(["selection", "changed", "media"]);
  const ids = [...S.sel];
  let body, title, Icon;
  if (!ids.length) { body = <ProjectPanel />; title = "Project"; Icon = FilmSlate; }
  else if (ids.length > 1) {
    title = `${ids.length} items`; Icon = Stack;
    body = <div className="p-4 space-y-2"><Button className="w-full justify-center" onClick={A.duplicate}><Copy size={14} />Duplicate</Button><Button variant="danger" className="w-full justify-center" onClick={A.del}><Trash size={14} />Delete</Button></div>;
  } else if (ids[0] === "captions") { title = "Captions"; Icon = ClosedCaptioning; body = <div className="p-4 text-xs text-muted">Style captions in the <b className="text-fg">Captions</b> tab on the left.</div>; }
  else {
    const f = M.find(S.p, ids[0]);
    if (!f) { body = <ProjectPanel />; title = "Project"; Icon = FilmSlate; }
    else {
      const kind = f.track.kind;
      const m = f.clip.mid ? Media.meta(f.clip.mid) : null;
      Icon = { main: FilmStrip, video: Stack, text: TextT, audio: MusicNotes }[kind];
      title = kind === "text" ? "Text" : m?.name || "Clip";
      const Comp = { main: MainClip, video: Overlay, text: TextClip, audio: AudioClip }[kind];
      body = <Comp key={f.clip.id} c={f.clip} m={m} />;
    }
  }
  return (
    <aside className="flex shrink-0 flex-col bg-surface" style={{ width }}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <Icon size={15} className="text-muted" />
        <span className="truncate text-[13px] font-semibold">{title}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </aside>
  );
}

// A requested tab survives until a panel that has it mounts (selection changes re-mount panels).
let pendingTab = null;
on("insp-tab", (k) => { pendingTab = k; });

function Tabs({ tabs }) {
  const [tab, setTab] = useState(() => {
    const k = pendingTab && tabs.some((t) => t[0] === pendingTab) ? pendingTab : tabs[0][0];
    if (k === pendingTab) pendingTab = null;
    return k;
  });
  useEffect(() => on("insp-tab", (k) => { if (tabs.some((t) => t[0] === k)) { setTab(k); pendingTab = null; } }), [tabs.map((t) => t[0]).join()]);
  const t = tabs.find((x) => x[0] === tab) ? tab : tabs[0][0];
  return (
    <RTabs.Root value={t} onValueChange={setTab}>
      <RTabs.List className="sticky top-0 z-10 flex gap-1 border-b border-line bg-surface px-3 pt-2">
        {tabs.map(([k, l]) => (
          <RTabs.Trigger key={k} value={k}
            className="-mb-px border-b-2 border-transparent px-2.5 pb-2 text-xs font-medium text-subtle transition-colors hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg cursor-pointer">
            {l}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {tabs.map(([k, , content]) => <RTabs.Content key={k} value={k}>{content}</RTabs.Content>)}
    </RTabs.Root>
  );
}

function Actions({ c, detach }) {
  return (
    <Section>
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={A.duplicate}><Copy size={14} />Duplicate</Button>
        <Button variant="danger" onClick={A.del}><Trash size={14} />Delete</Button>
        {detach && <Button className="col-span-2" onClick={() => A.detachAudio(c.id)}><LinkBreak size={14} />Detach audio to its own track</Button>}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ adjust (shared by main + overlay)
const LOOKS = [
  ["none", "Original", {}],
  ["auto", "Enhance", { contrast: 0.08, saturation: 0.12, sharpen: 0.35, denoise: 0.25 }],
  ["vivid", "Vivid", { contrast: 0.12, saturation: 0.32, sharpen: 0.3 }],
  ["warm", "Warm", { temperature: 0.35, saturation: 0.08, contrast: 0.05 }],
  ["cool", "Cool", { temperature: -0.35, contrast: 0.05 }],
  ["film", "Film", { contrast: 0.14, saturation: -0.22, temperature: 0.18, brightness: -0.03 }],
  ["bright", "Bright", { brightness: 0.08, contrast: 0.04, saturation: 0.06 }],
  ["bw", "B&W", { saturation: -1, contrast: 0.18 }],
];
function AdjustTab({ c }) {
  const adj = c.adj || {};
  const set = (k, v) => commit(() => { c.adj = { ...(c.adj || {}), [k]: v }; c.look = "custom"; }, `adj.${c.id}.${k}`, { noTimeline: true });
  const applyLook = (key, vals) => commit(() => { c.adj = { ...vals }; c.look = key; }, null, { noTimeline: true });
  const applyAll = () => commit(() => {
    for (const tr of S.p.tracks) if (tr.kind === "main" || tr.kind === "video") for (const x of tr.clips) if (Media.meta(x.mid)?.kind !== "audio") { x.adj = { ...adj }; x.look = c.look; }
  }, null, { noTimeline: true });
  return (
    <>
      <Section title="Looks">
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {LOOKS.map(([k, l, vals]) => (
            <button key={k} onClick={() => applyLook(k, vals)}
              className={cn("rounded-lg border px-1 py-2 text-[11px] font-medium transition cursor-pointer",
                (c.look || "none") === k ? "border-accent bg-accent-soft text-fg" : "border-line bg-surface-2 text-muted hover:text-fg hover:border-line-strong")}>
              {l}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Color & light">
        <Slider label="Brightness" value={adj.brightness || 0} min={-0.5} max={0.5} resetTo={0} format={pct} onChange={(v) => set("brightness", v)} />
        <Slider label="Contrast" value={adj.contrast || 0} min={-0.5} max={0.5} resetTo={0} format={pct} onChange={(v) => set("contrast", v)} />
        <Slider label="Saturation" value={adj.saturation || 0} min={-1} max={1} resetTo={0} format={pct} onChange={(v) => set("saturation", v)} />
        <Slider label="Temperature" value={adj.temperature || 0} min={-1} max={1} resetTo={0} format={(v) => (v > 0 ? "Warm " : v < 0 ? "Cool " : "") + Math.round(Math.abs(v) * 100)} onChange={(v) => set("temperature", v)} />
      </Section>
      <Section title="Detail">
        <Slider label="Sharpen" value={adj.sharpen || 0} min={0} max={1} resetTo={0} format={pct} onChange={(v) => set("sharpen", v)} />
        <Slider label="Reduce noise" value={adj.denoise || 0} min={0} max={1} resetTo={0} format={pct} onChange={(v) => set("denoise", v)} />
        <p className="mt-1 text-[11px] text-subtle">Applied on export only.</p>
      </Section>
      <Section><Button className="w-full justify-center" onClick={applyAll}>Apply to all clips</Button></Section>
    </>
  );
}

// ------------------------------------------------------------------ main clip
function MainClip({ c, m }) {
  const set = useSetter(c, "clip." + c.id + ".");
  const video = (
    <>
      <Section title="Frame">
        <Segmented label="Fit" value={c.fit || "fill"} onChange={(v) => set("fit", v)} options={[["fill", "Fill frame"], ["fit", "Show whole video"]]} />
        <KfSlider c={c} prop="zoom" label="Scale" base={c.zoom ?? 1} setStatic={(v) => { c.zoom = v; }} min={c.fit === "fit" ? 0.5 : 1} max={3} resetTo={1} format={pct} />
        <KfSlider c={c} prop="x" label="Position X" base={c.x || 0} setStatic={(v) => { c.x = v; }} min={-1} max={1} resetTo={0} />
        <KfSlider c={c} prop="y" label="Position Y" base={c.y || 0} setStatic={(v) => { c.y = v; }} min={-1} max={1} resetTo={0} />
        <Switch label="Flip horizontally" checked={c.flip} onChange={(v) => set("flip", v, true)} />
      </Section>
      <SmartTools c={c} m={m} />
      <Section title="Motion">
        <Select label="Slow zoom (Ken Burns)" value={c.zoomEnd == null ? "off" : String(c.zoomEnd)} onChange={(v) => set("zoomEnd", v === "off" ? null : parseFloat(v), true)}
          options={[["off", "Off"], ["1.1", "Zoom in slightly (110%)"], ["1.2", "Zoom in (120%)"], ["1.35", "Zoom in a lot (135%)"], ["1", "Zoom back to 100%"]]} />
        <Segmented label="Intro effect" value={c.effect || "none"} onChange={(v) => set("effect", v, true)} options={[["none", "None"], ["zoom", "Zoom"], ["flash", "Flash"], ["fade", "Fade"]]} />
      </Section>
      <Actions c={c} detach={m?.has_audio} />
    </>
  );
  const audio = (
    <>
      <Section title="Volume">
        <Slider label="Volume" value={c.volume ?? 1} min={0} max={2} resetTo={1} format={pct} onChange={(v) => set("volume", v, true)} />
        <Switch label="Mute" checked={c.mute} onChange={(v) => set("mute", v, true)} />
        <Slider label="Fade in" value={c.afadeIn || 0} min={0} max={3} step={0.1} resetTo={0} format={sec} onChange={(v) => set("afadeIn", v)} />
        <Slider label="Fade out" value={c.afadeOut || 0} min={0} max={3} step={0.1} resetTo={0} format={sec} onChange={(v) => set("afadeOut", v)} />
      </Section>
    </>
  );
  const speed = (
    <Section title="Speed">
      <Slider label="Speed" value={c.speed || 1} min={0.25} max={4} step={0.05} resetTo={1} format={(v) => v.toFixed(2) + "×"} onChange={(v) => set("speed", v, true)} />
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {[0.5, 1, 1.25, 1.5, 2, 3, 4, 0.75].map((v) => (
          <Button key={v} size="sm" variant={(c.speed || 1) === v ? "soft" : "secondary"} className="justify-center" onClick={() => set("speed", v, true)}>{v}×</Button>
        ))}
      </div>
    </Section>
  );
  return <Tabs tabs={[["video", "Video", video], ["transition", "Transition", <TransitionTab c={c} />], ["adjust", "Adjust", <AdjustTab c={c} />], ["audio", "Audio", audio], ["speed", "Speed", speed]]} />;
}

function SmartTools({ c, m }) {
  const [busy, setBusy] = useState(null); // {what, p}
  const [bg, setBg] = useState("blur");
  if (!m || m.kind !== "video") return null;
  const run = async (what, fn) => {
    setBusy({ what, p: 0 });
    try { await fn((p) => setBusy({ what, p })); }
    catch (e) { toast.error(e.message); }
    setBusy(null);
  };
  return (
    <Section title="AI tools">
      <div className="space-y-2">
        <Button className="w-full justify-center" disabled={!!busy} onClick={() => run("reframe", (cb) => A.autoReframe(c.id, cb))}>
          {busy?.what === "reframe" ? `Tracking face ${Math.round(busy.p * 100)}%` : "Auto reframe to face"}
        </Button>
        <div className="flex gap-2">
          <select value={bg} onChange={(e) => setBg(e.target.value)} disabled={!!busy}
            className="h-8 rounded-lg border border-line bg-surface-2 px-2 text-xs outline-none">
            <option value="blur">Blur</option><option value="#000000">Black</option><option value="#ffffff">White</option>
            <option value="#00b140">Green screen</option><option value="#1e9baa">Teal</option>
          </select>
          <Button className="flex-1 justify-center" disabled={!!busy} onClick={() => run("bg", (cb) => A.removeBackground(c.id, bg, cb))}>
            {busy?.what === "bg" ? `Processing ${Math.round(busy.p * 100)}%` : "Replace background"}
          </Button>
        </div>
        {c.origin && <Button variant="ghost" size="sm" onClick={() => A.restoreOriginal(c.id)}>Restore original</Button>}
      </div>
    </Section>
  );
}

function TransitionTab({ c }) {
  const main = M.mainTrack(S.p).clips;
  const i = main.findIndex((x) => x.id === c.id);
  if (i <= 0) return <Section><p className="text-xs text-subtle">The first clip has no transition. Select a later clip, or click <b>+</b> between two clips on the timeline.</p></Section>;
  const type = c.trans?.type || "none", dur = c.trans?.dur ?? 0.5;
  return (
    <>
      <Section title="Transition into this clip">
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {M.TRANSITIONS.map(([k, l]) => (
            <button key={k} onClick={() => A.setTransition(c.id, k, dur)}
              className={cn("rounded-lg border px-1 py-2 text-[11px] font-medium transition cursor-pointer",
                type === k ? "border-accent bg-accent-soft text-fg" : "border-line bg-surface-2 text-muted hover:text-fg hover:border-line-strong")}>{l}</button>
          ))}
        </div>
        {type !== "none" && <Slider label="Duration" value={dur} min={0.1} max={1.5} step={0.05} resetTo={0.5} format={sec}
          onChange={(v) => commit(() => { c.trans = { type, dur: v }; }, `trans.${c.id}`)} />}
      </Section>
      <Section><Button className="w-full justify-center" onClick={() => A.applyTransitionToAll(type, dur)}>Use on every cut</Button></Section>
    </>
  );
}

// ------------------------------------------------------------------ overlay
function Overlay({ c, m }) {
  const set = useSetter(c, "ov." + c.id + ".");
  const video = (
    <>
      <Section title="Placement">
        <Switch label="Full screen" hint="Cover the whole frame (B-roll)" checked={c.cover} onChange={(v) => set("cover", v)} />
        {!c.cover && <>
          <KfSlider c={c} prop="scale" label="Scale" base={c.scale ?? 0.6} setStatic={(v) => { c.scale = v; }} min={0.05} max={2} resetTo={0.7} format={pct} />
          <KfSlider c={c} prop="x" label="Position X" base={c.x ?? 0.5} setStatic={(v) => { c.x = v; }} min={0} max={1} step={0.005} resetTo={0.5} format={pct} />
          <KfSlider c={c} prop="y" label="Position Y" base={c.y ?? 0.5} setStatic={(v) => { c.y = v; }} min={0} max={1} step={0.005} resetTo={0.5} format={pct} />
          <KfSlider c={c} prop="rotate" label="Rotation" base={c.rotate || 0} setStatic={(v) => { c.rotate = v; }} min={-180} max={180} step={1} resetTo={0} format={(v) => Math.round(v) + "°"} />
        </>}
        <KfSlider c={c} prop="opacity" label="Opacity" base={c.opacity ?? 1} setStatic={(v) => { c.opacity = v; }} min={0} max={1} resetTo={1} format={pct} />
        <Switch label="Flip horizontally" checked={c.flip} onChange={(v) => set("flip", v, true)} />
      </Section>
      <Section title="Fade">
        <Slider label="Fade in" value={c.fadeIn || 0} min={0} max={2} step={0.05} resetTo={0} format={sec} onChange={(v) => set("fadeIn", v)} />
        <Slider label="Fade out" value={c.fadeOut || 0} min={0} max={2} step={0.05} resetTo={0} format={sec} onChange={(v) => set("fadeOut", v)} />
      </Section>
      {m?.kind === "video" && (
        <Section title="Audio & speed">
          <Slider label="Volume" value={c.volume ?? 1} min={0} max={2} resetTo={1} format={pct} onChange={(v) => set("volume", v)} />
          <Switch label="Mute" checked={c.mute} onChange={(v) => set("mute", v, true)} />
          <Segmented label="Speed" value={c.speed || 1} onChange={(v) => set("speed", v, true)} options={[[0.5, "0.5×"], [1, "1×"], [1.5, "1.5×"], [2, "2×"]]} />
        </Section>
      )}
      <Actions c={c} />
    </>
  );
  return <Tabs tabs={[["video", m?.kind === "image" ? "Image" : "Video", video], ["adjust", "Adjust", <AdjustTab c={c} />]]} />;
}

// ------------------------------------------------------------------ text
function ShapeStyle({ c, set }) {
  const s = c.style || {};
  return (
    <>
      <Section title={{ rect: "Box", circle: "Circle", arrow: "Arrow", underline: "Underline" }[c.shape] || "Shape"}>
        <ColorField label="Color" value={s.color} onChange={(v) => set("style.color", v)} />
        {(c.shape === "rect" || c.shape === "circle") && <ColorField label="Fill" value={s.fill} allowNone onChange={(v) => set("style.fill", v)} />}
        <Slider label="Line width" value={s.stroke ?? 12} min={0} max={40} step={1} onChange={(v) => set("style.stroke", v)} />
        <Slider label="Width" value={c.w || 0.4} min={0.05} max={1.2} resetTo={0.4} format={pct} onChange={(v) => set("w", v)} />
        {c.shape !== "arrow" && <Slider label="Height" value={c.h || 0.2} min={0.02} max={1.2} resetTo={0.2} format={pct} onChange={(v) => set("h", v)} />}
        {c.shape === "rect" && <Slider label="Corner radius" value={s.radius ?? 24} min={0} max={200} step={1} onChange={(v) => set("style.radius", v)} />}
      </Section>
      <Actions c={c} />
    </>
  );
}

function TextClip({ c }) {
  const set = useSetter(c, "tx." + c.id + ".");
  if (c.shape) {
    const anim = (
      <Section title="Animation">
        <Segmented label="In" value={c.anim || "none"} onChange={(v) => set("anim", v)} options={[["none", "None"], ["pop", "Pop"], ["fade", "Fade"]]} />
        <Segmented label="Out" value={c.animOut || "none"} onChange={(v) => set("animOut", v)} options={[["none", "None"], ["fade", "Fade"]]} />
      </Section>
    );
    const pos = (
      <Section title="Position">
        <KfSlider c={c} prop="x" label="X" base={c.x ?? 0.5} setStatic={(v) => { c.x = v; }} min={0} max={1} step={0.005} resetTo={0.5} format={pct} />
        <KfSlider c={c} prop="y" label="Y" base={c.y ?? 0.3} setStatic={(v) => { c.y = v; }} min={0} max={1} step={0.005} resetTo={0.3} format={pct} />
        <KfSlider c={c} prop="scale" label="Scale" base={c.scale ?? 1} setStatic={(v) => { c.scale = v; }} min={0.2} max={3} resetTo={1} format={pct} />
        <KfSlider c={c} prop="rotate" label="Rotation" base={c.rotate || 0} setStatic={(v) => { c.rotate = v; }} min={-180} max={180} step={1} resetTo={0} format={(v) => Math.round(v) + "°"} />
        <KfSlider c={c} prop="opacity" label="Opacity" base={c.opacity ?? 1} setStatic={(v) => { c.opacity = v; }} min={0} max={1} resetTo={1} format={pct} />
      </Section>
    );
    return <Tabs tabs={[["style", "Style", <ShapeStyle c={c} set={set} />], ["pos", "Position", pos], ["anim", "Animation", anim]]} />;
  }
  const ta = useRef();
  useEffect(() => on("edit-text", (id) => { if (id === c.id && ta.current) { ta.current.focus(); ta.current.select(); } }), [c.id]);
  const s = c.style;
  const text = (
    <>
      <Section>
        <textarea ref={ta} value={c.text} rows={3} onChange={(e) => set("text", e.target.value, true)}
          className="w-full resize-y rounded-lg border border-line bg-surface-2 p-2.5 text-sm outline-none focus:border-accent" />
        <div className="mt-2 flex flex-wrap gap-1">
          {Object.entries(TEXT_PRESETS).map(([k, p]) => (
            <button key={k} onClick={() => commit(() => { c.style = { ...c.style, ...p }; c.preset = k; }, null, { noTimeline: true })}
              className={cn("rounded-md border px-2 py-1 text-[11px] cursor-pointer", c.preset === k ? "border-accent text-fg" : "border-line text-muted hover:text-fg")}>{p.label}</button>
          ))}
        </div>
      </Section>
      <Section title="Font">
        <Select label="Font" value={s.font} onChange={(v) => set("style.font", v)} options={FONTS} />
        <div className="grid grid-cols-2 gap-2">
          <Select label="Weight" value={s.weight} onChange={(v) => set("style.weight", v)} options={[[400, "Regular"], [600, "Semibold"], [700, "Bold"], [800, "Extra bold"], [900, "Black"]]} />
          <Select label="Case" value={s.uppercase ? "up" : "as"} onChange={(v) => set("style.uppercase", v === "up")} options={[["as", "As typed"], ["up", "UPPERCASE"]]} />
        </div>
        <Slider label="Size" value={s.size} min={16} max={240} step={1} onChange={(v) => set("style.size", v)} />
        <Slider label="Letter spacing" value={s.letterSpacing || 0} min={-0.1} max={0.2} step={0.005} resetTo={0} format={(v) => (v > 0 ? "+" : "") + Math.round(v * 100) + "%"} onChange={(v) => set("style.letterSpacing", v)} />
      </Section>
      <Section title="Colors">
        <ColorField label="Text" value={s.color} onChange={(v) => set("style.color", v)} />
        <ColorField label="Background" value={s.bg} allowNone onChange={(v) => set("style.bg", v)} />
        <Slider label="Outline" value={s.stroke || 0} min={0} max={24} step={1} resetTo={0} onChange={(v) => set("style.stroke", v)} />
        {s.stroke > 0 && <ColorField label="Outline color" value={s.strokeColor} onChange={(v) => set("style.strokeColor", v)} />}
        <Slider label="Shadow" value={s.shadow || 0} min={0} max={50} step={1} resetTo={0} onChange={(v) => set("style.shadow", v)} />
      </Section>
      <Actions c={c} />
    </>
  );
  const anim = (
    <Section title="Animation">
      <Segmented label="In" value={c.anim || "none"} onChange={(v) => set("anim", v)} options={[["none", "None"], ["pop", "Pop"], ["fade", "Fade"], ["slide", "Slide"], ["typewriter", "Type"]]} />
      <Segmented label="Out" value={c.animOut || "none"} onChange={(v) => set("animOut", v)} options={[["none", "None"], ["fade", "Fade"], ["pop", "Pop"]]} />
    </Section>
  );
  const pos = (
    <Section title="Position">
      <KfSlider c={c} prop="x" label="X" base={c.x ?? 0.5} setStatic={(v) => { c.x = v; }} min={0} max={1} step={0.005} resetTo={0.5} format={pct} />
      <KfSlider c={c} prop="y" label="Y" base={c.y ?? 0.3} setStatic={(v) => { c.y = v; }} min={0} max={1} step={0.005} resetTo={0.3} format={pct} />
      <KfSlider c={c} prop="scale" label="Scale" base={c.scale ?? 1} setStatic={(v) => { c.scale = v; }} min={0.2} max={3} resetTo={1} format={pct} />
      <KfSlider c={c} prop="rotate" label="Rotation" base={c.rotate || 0} setStatic={(v) => { c.rotate = v; }} min={-180} max={180} step={1} resetTo={0} format={(v) => Math.round(v) + "°"} />
      <KfSlider c={c} prop="opacity" label="Opacity" base={c.opacity ?? 1} setStatic={(v) => { c.opacity = v; }} min={0} max={1} resetTo={1} format={pct} />
      {!c.shape && <Slider label="Box width" value={s.maxWidth || 0.86} min={0.3} max={0.98} resetTo={0.86} format={pct} onChange={(v) => set("style.maxWidth", v)} />}
    </Section>
  );
  return <Tabs tabs={[["text", "Text", text], ["anim", "Animation", anim], ["pos", "Position", pos]]} />;
}

// ------------------------------------------------------------------ audio
function AudioClip({ c }) {
  const set = useSetter(c, "au." + c.id + ".");
  return (
    <>
      <Section title="Volume">
        <Slider label="Volume" value={c.volume ?? 1} min={0} max={2} resetTo={1} format={pct} onChange={(v) => set("volume", v, true)} />
        <Switch label="Mute" checked={c.mute} onChange={(v) => set("mute", v, true)} />
        <Switch label="Lower under voice" hint="Music dips automatically while someone speaks" checked={c.duck} onChange={(v) => set("duck", v, true)} />
      </Section>
      <Section title="Fades">
        <Slider label="Fade in" value={c.fadeIn || 0} min={0} max={5} step={0.1} resetTo={0} format={sec} onChange={(v) => set("fadeIn", v)} />
        <Slider label="Fade out" value={c.fadeOut || 0} min={0} max={5} step={0.1} resetTo={0} format={sec} onChange={(v) => set("fadeOut", v)} />
      </Section>
      <Section title="Speed">
        <Segmented value={c.speed || 1} onChange={(v) => set("speed", v, true)} options={[[0.75, "0.75×"], [1, "1×"], [1.25, "1.25×"], [1.5, "1.5×"]]} />
      </Section>
      <Actions c={c} />
    </>
  );
}

// ------------------------------------------------------------------ project (nothing selected)
function ProjectPanel() {
  const p = S.p;
  const set = useSetter(p, "proj.");
  const main = M.mainTrack(p).clips;
  const hasClips = main.length > 0;
  return (
    <>
      <Section title="Clean up">
        <div className="mt-1 grid grid-cols-2 gap-2">
          <Button disabled={!hasClips} onClick={() => A.removeSilences()}><Waveform size={14} />Cut silences</Button>
          <Button disabled={!hasClips} onClick={A.cutRetakes}><Repeat size={14} />Cut retakes</Button>
        </div>
      </Section>
      <Section title="Fit background">
        <Segmented value={p.canvas.bg || "blur"} onChange={(v) => set("canvas.bg", v)} options={[["blur", "Blur"], ["black", "Black"], ["#ffffff", "White"]]} />
              </Section>
      <Section title="Sound">
        <Switch label="Normalize loudness" hint="−14 LUFS, the level social apps play at" checked={p.audio.normalize} onChange={(v) => set("audio.normalize", v)} />
        <Switch label="Repair distorted audio" hint="Rebuilds clipped peaks when the mic was too loud" checked={p.audio.repair !== false} onChange={(v) => set("audio.repair", v)} />
        <Switch label="Voice enhance" hint="Removes rumble and steady background noise" checked={p.audio.enhance} onChange={(v) => set("audio.enhance", v)} />
      </Section>
      <Section title="Default style">
        <Button className="w-full justify-center" onClick={async () => { await api("/api/defaults", { captions: p.captions, canvas: p.canvas, audio: p.audio }); toast.success("Saved as your default style"); }}>
          Use for new projects
        </Button>
      </Section>
    </>
  );
}
