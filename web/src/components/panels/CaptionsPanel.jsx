import { useEffect, useRef } from "react";
import { ClosedCaptioning, CircleNotch, Check } from "@phosphor-icons/react";
import { CAPTION_PRESETS, drawCaptions, defaultWordSpacing } from "../../core/layer.js";
import { S, commit } from "../../core/store.js";
import * as A from "../../core/actions.js";
import * as M from "../../core/model.js";
import * as Media from "../../core/media.js";
import { useBus, cn } from "../../lib/hooks.js";
import { Button, Section, Slider, Switch, Select, Segmented, ColorField, Empty } from "../ui/index.jsx";

const FONTS = ["Montserrat", "Poppins", "Inter", "Anton", "Bebas Neue", "Bangers", "Archivo Black"].map((f) => [f, f]);
const WEIGHTS = [[400, "Regular"], [600, "Semibold"], [700, "Bold"], [800, "Extra bold"], [900, "Black"]];

function Preview({ pre }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current, ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, c.width, c.height); g.addColorStop(0, "#343447"); g.addColorStop(1, "#1b1b24");
    ctx.fillStyle = g; ctx.fillRect(0, 0, c.width, c.height);
    const s = c.width / 1080 * 0.85;
    ctx.setTransform(s, 0, 0, s, (c.width - 1080 * s) / 2, 0);
    const words = ["THIS", "CHANGES", "EVERYTHING"].map((t, i) => ({ text: t, os: i, oe: i + 1 }));
    const style = { ...pre, posY: 0.5, maxWords: 3, maxChars: 40, maxWidth: 0.92, mode: pre.mode === "single" ? "single" : "group", size: pre.mode === "single" ? pre.size : Math.max(pre.size, 96) };
    drawCaptions(ctx, { W: 1080, H: c.height / s, groups: [{ words: pre.mode === "single" ? [words[1]] : words, start: 0, end: 9 }], cap: style },
      { g: 0, a: pre.mode === "single" ? 0 : 1, n: 3, ge: 1, ae: 1, em: -1, ee: 1 }, s);
  }, [pre]);
  return <canvas ref={ref} width={280} height={140} className="block w-full" />;
}

