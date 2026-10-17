import { useEffect, useRef, useState } from "react";
import { Microphone, Stop, Play, Pause, Plus, MusicNotes, CircleNotch } from "@phosphor-icons/react";
import { api, fmt } from "../../core/util.js";
import { S } from "../../core/store.js";
import * as Media from "../../core/media.js";
import * as A from "../../core/actions.js";
import { useBus } from "../../lib/hooks.js";
import { Button, Section, Empty, Tip } from "../ui/index.jsx";
import { importToProject, uploadFiles } from "./MediaPanel.jsx";
import { toast } from "sonner";

// one shared <audio> for previews
const previewEl = typeof Audio !== "undefined" ? new Audio() : null;

function PreviewBtn({ url }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const stop = () => setPlaying(false);
    previewEl.addEventListener("ended", stop);
    previewEl.addEventListener("pause", stop);
    return () => { previewEl.removeEventListener("ended", stop); previewEl.removeEventListener("pause", stop); };
  }, []);
  return (
    <button title={playing ? "Stop" : "Preview"} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-4 text-fg hover:bg-accent cursor-pointer"
      onClick={(e) => {
        e.stopPropagation();
        if (playing) { previewEl.pause(); return; }
        previewEl.src = url; previewEl.currentTime = 0; previewEl.play(); setPlaying(true);
      }}>
      {playing ? <Pause size={12} weight="fill" /> : <Play size={12} weight="fill" className="ml-0.5" />}
    </button>
  );
}

function Row({ name, sub, url, onAdd, draggablePath }) {
  return (
    <div draggable={!!draggablePath} onDragStart={(e) => { e.dataTransfer.setData("text/x-path", draggablePath); }}
      onDoubleClick={onAdd}
      className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-3 cursor-grab">
      <PreviewBtn url={url} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]">{name}</div>
        {sub && <div className="truncate text-[11px] text-subtle">{sub}</div>}
      </div>
      <Tip label="Add at playhead"><Button size="icon-sm" variant="ghost" className="opacity-0 group-hover:opacity-100" onClick={onAdd}><Plus size={14} /></Button></Tip>
    </div>
  );
}

const fileUrl = (path) => `/api/audiofile?path=${encodeURIComponent(path)}`;

export default function AudioPanel() {
  useBus(["changed", "media"]);
  const [sfx, setSfx] = useState([]);
  const [music, setMusic] = useState(null);
  useEffect(() => {
    api("/api/sfx").then(setSfx);
    api("/api/audio-library").then(setMusic);
  }, []);
  const add = async (path) => { const m = await importToProject(path); A.addMedia(m.id); };
  const inProject = S.p.media.map(Media.meta).filter((m) => m?.kind === "audio");

  return (
    <div>
      <Recorder />
      {inProject.length > 0 && (
        <Section title="In this project">
          {inProject.map((m) => <Row key={m.id} name={m.name} sub={fmt(m.duration).replace(/\.\d$/, "")} url={Media.previewUrl(m.id)} onAdd={() => A.addMedia(m.id)} />)}
        </Section>
      )}
      <Section title="Sound effects">
        <div className="mt-1 grid grid-cols-2 gap-1">
          {sfx.map((s) => (
            <div key={s.name} draggable onDragStart={(e) => e.dataTransfer.setData("text/x-path", s.path)}
              className="group flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2 py-1.5 hover:border-line-strong cursor-grab">
              <PreviewBtn url={fileUrl(s.path)} />
              <span className="flex-1 truncate text-xs">{s.name}</span>
              <button onClick={() => add(s.path)} title="Add at playhead" className="text-subtle opacity-0 group-hover:opacity-100 hover:text-fg cursor-pointer"><Plus size={14} /></button>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Music from your folders">
        {!music ? <div className="py-4 text-center text-xs text-subtle"><CircleNotch size={14} className="mx-auto animate-spin" /></div> :
          !music.length ? <Empty icon={MusicNotes} title="No music found">Add audio files to <b>~/Music</b>, or import them in Media.</Empty> :
            music.map((f) => <Row key={f.path} name={f.name} sub={f.dir} url={fileUrl(f.path)} draggablePath={f.path} onAdd={() => add(f.path)} />)}
      </Section>
    </div>
  );
}

function Recorder() {
  const [state, setState] = useState("idle"); // idle | countdown | rec | saving
  const [count, setCount] = useState(3);
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const rec = useRef(null);

  const start = async () => {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { toast.error("Microphone not available: " + e.message); return; }
    const t0 = S.player.time();
    setState("countdown");
    for (let i = 3; i > 0; i--) { setCount(i); await new Promise((r) => setTimeout(r, 700)); }
    const ac = new AudioContext();
    const an = ac.createAnalyser();
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const chunks = [];
    const mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const began = performance.now();
    const tick = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
      setLevel(peak); setSecs((performance.now() - began) / 1000);
    }, 80);
    mr.onstop = async () => {
      clearInterval(tick);
      stream.getTracks().forEach((tr) => tr.stop());
      ac.close();
      S.player.pause();
      S.player.muteAll = false;
      setState("saving");
      const type = mr.mimeType || "audio/webm";
      const ext = type.includes("ogg") ? "ogg" : "webm";
      const name = `Voiceover ${new Date().toLocaleTimeString().replace(/:/g, "-")}.${ext}`;
      try { await uploadFiles([new File(chunks, name, { type })], t0, { kind: "audio", newTrack: true }); toast.success("Voiceover added"); }
      catch (e) { toast.error(e.message); }
      setState("idle"); setSecs(0); setLevel(0);
    };
    rec.current = mr;
    // play the timeline (muted) so you can talk over the video
    S.player.muteAll = true;
    S.player.seek(t0);
    S.player.play();
    mr.start(250);
    setState("rec");
  };
  const stop = () => rec.current?.state === "recording" && rec.current.stop();

  return (
    <Section title="Voiceover">
      {state === "idle" && (
        <Button className="mt-1 w-full justify-center" onClick={start}><Microphone size={15} />Record voiceover</Button>
      )}
      {state === "countdown" && <div className="mt-1 flex h-9 items-center justify-center rounded-lg bg-surface-3 text-lg font-bold tabular-nums">{count}</div>}
      {state === "rec" && (
        <div className="mt-1 flex items-center gap-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
          <span className="font-mono text-sm tabular-nums">{fmt(secs)}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-4"><div className="h-full bg-success transition-[width] duration-75" style={{ width: Math.min(100, level * 140) + "%" }} /></div>
          <Button size="sm" variant="danger" onClick={stop}><Stop size={12} weight="fill" />Stop</Button>
        </div>
      )}
      {state === "saving" && <div className="mt-1 flex items-center justify-center gap-2 py-2 text-xs text-muted"><CircleNotch size={14} className="animate-spin" />Saving…</div>}
    </Section>
  );
}
