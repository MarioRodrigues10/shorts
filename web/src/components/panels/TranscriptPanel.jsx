import { useEffect, useRef, useState } from "react";
import { Trash, HighlighterCircle, Smiley, ArrowElbowDownLeft, PencilSimple, Waveform, Repeat, MicrophoneSlash, ClosedCaptioning, Article } from "@phosphor-icons/react";
import { S, commit, undo, words as tlWords } from "../../core/store.js";
import * as M from "../../core/model.js";
import * as A from "../../core/actions.js";
import { useBus } from "../../lib/hooks.js";
import { Button, Empty, Popover, Tip, Select } from "../ui/index.jsx";
import { timeListeners } from "../Stage.jsx";
import { listen } from "../../lib/mascot.js";
import { toast } from "sonner";

const EMOJI = "🚀 💰 🔥 😂 🤯 😳 💀 👀 ✅ ❌ 💡 🧠 🤖 💻 📈 📉 🏆 🎯 ⏰ 💸 🤝 🙏 😤 😎 🥲 😭 🤔 👇 ⚡ 🌉 🇺🇸 🇵🇹 🎓 💼 📱 🐐 🦄 🎉 ❤️ 💯 ⚠️ 🤫 🙌 😅 🫡 💪 🧑‍💻 ✈️".split(" ");

