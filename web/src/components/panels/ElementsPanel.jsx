import { Square, Circle, ArrowRight, Minus } from "@phosphor-icons/react";
import * as A from "../../core/actions.js";
import * as Media from "../../core/media.js";
import { S } from "../../core/store.js";
import { useBus } from "../../lib/hooks.js";
import { Section } from "../ui/index.jsx";

const STICKERS = ("🔥 😂 🤯 😳 💀 👀 ✅ ❌ 💡 🧠 🤖 💻 📈 📉 🏆 🎯 ⏰ 💸 💰 🚀 🤝 🙏 😤 😎 🥲 😭 🤔 👇 👆 👉 ⚡ ❤️ 💯 ⚠️ 🤫 🙌 😅 🫡 💪 🎉 🐐 🦄 🇺🇸 🇵🇹 🌉 ✈️ 📱 🎓 💼 ⭐ ❓ ❗ 🔔 📌").split(" ");

const SHAPES = [
  ["rect", "Box", Square], ["circle", "Circle", Circle], ["arrow", "Arrow", ArrowRight], ["underline", "Underline", Minus],
];

function PhoneMockup() {
  useBus(["changed", "media"]);
  const vids = S.p.media.map(Media.meta).filter((m) => m?.kind === "video");
  return (
    <Section title="Phone mockup">
      <p className="mb-2 text-[11px] text-subtle">Pick a video to play inside a phone, on a new row at the playhead. Move and resize it on the preview.</p>
      {!vids.length ? <p className="text-xs text-subtle">Import a video first (Media).</p> : (
        <div className="grid grid-cols-3 gap-2">
          {vids.map((m) => (
            <button key={m.id} title={m.name} onClick={() => A.addPhone(m.id)}
              className="overflow-hidden rounded-lg border border-line bg-surface-2 text-left hover:border-accent cursor-pointer">
              <div className="aspect-[9/16] bg-black bg-cover bg-center" style={{ backgroundImage: `url("/api/thumb?path=${encodeURIComponent(m.path)}")` }} />
              <div className="truncate px-1.5 py-1 text-[10.5px] text-muted">{m.name}</div>
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

export default function ElementsPanel() {
  return (
    <div>
      <PhoneMockup />
      <Section title="Shapes">
        <div className="grid grid-cols-4 gap-2">
          {SHAPES.map(([k, l, I]) => (
            <button key={k} onClick={() => A.addShape(k)}
              className="flex flex-col items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-3 text-[11px] text-muted hover:border-accent hover:text-fg cursor-pointer">
              <I size={20} className="text-[#ff3b30]" />{l}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Stickers">
        <div className="grid grid-cols-6 gap-1">
          {STICKERS.map((e) => (
            <button key={e} onClick={() => A.addSticker(e)} title="Add at playhead"
              className="flex aspect-square items-center justify-center rounded-lg text-2xl hover:bg-surface-3 cursor-pointer"
              style={{ fontFamily: "Noto Color Emoji" }}>{e}</button>
          ))}
        </div>
      </Section>
    </div>
  );
}
