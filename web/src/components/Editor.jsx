import { useEffect, useState } from "react";
import { api, FPS } from "../core/util.js";
import { S, undo, redo, select, save, changed } from "../core/store.js";
import * as M from "../core/model.js";
import * as Media from "../core/media.js";
import * as A from "../core/actions.js";
import { endOfMain } from "../core/player.js";
import { defaultCaptions, clearLayoutCache } from "../core/layer.js";
import TopBar from "./TopBar.jsx";
import LeftPanel from "./LeftPanel.jsx";
import Stage from "./Stage.jsx";
import Inspector from "./Inspector.jsx";
import TimelineView from "./TimelineView.jsx";
import ExportDialog, { startExport } from "./ExportDialog.jsx";
import Shortcuts, { openShortcuts } from "./Shortcuts.jsx";
import { CircleNotch } from "@phosphor-icons/react";
import { Resizer } from "./ui/index.jsx";
import { usePanelSize } from "../lib/theme.js";

async function loadFonts() {
  const fams = ["Montserrat", "Poppins", "Anton", "Bebas Neue", "Bangers", "Archivo Black", "Inter"];
  await Promise.all(fams.flatMap((f) => [400, 600, 800, 900].map((w) => document.fonts.load(`${w} 40px "${f}"`).catch(() => {}))));
  await document.fonts.load('40px "Noto Color Emoji"').catch(() => {});
  clearLayoutCache();
}

export default function Editor({ id }) {
  const [ready, setReady] = useState(false);
  const [leftW, setLeftW] = usePanelSize("left", 340, 260, 620);
  const [rightW, setRightW] = usePanelSize("right", 330, 280, 560);
  const [tlH, setTlH] = usePanelSize("timeline", 330, 190, 900);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await api("/api/projects/" + id);
        if (!p.captions) {
          const d = await api("/api/defaults").catch(() => ({}));
          p.captions = Object.assign(defaultCaptions(), d.captions || {});
          if (d.canvas) p.canvas = Object.assign(p.canvas || {}, d.canvas);
          if (d.audio) p.audio = d.audio;
        }
        M.normalize(p);
        const mids = new Set(p.media);
        for (const tr of p.tracks) for (const c of tr.clips) if (c.mid) mids.add(c.mid);
        await Media.load([...mids]);
        for (const mid of mids) if (!p.media.includes(mid)) p.media.push(mid);
        await loadFonts();
        if (!alive) return;
        S.p = p; S.sel = new Set(); S.undo.length = 0; S.redo.length = 0; S.rev++;
        document.title = p.name + " · Shorts";
        setReady(true);
      } catch (e) { setError(e.message); }
    })();
    return () => { alive = false; save(); };
  }, [id]);

  useEffect(() => {
    if (!ready) return;
    const onKey = (e) => handleKey(e);
    const onUnload = () => {
      if (S.p && !S.saved) fetch("/api/projects/" + S.p.id, { method: "PUT", body: JSON.stringify(S.p), headers: { "Content-Type": "application/json" }, keepalive: true });
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => { document.removeEventListener("keydown", onKey); window.removeEventListener("beforeunload", onUnload); };
  }, [ready]);

  if (error) return <div className="flex h-full items-center justify-center text-muted">Could not open project: {error}</div>;
  if (!ready) return <div className="flex h-full items-center justify-center gap-2 text-muted"><CircleNotch className="animate-spin" size={18} /> Opening project…</div>;

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <LeftPanel width={leftW} />
        <Resizer size={leftW} onSize={(v) => setLeftW(v ?? 340)} />
        <Stage />
        <Resizer size={rightW} invert onSize={(v) => setRightW(v ?? 330)} />
        <Inspector width={rightW} />
      </div>
      <Resizer dir="h" size={tlH} invert onSize={(v) => setTlH(Math.min(v ?? 330, window.innerHeight - 260))} />
      <TimelineView height={tlH} />
      <ExportDialog />
      <Shortcuts />
    </div>
  );
}

function handleKey(e) {
  if (!S.p) return;
  const a = document.activeElement;
  const typing = a && (a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable ||
    (a.tagName === "INPUT" && !["checkbox", "range", "color", "button"].includes(a.type)));
  if (typing || document.querySelector("[role=dialog]")) return;
  if (a?.dataset?.transcript && ["Delete", "Backspace", "Enter", "F2", "h", "H"].includes(e.key)) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const t = S.player.time();
  const go = (fn) => { e.preventDefault(); fn(); };
  if (mod && k === "z") return go(() => (e.shiftKey ? redo() : undo()));
  if (mod && k === "y") return go(redo);
  if (mod && k === "e") return go(startExport);
  if (mod && k === "s") return go(save);
  if (mod && k === "d") return go(A.duplicate);
  if (mod && k === "c") return go(A.copy);
  if (mod && k === "v") return go(A.paste);
  if (mod && k === "b") return go(A.split);
  if (mod && k === "a") return go(() => select(M.allClips(S.p).map((x) => x.clip.id)));
  if (mod) return;
  if (e.key === "?") return go(openShortcuts);
  if (e.key === " ") return go(() => S.player.toggle());
  if (k === "s") return go(A.split);
  if (k === "q") return go(() => A.trimTo("left"));
  if (k === "w") return go(() => A.trimTo("right"));
  if (k === "t") return go(() => A.addText());
  if (k === "m") return go(A.addMarker);
  if (e.key === "Delete" || e.key === "Backspace") return go(A.del);
  if (e.key === "Escape") return go(() => select([]));
  if (e.key === "Home") return go(() => S.player.seek(0));
  if (e.key === "End") return go(() => S.player.seek(endOfMain(S.p)));
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const d = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : 1 / FPS);
    return go(() => S.player.seek(Math.round((t + d) * FPS) / FPS));
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") return go(() => jumpCut(e.key === "ArrowDown" ? 1 : -1));
  if (e.key === "+" || e.key === "=") return go(() => S.timeline.zoomBy(1.4));
  if (e.key === "-") return go(() => S.timeline.zoomBy(1 / 1.4));
}

export function jumpCut(dir) {
  const t = S.player.time();
  const pts = [0, ...M.mainTrack(S.p).clips.map((c) => c.start), endOfMain(S.p), ...S.p.markers.map((m) => m.t)].sort((x, y) => x - y);
  const target = dir > 0 ? pts.find((x) => x > t + 1e-3) : [...pts].reverse().find((x) => x < t - 1e-3);
  if (target != null) S.player.seek(target);
}
