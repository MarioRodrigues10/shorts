import { useEffect, useState } from "react";
import { CaretLeft, ArrowUUpLeft, ArrowUUpRight, DownloadSimple, CircleNotch, Check, CloudSlash, Sun, Moon, Keyboard } from "@phosphor-icons/react";
import { useTheme } from "../lib/theme.js";
import { S, undo, redo, changed } from "../core/store.js";
import { api, on } from "../core/util.js";
import * as Media from "../core/media.js";
import { useBus } from "../lib/hooks.js";
import { Button, IconBtn, Tip } from "./ui/index.jsx";
import { startExport } from "./ExportDialog.jsx";
import { Logo } from "./Home.jsx";
import { openShortcuts } from "./Shortcuts.jsx";

export default function TopBar() {
  useBus(["history", "save"]);
  const [saveState, setSaveState] = useState("saved");
  const [queue, setQueue] = useState(null);
  const [name, setName] = useState(S.p.name);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => on("save", (s) => setSaveState(s.startsWith("error") ? "error" : s)), []);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const q = await api("/api/queue"); if (alive) setQueue(q.current ? q : null); } catch { /* restarting */ }
      if (alive) setTimeout(tick, 1500);
    };
    tick();
    return () => { alive = false; };
  }, []);

  const qm = queue && Media.meta(queue.current.media);
  const qLabel = queue && `${queue.current.task === "transcript" ? "Transcribing" : "Preparing"} ${qm ? qm.name : "media"}`;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
      <Tip label="All projects"><Button variant="ghost" size="sm" onClick={() => { location.hash = ""; }}><CaretLeft size={16} /><Logo size={20} /></Button></Tip>
      <input value={name} spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => { const n = name.trim() || S.p.name; S.p.name = n; setName(n); document.title = n + " · Shorts"; changed({ noTimeline: true }); }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        title="Project name (also the exported file name)"
        className="h-8 w-72 rounded-md border border-transparent bg-transparent px-2 text-sm font-semibold outline-none hover:border-line focus:border-accent focus:bg-surface-2" />
      <span className="flex items-center gap-1.5 text-xs text-subtle">
        {saveState === "dirty" ? <><CircleNotch size={12} className="animate-spin" /> Saving</> :
          saveState === "error" ? <><CloudSlash size={12} className="text-danger" /> Not saved</> : <><Check size={12} /> Saved</>}
      </span>
      <span className="flex-1" />
      {queue && (
        <span className="flex items-center gap-2 rounded-full bg-surface-3 px-3 py-1 text-xs text-muted">
          <CircleNotch size={12} className="animate-spin text-accent" />
          <span className="max-w-64 truncate">{qLabel}</span>
          <span className="font-mono tabular-nums text-fg">{Math.round(queue.progress * 100)}%</span>
          {queue.queued > 0 && <span className="text-subtle">+{queue.queued}</span>}
        </span>
      )}
      <IconBtn icon={Keyboard} label="Keyboard shortcuts" kbd="?" onClick={openShortcuts} />
      <IconBtn icon={theme === "dark" ? Sun : Moon} label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggleTheme} />
      <span className="mx-1 h-5 w-px bg-line" />
      <IconBtn icon={ArrowUUpLeft} label="Undo" kbd="Ctrl Z" onClick={undo} disabled={!S.undo.length} />
      <IconBtn icon={ArrowUUpRight} label="Redo" kbd="Ctrl Y" onClick={redo} disabled={!S.redo.length} />
      <Tip label="Export" kbd="Ctrl E">
        <Button variant="primary" className="ml-1" onClick={startExport}><DownloadSimple size={15} /> Export</Button>
      </Tip>
    </header>
  );
}
