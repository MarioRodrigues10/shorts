import { useState } from "react";
import { FilmSlate, TextT, ClosedCaptioning, Article, MusicNotes, Shapes } from "@phosphor-icons/react";
import { cn } from "../lib/hooks.js";
import MediaPanel from "./panels/MediaPanel.jsx";
import TextPanel from "./panels/TextPanel.jsx";
import CaptionsPanel from "./panels/CaptionsPanel.jsx";
import TranscriptPanel from "./panels/TranscriptPanel.jsx";
import AudioPanel from "./panels/AudioPanel.jsx";
import ElementsPanel from "./panels/ElementsPanel.jsx";
import { on } from "../core/util.js";
import { useEffect } from "react";

const TABS = [
  ["media", "Media", FilmSlate, MediaPanel],
  ["audio", "Audio", MusicNotes, AudioPanel],
  ["text", "Text", TextT, TextPanel],
  ["elements", "Elements", Shapes, ElementsPanel],
  ["captions", "Captions", ClosedCaptioning, CaptionsPanel],
  ["transcript", "Transcript", Article, TranscriptPanel],
];

export default function LeftPanel({ width = 300 }) {
  const [tab, setTab] = useState("media");
  useEffect(() => on("open-tab", setTab), []);
  const Panel = TABS.find((t) => t[0] === tab)[3];
  return (
    <>
      <nav className="flex w-[72px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-2">
        {TABS.map(([k, label, I]) => (
          <button key={k} onClick={() => setTab(k)}
            className={cn("flex w-14 flex-col items-center gap-1 rounded-xl py-2 text-[10.5px] font-medium transition-colors cursor-pointer",
              tab === k ? "bg-accent-soft text-accent-ink" : "text-subtle hover:bg-surface-3 hover:text-fg")}>
            <I size={19} />{label}
          </button>
        ))}
      </nav>
      <aside className="flex shrink-0 flex-col bg-surface" style={{ width }}>
        <div className="flex h-11 shrink-0 items-center border-b border-line px-4 text-[13px] font-semibold">{TABS.find((t) => t[0] === tab)[1]}</div>
        <div className="min-h-0 flex-1 overflow-y-auto"><Panel /></div>
      </aside>
    </>
  );
}
