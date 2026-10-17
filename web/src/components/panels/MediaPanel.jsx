import { useEffect, useRef, useState } from "react";
import { UploadSimple, Plus, Folder, CaretLeft, MusicNotes, CircleNotch, ClosedCaptioning, FolderOpen, Image as ImageIcon } from "@phosphor-icons/react";
import { api, fmt, tildify } from "../../core/util.js";
import { S, commit } from "../../core/store.js";
import * as Media from "../../core/media.js";
import * as A from "../../core/actions.js";
import { useBus, cn } from "../../lib/hooks.js";
import { Button, Segmented, Empty, Progress, Tip } from "../ui/index.jsx";
import { toast } from "sonner";
import { wave } from "../../lib/mascot.js";

export async function importToProject(path) {
  const m = await Media.importPath(path);
  if (!S.p.media.includes(m.id)) commit(() => A.ensureMediaInProject(m.id), null, { noTimeline: true });
  return m;
}

const uploads = new Map(); // name -> progress (shared so the panel can show it)
export async function uploadFiles(files, at, target) {
  const added = [];
  for (const f of files) {
    uploads.set(f.name, 0);
    try {
      const m = await Media.upload(f, (p) => { uploads.set(f.name, p); window.dispatchEvent(new Event("uploads")); });
      commit(() => A.ensureMediaInProject(m.id), null, { noTimeline: true });
      added.push(m);
    } catch (e) { toast.error(`${f.name}: ${e.message}`); }
    uploads.delete(f.name);
    window.dispatchEvent(new Event("uploads"));
  }
  if (at != null) for (const m of added) A.addMedia(m.id, at, target);
  return added;
}