export default function TranscriptPanel() {
  useBus(["changed", "words", "media"]);
  const [sel, setSel] = useState(null); // [a, b]
  const [editing, setEditing] = useState(null);
  const [maxPause, setMaxPause] = useState(0.3);
  const boxRef = useRef();
  const drag = useRef(null);
  const ws = tlWords();

  // follow playback without re-rendering
  useEffect(() => {
    let last = -1;
    const f = (t) => {
      const list = tlWords();
      let a = -1;
      for (let i = 0; i < list.length; i++) { if (list[i].os <= t + 0.01) a = i; else break; }
      if (a >= 0 && t > list[a].oe + 0.3) a = -1;
      if (a === last) return;
      boxRef.current?.querySelector(".w.active")?.classList.remove("active");
      const el = boxRef.current?.querySelector(`.w[data-i="${a}"]`);
      if (el) {
        el.classList.add("active");
        if (S.player.playing) {
          const box = boxRef.current.parentElement.closest(".overflow-y-auto") || boxRef.current;
          const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
          if (r.top < br.top + 40 || r.bottom > br.bottom - 40) box.scrollTop += r.top - br.top - br.height / 3;
        }
      }
      last = a;
    };
    timeListeners.add(f);
    return () => timeListeners.delete(f);
  }, []);
  useEffect(() => {
    const up = () => {
      if (drag.current && !drag.current.moved) { const w = tlWords()[drag.current.anchor]; if (w) S.player.seek(w.os + 0.001); }
      drag.current = null;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const lo = sel ? Math.min(...sel) : -1, hi = sel ? Math.max(...sel) : -1;
  const selected = sel ? ws.slice(lo, hi + 1) : [];

  const act = (what) => {
    if (!sel) return;
    if (what === "cut") {
      commit(() => M.cutWords(S.p, ws, lo, hi));
      toast(`Cut ${selected.length} word${selected.length > 1 ? "s" : ""}`, { action: { label: "Undo", onClick: undo } });
      setSel(null);
    } else if (what === "emph") {
      const all = selected.every((w) => w.emph);
      commit(() => selected.forEach((w) => M.editWord(S.p, w, { emph: !all })), null, { noTimeline: true });
    } else if (what === "break") commit(() => M.editWord(S.p, selected[0], { br: !selected[0].br }), null, { noTimeline: true });
    else if (what === "edit") setEditing(lo);
  };

  const onKey = (e) => {
    if (!sel) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); act("cut"); }
    else if (e.key.toLowerCase() === "h") act("emph");
    else if (e.key === "Enter") { e.preventDefault(); act("break"); }
    else if (e.key === "F2") { e.preventDefault(); act("edit"); }
    else if (e.key === "Escape") setSel(null);
  };

  const tools = (
    <div className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-1">
        <Tip label="Cut every pause longer than the limit"><Button size="sm" variant="ghost" onClick={() => A.removeSilences({ maxPause })}><Waveform size={14} />Silences</Button></Tip>
        <Tip label="Cut false starts and repeated takes"><Button size="sm" variant="ghost" onClick={A.cutRetakes}><Repeat size={14} />Retakes</Button></Tip>
        <Tip label="Cut um / uh"><Button size="sm" variant="ghost" onClick={A.cutFillers}><MicrophoneSlash size={14} />Fillers</Button></Tip>
        <span className="flex-1" />
        <select value={maxPause} onChange={(e) => setMaxPause(+e.target.value)} title="Pauses longer than this are cut"
          className="h-7 rounded-md border border-line bg-surface-2 px-1.5 text-xs text-muted outline-none">
          {[0.2, 0.3, 0.4, 0.6, 1].map((v) => <option key={v} value={v}>max {v}s</option>)}
        </select>
      </div>
      {sel && (
        <div className="mt-2 flex items-center gap-1 rounded-lg bg-accent-soft px-2 py-1.5">
          <span className="flex-1 text-xs font-medium text-accent-ink">{selected.length} word{selected.length > 1 ? "s" : ""}</span>
          <Tip label="Delete from the video" kbd="Del"><Button size="icon-sm" variant="ghost" onClick={() => act("cut")}><Trash size={14} /></Button></Tip>
          <Tip label="Highlight in captions" kbd="H"><Button size="icon-sm" variant="ghost" onClick={() => act("emph")}><HighlighterCircle size={14} /></Button></Tip>
          <Popover side="bottom" align="end" trigger={<Button size="icon-sm" variant="ghost" title="Add emoji"><Smiley size={14} /></Button>}>
            <div className="grid grid-cols-8 gap-0.5">
              {EMOJI.map((e) => (
                <button key={e} className="h-8 w-8 rounded-md text-lg hover:bg-surface-4 cursor-pointer" style={{ fontFamily: "Noto Color Emoji" }}
                  onClick={() => commit(() => M.editWord(S.p, selected[0], { emoji: e }), null, { noTimeline: true })}>{e}</button>
              ))}
              <button className="col-span-8 mt-1 rounded-md py-1 text-xs text-muted hover:bg-surface-4 cursor-pointer"
                onClick={() => commit(() => M.editWord(S.p, selected[0], { emoji: "" }), null, { noTimeline: true })}>Remove emoji</button>
            </div>
          </Popover>
          <Tip label="Start a new caption here" kbd="Enter"><Button size="icon-sm" variant="ghost" onClick={() => act("break")}><ArrowElbowDownLeft size={14} /></Button></Tip>
          <Tip label="Fix the word" kbd="F2"><Button size="icon-sm" variant="ghost" onClick={() => act("edit")}><PencilSimple size={14} /></Button></Tip>
        </div>
      )}
    </div>
  );

  if (!M.mainTrack(S.p).clips.length) return <Empty icon={Article} title="Nothing to transcribe yet">Add a video to the main track first.</Empty>;
  if (!ws.length) {
    const busy = A.transcribing();
    return (
      <Empty art={busy ? listen : undefined} icon={ClosedCaptioning} title={busy ? "Transcribing…" : "Edit your video by editing text"}>
        {busy ? "Words appear as they're ready." : <>Delete words to cut them from the video.
          <Button variant="primary" className="mx-auto mt-4" onClick={() => A.autoCaptions()}><ClosedCaptioning size={15} />Transcribe timeline</Button></>}
      </Empty>
    );
  }

  // paragraphs
  const paras = [];
  let cur = [];
  ws.forEach((w, i) => {
    const prev = ws[i - 1];
    if (prev && /[.?!]["')]*$/.test(prev.text) && cur.length >= 10) { paras.push(cur); cur = []; }
    cur.push(i);
  });
  if (cur.length) paras.push(cur);

  return (
    <div onKeyDown={onKey}>
      {tools}
      <div ref={boxRef} tabIndex={0} data-transcript="1" className="px-4 py-3 text-[14.5px] leading-[2] outline-none">
        {paras.map((idxs, pi) => (
          <p key={pi} className="mb-3">
            {idxs.map((i) => {
              const w = ws[i], prev = ws[i - 1];
              const gap = prev && prev.clipId === w.clipId ? w.os - prev.oe : 0;
              return (
                <span key={w.key}>
                  {prev && prev.clipId !== w.clipId && <span className="cutmark" title="Cut point"> ✂ </span>}
                  {gap >= 0.45 && (
                    <><span className="gap-chip" title="Pause. Click to remove" onClick={() => commit(() => M.cutRange(S.p, prev.oe + 0.1, w.os - 0.06))}>{gap.toFixed(1)}s</span>{" "}</>
                  )}
                  {editing === i ? (
                    <WordEditor w={w} onDone={() => { setEditing(null); boxRef.current?.focus(); }} onNext={(d) => setEditing(i + d)} />
                  ) : (
                    <span data-i={i}
                      className={["w", w.emph && "emph", w.p < 0.25 && "low", w.br && "br", i >= lo && i <= hi && "sel"].filter(Boolean).join(" ")}
                      onMouseDown={(e) => {
                        e.preventDefault(); boxRef.current.focus();
                        if (e.shiftKey && sel) { setSel([sel[0], i]); return; }
                        drag.current = { anchor: i, moved: false }; setSel([i, i]);
                      }}
                      onMouseEnter={() => { if (drag.current) { if (i !== drag.current.anchor) drag.current.moved = true; setSel([drag.current.anchor, i]); } }}
                      onDoubleClick={() => setEditing(i)}>
                      {w.text}{w.emoji && <span className="ml-0.5 text-xs">{w.emoji}</span>}
                    </span>
                  )}{" "}
                </span>
              );
            })}
          </p>
        ))}
        <p className="text-[11px] leading-relaxed text-subtle"><b>Del</b> cut · <b>Double-click</b> fix · <b>H</b> highlight</p>
      </div>
    </div>
  );
}

function WordEditor({ w, onDone, onNext }) {
  const [v, setV] = useState(w.text);
  const done = useRef(false);
  const finish = (ok) => {
    if (done.current) return; done.current = true;
    const t = v.trim();
    if (ok && t && t !== w.text) commit(() => M.editWord(S.p, w, { text: t }), null, { noTimeline: true });
    onDone();
  };
  return (
    <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={() => finish(true)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
        if (e.key === "Tab") { e.preventDefault(); finish(true); onNext(e.shiftKey ? -1 : 1); }
      }}
      className="rounded-md border border-accent bg-surface-2 px-1 text-[14.5px] outline-none" style={{ width: Math.max(60, v.length * 9 + 24) }} />
  );
}
