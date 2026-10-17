import { useEffect, useRef, useState } from "react";
import { Plus, UploadSimple, DotsThree, FilmSlate, Trash, PencilSimple, CheckCircle, Sun, Moon } from "@phosphor-icons/react";
import { useTheme } from "../lib/theme.js";
import { api, fmt, fmtSize } from "../core/util.js";
import * as Media from "../core/media.js";
import { Button, IconBtn, Menu, Empty } from "./ui/index.jsx";
import { toast } from "sonner";
import { mark, sleep } from "../lib/mascot.js";

const go = (id) => { location.hash = "#/p/" + id; };

export default function Home() {
  const [projects, setProjects] = useState(null);
  const [recent, setRecent] = useState([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState("");
  const [theme, toggleTheme] = useTheme();
  const fileRef = useRef();

  const load = () => {
    api("/api/projects").then(setProjects);
    api("/api/recent").then(setRecent);
  };
  useEffect(() => { document.title = "Shorts"; load(); }, []);

  const creating = useRef(false);
  const create = async (path) => {
    if (creating.current) return;  // ignore double clicks
    creating.current = true;
    setBusy(path ? "Opening…" : "Creating…");
    try { const { id } = await api("/api/projects", path ? { from: path } : { name: "Untitled" }); go(id); }
    catch (e) { toast.error("Could not create project: " + e.message); setBusy(""); creating.current = false; }
  };

  const uploadAndCreate = async (files) => {
    if (!files.length) return;
    setBusy(`Uploading ${files.length} file${files.length > 1 ? "s" : ""}…`);
    try {
      const metas = [];
      for (const f of files) metas.push(await Media.upload(f));
      const { id } = await api("/api/projects", { from: metas[0].path });
      if (metas.length > 1) {
        const p = await api("/api/projects/" + id);
        for (const m of metas.slice(1)) {
          p.media.push(m.id);
          if (m.kind !== "audio") p.tracks[0].clips.push({ id: Math.random().toString(16).slice(2, 10), mid: m.id, in: 0, out: m.kind === "image" ? 3 : m.duration });
        }
        await api("/api/projects/" + id, p, "PUT");
      }
      go(id);
    } catch (e) { toast.error(e.message); setBusy(""); }
  };

  return (
    <div className="flex h-full flex-col"
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); uploadAndCreate([...e.dataTransfer.files]); }}>
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line bg-surface px-6">
        <Logo />
        <span className="text-[15px] font-semibold tracking-tight">Shorts</span>
        <span className="flex-1" />
        {busy && <span className="mr-2 text-xs text-muted">{busy}</span>}
        <IconBtn icon={theme === "dark" ? Sun : Moon} label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggleTheme} side="bottom" />
        <Button onClick={() => fileRef.current.click()}><UploadSimple size={15} />Import</Button>
        <Button variant="primary" onClick={() => create()}><Plus size={15} />New project</Button>
        <input ref={fileRef} type="file" accept="video/*,image/*" multiple hidden onChange={(e) => uploadAndCreate([...e.target.files])} />
      </header>

      <main className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[1900px] px-6 py-6">
          <h2 className="mb-3 text-[13px] font-semibold">Projects</h2>
          {projects && !projects.length && (
            <div className="rounded-lg border border-dashed border-line-strong">
              <Empty art={sleep} title="No projects yet">Create one, import a video, or drop files on this page.</Empty>
            </div>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
            {projects?.map((p) => <ProjectCard key={p.id} p={p} reload={load} />)}
          </div>

          {recent.length > 0 && <>
            <h2 className="mt-10 mb-3 text-[13px] font-semibold">Recent recordings</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {recent.map((r) => (
                <button key={r.path} onClick={() => create(r.path)} title={"New project from " + r.name}
                  className="overflow-hidden rounded-lg border border-line bg-surface text-left transition-colors hover:border-line-strong cursor-pointer">
                  <div className="aspect-[4/5] bg-black bg-cover bg-center" style={{ backgroundImage: `url("/api/thumb?path=${encodeURIComponent(r.path)}")` }} />
                  <div className="px-2.5 py-2">
                    <div className="truncate text-xs font-medium">{r.name}</div>
                    <div className="truncate text-[11px] text-subtle">{new Date(r.mtime * 1000).toLocaleDateString()} · {fmtSize(r.size)}</div>
                  </div>
                </button>
              ))}
            </div>
          </>}
        </div>
      </main>

      {drag && (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-surface/80">
          <div className="text-sm font-medium">Drop to start a project</div>
        </div>
      )}
    </div>
  );
}

export function Logo({ size = 26 }) {
  return <img src={mark} alt="" width={size} height={size} draggable={false} className="shrink-0" />;
}

function ProjectCard({ p, reload }) {
  return (
    <div onClick={() => go(p.id)}
      className="group relative cursor-pointer overflow-hidden rounded-lg border border-line bg-surface transition-colors hover:border-line-strong">
      <div className="aspect-[4/5] bg-surface-3 bg-cover bg-center" style={p.thumb ? { backgroundImage: `url("/api/thumb?path=${encodeURIComponent(p.thumb)}")` } : {}}>
        {!p.thumb && <div className="flex h-full items-center justify-center text-subtle"><FilmSlate size={28} /></div>}
      </div>
      {p.exported && (
        <span className="absolute left-2.5 top-2.5 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-success">
          <CheckCircle size={11} weight="fill" /> Exported
        </span>
      )}
      <div className="absolute right-2 top-2 opacity-0 transition group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
        <Menu trigger={<Button size="icon-sm" variant="secondary" className="!bg-black/70"><DotsThree size={15} /></Button>} items={[
          { label: "Rename", icon: PencilSimple, onSelect: async () => {
            const n = prompt("Project name", p.name);
            if (!n) return;
            const full = await api("/api/projects/" + p.id); full.name = n;
            await api("/api/projects/" + p.id, full, "PUT"); reload();
          } },
          "-",
          { label: "Delete project", icon: Trash, danger: true, onSelect: async () => {
            if (!confirm(`Delete "${p.name}"? Your media files are kept.`)) return;
            await api("/api/projects/" + p.id, undefined, "DELETE"); reload();
          } },
        ]} />
      </div>
      <div className="px-3 py-2.5">
        <div className="truncate text-[13px] font-medium">{p.name}</div>
        <div className="text-[11px] text-subtle">{fmt(p.duration).replace(/\.\d$/, "")} · {new Date(p.updated * 1000).toLocaleDateString()}</div>
      </div>
    </div>
  );
}
