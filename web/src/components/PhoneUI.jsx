// Shared controls for the phone features (full-frame phone and phone elements).
import { useState } from "react";
import { S } from "../core/store.js";
import * as Media from "../core/media.js";
import { fmt } from "../core/util.js";
import { GRADIENTS } from "../core/device.js";
import { useBus, cn } from "../lib/hooks.js";
import { Popover } from "./ui/index.jsx";

export const GRADIENT_NAMES = ["Tomato", "Teal", "Slate", "Sand", "Graphite"];
const BODY = { black: ["#2c2c2e", "#0a0a0a"], silver: ["#d4d4d9", "#0a0a0a"] };

// A small drawn phone (body, screen, camera pill); "none" is a dashed outline.
export function PhoneGlyph({ kind, size = 30 }) {
  const w = size * 0.52, h = size;
  if (!kind || kind === "none") {
    return (
      <svg width={w} height={h} viewBox="0 0 52 100" aria-hidden="true">
        <rect x="3" y="3" width="46" height="94" rx="12" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="7 6" opacity="0.5" />
      </svg>
    );
  }
  const [body, glass] = BODY[kind] || BODY.black;
  return (
    <svg width={w} height={h} viewBox="0 0 52 100" aria-hidden="true">
      <rect x="2" y="2" width="48" height="96" rx="12" fill={body} stroke="rgba(0,0,0,.25)" strokeWidth="1" />
      <rect x="6" y="6" width="40" height="88" rx="8.5" fill={glass} />
      <rect x="10" y="10" width="32" height="80" rx="6" fill="url(#phoneScreen)" />
      <rect x="20" y="12.5" width="12" height="4" rx="2" fill="#000" />
      <defs>
        <linearGradient id="phoneScreen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ef5f36" /><stop offset="1" stopColor="#1e9baa" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// None / Black / Silver as tiles, like the looks and transition pickers.
export function DeviceTiles({ value, onChange, none = true }) {
  const opts = [...(none ? [["none", "None"]] : []), ["black", "Black"], ["silver", "Silver"]];
  return (
    <div className={cn("mt-2 grid gap-1.5", none ? "grid-cols-3" : "grid-cols-2")}>
      {opts.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)} aria-pressed={(value || "none") === k}
          className={cn("flex flex-col items-center gap-1.5 rounded-lg border py-2.5 text-[11px] font-medium transition-colors cursor-pointer",
            (value || "none") === k ? "border-accent bg-accent-soft text-fg" : "border-line bg-surface-2 text-muted hover:border-line-strong hover:text-fg")}>
          <PhoneGlyph kind={k} size={30} />{l}
        </button>
      ))}
    </div>
  );
}

export function GradientSwatches({ value, onChange }) {
  return (
    <div className="mt-2 grid grid-cols-5 gap-1.5">
      {GRADIENTS.map(([c0, c1], i) => (
        <button key={i} title={GRADIENT_NAMES[i]} aria-label={GRADIENT_NAMES[i]} aria-pressed={(value || 0) === i} onClick={() => onChange(i)}
          className={cn("h-9 rounded-md border border-line-strong cursor-pointer transition-shadow",
            (value || 0) === i && "ring-2 ring-accent ring-offset-2 ring-offset-surface")}
          style={{ background: `linear-gradient(135deg, ${c0}, ${c1})` }} />
      ))}
    </div>
  );
}

// Pick one of the project's videos (for a phone element).
export function VideoPicker({ trigger, onPick }) {
  useBus(["media"]);
  const [open, setOpen] = useState(false);
  const vids = S.p.media.map(Media.meta).filter((m) => m?.kind === "video");
  return (
    <Popover trigger={trigger} side="right" align="start" open={open} onOpenChange={setOpen}>
      <div className="w-64">
        <div className="mb-2 text-xs font-medium">Video inside the phone</div>
        {!vids.length ? <p className="text-xs text-subtle">Import a video in Media first.</p> : (
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {vids.map((m) => (
              <button key={m.id} onClick={() => { setOpen(false); onPick(m.id); }} title={m.name}
                className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-surface-4 cursor-pointer">
                <span className="h-10 w-7 shrink-0 rounded bg-black bg-cover bg-center" style={{ backgroundImage: `url("/api/thumb?path=${encodeURIComponent(m.path)}")` }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{m.name}</span>
                  <span className="block text-[11px] text-subtle">{fmt(m.duration).replace(/\.\d$/, "")}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Popover>
  );
}