export default function CaptionsPanel() {
  useBus(["changed", "media", "words"]);
  const cap = S.p.captions;
  const set = (k, v, custom = true) => commit(() => { cap[k] = v; if (custom) cap.preset = "custom"; }, "cap." + k, { noTimeline: true });
  const mains = [...new Set(M.mainTrack(S.p).clips.map((c) => c.mid))].map(Media.meta).filter((m) => m?.has_audio);
  const busy = A.transcribing(), miss = A.captionsMissing();

  return (
    <div>
      <Section>
        {!mains.length ? (
          <Empty icon={ClosedCaptioning} title="No speech on the timeline">Add a video to the main track, then generate captions here.</Empty>
        ) : (
          <div className="rounded-lg border border-line bg-surface-2 p-3">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              {busy ? <CircleNotch size={15} className="animate-spin text-accent" /> : miss > 1 ? <ClosedCaptioning size={15} className="text-accent" /> : <Check size={15} className="text-success" />}
              {busy ? "Transcribing…" : miss > 1 ? `${Math.round(miss)}s of speech has no captions` : "Captions match the timeline"}
            </div>
            <p className="mt-1 text-xs text-subtle">Transcribes the main track. Re-run after edits to fill in new parts.</p>
            <Button variant={miss > 1 ? "primary" : "secondary"} className="mt-3 w-full justify-center" disabled={busy || miss <= 1} onClick={() => A.autoCaptions()}>
              <ClosedCaptioning size={15} /> {miss > 1 ? "Generate captions" : "Up to date"}
            </Button>
          </div>
        )}
        <Switch label="Show captions" checked={cap.enabled} onChange={(v) => set("enabled", v, false)} />
      </Section>

      <Section title="Style">
        <div className="mt-2 grid grid-cols-2 gap-2">
          {Object.entries(CAPTION_PRESETS).map(([k, pre]) => (
            <button key={k} title={pre.label}
              onClick={() => commit(() => { S.p.captions = Object.assign({ preset: k }, JSON.parse(JSON.stringify(pre)), { enabled: true, posY: cap.posY }); }, null, { noTimeline: true })}
              className={cn("overflow-hidden rounded-lg border-2 transition cursor-pointer", cap.preset === k ? "border-accent" : "border-transparent hover:border-line-strong")}>
              <Preview pre={pre} />
            </button>
          ))}
        </div>
      </Section>

      <Section title="Text">
        <Select label="Font" value={cap.font} onChange={(v) => set("font", v)} options={FONTS} />
        <div className="grid grid-cols-2 gap-2">
          <Select label="Weight" value={cap.weight} onChange={(v) => set("weight", v)} options={WEIGHTS} />
          <Select label="Case" value={cap.uppercase ? "up" : "as"} onChange={(v) => set("uppercase", v === "up")} options={[["as", "As spoken"], ["up", "UPPERCASE"]]} />
        </div>
        <Slider label="Size" value={cap.size} min={30} max={200} step={1} onChange={(v) => set("size", v)} />
        <Slider label="Word spacing" value={cap.wordSpacing ?? defaultWordSpacing(cap)} min={0} max={0.8} step={0.01} resetTo={defaultWordSpacing(cap)} format={(v) => Math.round(v * 100) + "%"} onChange={(v) => set("wordSpacing", v)} />
        <Slider label="Letter spacing" value={cap.letterSpacing || 0} min={-0.1} max={0.2} step={0.005} resetTo={0} format={(v) => (v > 0 ? "+" : "") + Math.round(v * 100) + "%"} onChange={(v) => set("letterSpacing", v)} />
        <Switch label="Hide punctuation" checked={cap.stripPunct} onChange={(v) => set("stripPunct", v)} />
      </Section>

      <Section title="Colors">
        <ColorField label="Text" value={cap.color} onChange={(v) => set("color", v)} />
        <Segmented label="Highlight the spoken word" value={cap.highlight} onChange={(v) => set("highlight", v)}
          options={[["color", "Color"], ["box", "Box"], ["none", "Off"]]} />
        {cap.highlight !== "none" && <ColorField label={cap.highlight === "box" ? "Box color" : "Spoken word color"} value={cap.highlight === "box" ? cap.boxColor : cap.activeColor}
          onChange={(v) => set(cap.highlight === "box" ? "boxColor" : "activeColor", v)} />}
        <ColorField label="Highlighted words (H in Transcript)" value={cap.emphColor} onChange={(v) => set("emphColor", v)} />
        <Slider label="Outline" value={cap.stroke} min={0} max={24} step={1} onChange={(v) => set("stroke", v)} />
        {cap.stroke > 0 && <ColorField label="Outline color" value={cap.strokeColor} onChange={(v) => set("strokeColor", v)} />}
        <Slider label="Shadow" value={cap.shadow} min={0} max={40} step={1} onChange={(v) => set("shadow", v)} />
      </Section>

      <Section title="Layout & motion">
        <Segmented label="Show" value={cap.mode} onChange={(v) => set("mode", v)} options={[["group", "Phrase"], ["reveal", "Word by word"], ["single", "One word"]]} />
        {cap.mode !== "single" && <Slider label="Words per caption" value={cap.maxWords} min={1} max={8} step={1} onChange={(v) => set("maxWords", v)} />}
        <Slider label="Vertical position" value={cap.posY} min={0.05} max={0.95} step={0.01} format={(v) => Math.round(v * 100) + "%"} onChange={(v) => set("posY", v, false)} />
        <Segmented label="Entrance" value={cap.enter} onChange={(v) => set("enter", v)} options={[["pop", "Pop"], ["fade", "Fade"], ["slide", "Slide"], ["none", "None"]]} />
        <Slider label="Spoken word pop" value={cap.activeScale} min={1} max={1.4} step={0.01} format={(v) => "+" + Math.round((v - 1) * 100) + "%"} resetTo={1} onChange={(v) => set("activeScale", v)} />
      </Section>

      {mains.length > 0 && (
        <Section title="Accuracy">
          <p className="mb-2 text-xs text-subtle">Fix single words in Transcript. The larger model is about 4× slower.</p>
          <Button className="w-full justify-center" onClick={() => A.autoCaptions({ model: "distil-large-v3", force: true })} disabled={busy}>Re-transcribe with large model</Button>
        </Section>
      )}
    </div>
  );
}