export default function MediaPanel() {
  useBus(["changed", "media"]);
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("project"); // project | browse
  const [drag, setDrag] = useState(false);
  const [, force] = useState(0);
  const fileRef = useRef();
  useEffect(() => { const h = () => force((x) => x + 1); window.addEventListener("uploads", h); return () => window.removeEventListener("uploads", h); }, []);

  const list = S.p.media.map(Media.meta).filter((m) => m && (filter === "all" || m.kind === filter));

  return (
    <div className={cn("flex min-h-full flex-col p-3", drag && "bg-accent-soft")}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDrag(false); uploadFiles([...e.dataTransfer.files]); }}>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Button variant="primary" onClick={() => fileRef.current.click()}><UploadSimple size={15} /> Import</Button>
        <Button variant={view === "browse" ? "soft" : "secondary"} onClick={() => setView(view === "browse" ? "project" : "browse")}><FolderOpen size={15} /> Browse</Button>
        <input ref={fileRef} type="file" multiple accept="video/*,image/*,audio/*" hidden onChange={(e) => { uploadFiles([...e.target.files]); e.target.value = ""; }} />
      </div>
      <Segmented size="sm" value={filter} onChange={setFilter} options={[["all", "All"], ["video", "Video"], ["image", "Photo"], ["audio", "Audio"]]} />
      {[...uploads].map(([name, p]) => (
        <div key={name} className="my-1.5 flex items-center gap-2 text-xs"><span className="flex-1 truncate">{name}</span><Progress value={p} className="w-20" /></div>
      ))}
      {view === "browse" ? <Browser filter={filter} onBack={() => setView("project")} /> : (
        <>
          {!list.length ? (
            <Empty art={wave} title="No media yet">Drop files here, or <button className="text-accent hover:underline cursor-pointer" onClick={() => setView("browse")}>browse folders</button>.</Empty>
          ) : (
            <div className="mt-2 grid grid-cols-3 gap-2">
              {list.map((m) => <MediaTile key={m.id} m={m} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Thumb({ kind, path, className }) {
  if (kind === "audio") return <div className={cn("flex items-center justify-center bg-surface-3 text-muted", className)}><MusicNotes size={20} /></div>;
  return <div className={cn("bg-black bg-cover bg-center", className)} style={{ backgroundImage: `url("/api/thumb?path=${encodeURIComponent(path)}")` }} />;
}

function MediaTile({ m }) {
  const status = m.working ? `${m.working.task === "transcript" ? "Transcribing" : "Preparing"} ${Math.round(m.working.progress * 100)}%`
    : !m.ready?.proxy ? "Preparing…" : null;
  return (
    <div draggable onDragStart={(e) => { e.dataTransfer.setData("text/x-mid", m.id); e.dataTransfer.effectAllowed = "copy"; }}
      onDoubleClick={() => A.addMedia(m.id)} title={m.name}
      className="group relative cursor-grab overflow-hidden rounded-lg border border-line bg-surface-2 hover:border-line-strong">
      <Thumb kind={m.kind} path={m.path} className="aspect-square" />
      {m.kind !== "image" && <span className="absolute right-1 top-1 rounded bg-black/70 px-1 font-mono text-[10px]">{fmt(m.duration).replace(/\.\d$/, "")}</span>}
      {m.ready?.words && <Tip label="Has a transcript"><span className="absolute left-1 top-1 rounded bg-accent/90 p-0.5"><ClosedCaptioning size={10} /></span></Tip>}
      {status && <span className="absolute inset-x-1 bottom-6 flex items-center gap-1 rounded bg-black/75 px-1 py-0.5 text-[9.5px] text-warn"><CircleNotch size={9} className="animate-spin" />{status}</span>}
      <button onClick={() => A.addMedia(m.id)} title="Add at playhead"
        className="absolute bottom-6 right-1 flex h-6 w-6 items-center justify-center rounded-md bg-accent text-white opacity-0 transition group-hover:opacity-100 cursor-pointer">
        <Plus size={14} />
      </button>
      <div className="truncate px-1.5 py-1 text-[10.5px] text-muted">{m.name}</div>
    </div>
  );
}

function Browser({ filter, onBack }) {
  const [dir, setDir] = useState(null);
  const [data, setData] = useState(null);
  useEffect(() => { api("/api/browse" + (dir ? "?dir=" + encodeURIComponent(dir) : "")).then(setData); }, [dir]);
  if (!data) return <div className="py-6 text-center text-xs text-subtle">Loading…</div>;
  if (!data.dir) return (
    <div className="mt-2 space-y-0.5">
      {data.roots.map((r) => (
        <button key={r.path} onClick={() => setDir(r.path)} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-surface-3 cursor-pointer">
          <Folder size={15} className="text-accent" /><span className="truncate">{r.name}</span>
        </button>
      ))}
    </div>
  );
  const items = data.items.filter((it) => it.kind === "dir" || filter === "all" || it.kind === filter);
  return (
    <div className="mt-2">
      <div className="mb-2 flex items-center gap-1 text-xs text-muted">
        <Button size="icon-sm" variant="ghost" onClick={() => setDir(data.parent && !/^(\/home|\/Users|[A-Za-z]:\\Users)$/.test(data.parent) ? data.parent : null)}><CaretLeft size={15} /></Button>
        <span className="truncate">{tildify(data.dir)}</span>
      </div>
      <div className="space-y-0.5">
        {items.filter((i) => i.kind === "dir").map((it) => (
          <button key={it.path} onClick={() => setDir(it.path)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-3 cursor-pointer">
            <Folder size={15} className="text-subtle" /><span className="truncate">{it.name}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {items.filter((i) => i.kind !== "dir").map((it) => (
          <div key={it.path} draggable title={it.name}
            onDragStart={(e) => { e.dataTransfer.setData("text/x-path", it.path); e.dataTransfer.effectAllowed = "copy"; }}
            onDoubleClick={async () => { const m = await importToProject(it.path); A.addMedia(m.id); }}
            className="group relative cursor-grab overflow-hidden rounded-lg border border-line bg-surface-2 hover:border-line-strong">
            <Thumb kind={it.kind} path={it.path} className="aspect-square" />
            <button onClick={async () => { const m = await importToProject(it.path); A.addMedia(m.id); }} title="Add at playhead"
              className="absolute bottom-6 right-1 flex h-6 w-6 items-center justify-center rounded-md bg-accent text-white opacity-0 transition group-hover:opacity-100 cursor-pointer">
              <Plus size={14} />
            </button>
            <div className="truncate px-1.5 py-1 text-[10.5px] text-muted">{it.name}</div>
          </div>
        ))}
      </div>
      {!items.length && <Empty icon={ImageIcon} title="Nothing here">No {filter === "all" ? "media" : filter} files in this folder.</Empty>}
    </div>
  );
}
