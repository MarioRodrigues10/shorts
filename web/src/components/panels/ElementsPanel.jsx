import { Square, Circle, ArrowRight, Minus } from "@phosphor-icons/react";
import * as A from "../../core/actions.js";
import { Section } from "../ui/index.jsx";

const STICKERS = ("🔥 😂 🤯 😳 💀 👀 ✅ ❌ 💡 🧠 🤖 💻 📈 📉 🏆 🎯 ⏰ 💸 💰 🚀 🤝 🙏 😤 😎 🥲 😭 🤔 👇 👆 👉 ⚡ ❤️ 💯 ⚠️ 🤫 🙌 😅 🫡 💪 🎉 🐐 🦄 🇺🇸 🇵🇹 🌉 ✈️ 📱 🎓 💼 ⭐ ❓ ❗ 🔔 📌").split(" ");

const SHAPES = [
  ["rect", "Box", Square], ["circle", "Circle", Circle], ["arrow", "Arrow", ArrowRight], ["underline", "Underline", Minus],
];

export default function ElementsPanel() {
  return (
    <div>
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
