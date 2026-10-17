// Phosphor icons for the imperative parts of the UI (timeline). React components use @phosphor-icons/react.
import filmStrip from "@phosphor-icons/core/assets/regular/film-strip.svg?raw";
import stack from "@phosphor-icons/core/assets/regular/stack.svg?raw";
import textT from "@phosphor-icons/core/assets/regular/text-t.svg?raw";
import musicNotes from "@phosphor-icons/core/assets/regular/music-notes.svg?raw";
import eye from "@phosphor-icons/core/assets/regular/eye.svg?raw";
import eyeSlash from "@phosphor-icons/core/assets/regular/eye-slash.svg?raw";
import speakerHigh from "@phosphor-icons/core/assets/regular/speaker-high.svg?raw";
import speakerSlash from "@phosphor-icons/core/assets/regular/speaker-slash.svg?raw";
import dotsThree from "@phosphor-icons/core/assets/bold/dots-three-bold.svg?raw";
import plus from "@phosphor-icons/core/assets/bold/plus-bold.svg?raw";
import x from "@phosphor-icons/core/assets/bold/x-bold.svg?raw";
import columns from "@phosphor-icons/core/assets/regular/columns.svg?raw";
import shapes from "@phosphor-icons/core/assets/regular/shapes.svg?raw";

const SVG = {
  film: filmStrip, layers: stack, type: textT, music: musicNotes, eye, eyeOff: eyeSlash,
  volume: speakerHigh, volumeX: speakerSlash, more: dotsThree, plus, x, split: columns, focus: shapes,
};

const tpl = document.createElement("template");
export function icon(name, size = 16) {
  tpl.innerHTML = (SVG[name] || x).trim();
  const svg = tpl.content.firstChild.cloneNode(true);
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "currentColor");
  svg.classList.add("ico");
  return svg;
}
