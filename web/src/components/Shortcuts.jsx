import { useEffect, useState } from "react";
import { on, emit } from "../core/util.js";
import { Dialog, Kbd } from "./ui/index.jsx";

export const openShortcuts = () => emit("shortcuts");

const GROUPS = [
  ["Playback", [["Space", "Play / pause"], ["← →", "Previous / next frame"], ["Shift  ← →", "Back / forward 1s"], ["↑ ↓", "Previous / next cut"], ["Home  End", "Start / end"]]],
  ["Editing", [["S", "Split at playhead"], ["Q", "Delete left of playhead"], ["W", "Delete right of playhead"], ["Del", "Delete selection"], ["Ctrl D", "Duplicate"], ["Ctrl C  Ctrl V", "Copy / paste"], ["T", "Add text"], ["M", "Add marker"]]],
  ["General", [["Ctrl Z", "Undo"], ["Ctrl Y", "Redo"], ["+ −", "Zoom timeline"], ["Ctrl E", "Export"], ["\\", "Bigger preview"], ["?", "This list"]]],
];

export default function Shortcuts() {
  const [open, setOpen] = useState(false);
  useEffect(() => on("shortcuts", () => setOpen(true)), []);
  return (
    <Dialog open={open} onOpenChange={setOpen} title="Keyboard shortcuts" className="w-[620px]">
      <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5">
        {GROUPS.map(([g, rows]) => (
          <div key={g}>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{g}</div>
            {rows.map(([k, d]) => (
              <div key={k} className="flex items-center justify-between gap-3 py-1 text-[13px]">
                <span className="text-muted">{d}</span>
                <span className="flex gap-1">{k.split(/\s{2,}/).map((x) => <Kbd key={x}>{x}</Kbd>)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
