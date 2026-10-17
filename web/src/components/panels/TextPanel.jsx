import { useEffect, useRef } from "react";
import { TEXT_PRESETS, drawText } from "../../core/layer.js";
import * as A from "../../core/actions.js";

function Preview({ preset }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current, ctx = c.getContext("2d");
    ctx.fillStyle = "#23232c"; ctx.fillRect(0, 0, c.width, c.height);
    const s = c.width / 1080;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    const label = preset.label === "Minimal" ? "Clean & simple" : preset.label;
    drawText(ctx, { W: 1080, H: c.height / s }, { text: label, style: { ...preset, size: Math.min(preset.size * 1.5, 170), maxWidth: 0.9 }, x: 0.5, y: 0.5 }, 1, 1, s);
  }, [preset]);
  return <canvas ref={ref} width={280} height={140} className="block w-full" />;
}

export default function TextPanel() {
  return (
    <div className="p-3">
      <div className="grid grid-cols-2 gap-2">
        {Object.entries(TEXT_PRESETS).map(([k, p]) => (
          <button key={k} onClick={() => A.addText(k, p.label === "Minimal" ? "Your text" : "Your text")}
            className="group overflow-hidden rounded-lg border border-line text-left transition hover:border-accent cursor-pointer">
            <Preview preset={p} />
          </button>
        ))}
      </div>
    </div>
  );
}
