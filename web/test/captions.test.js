import { describe, expect, test } from "bun:test";
import { buildGroups, layerState, layoutStack, drawCaptions, CAPTION_PRESETS, isSmallWord } from "../src/core/layer.js";

// A canvas context that measures text as 0.6 x font size per character and records fills.
function fakeCtx() {
  const calls = [];
  let size = 10;
  return {
    calls,
    set font(f) { size = parseFloat(f.split(" ")[1]); },
    get font() { return `900 ${size}px x`; },
    measureText: (t) => ({ width: t.length * size * 0.6 }),
    save() {}, restore() {}, translate() {}, scale() {},
    fillText: (t) => calls.push(["fill", t, size]),
    strokeText() {},
  };
}

const stack = { ...CAPTION_PRESETS.stack, enabled: true, fill: "", shadow: 0 };
const spoken = (list) => list.map(([text, os, oe]) => ({ text, os, oe }));
const phrase = spoken([["until", 0, 0.3], ["the", 0.3, 0.4], ["act", 0.4, 0.8], ["becomes", 0.8, 1.3]]);

describe("stack captions", () => {
  test("small words are drawn smaller than key words", () => {
    expect(isSmallWord("the")).toBe(true);
    expect(isSmallWord("Becomes")).toBe(false);
    const lay = layoutStack(fakeCtx(), { words: phrase }, stack, 1080);
    const by = Object.fromEntries(lay.lines.flatMap((l) => l.items).map((it) => [it.text, it.s]));
    expect(by.THE).toBeLessThan(by.ACT);
    expect(by.UNTIL).toBe(by.BECOMES);
  });

  test("a small word rides on the line of the key word after it; key words close their line", () => {
    const lay = layoutStack(fakeCtx(), { words: phrase }, stack, 1080);
    expect(lay.lines.map((l) => l.items.map((it) => it.text).join(" "))).toEqual(["UNTIL", "THE ACT", "BECOMES"]);
  });

  test("every line stays inside the max width, long words shrink to fit", () => {
    const long = spoken([["supercalifragilistic", 0, 1]]);
    const lay = layoutStack(fakeCtx(), { words: long }, stack, 1080);
    for (const l of lay.lines) for (const it of l.items) {
      expect(it.x).toBeGreaterThanOrEqual(-1080 * stack.maxWidth / 2 - 1);
      expect(it.x + it.w).toBeLessThanOrEqual(1080 * stack.maxWidth / 2 + 1);
    }
  });

  test("words appear on their beat and stay until the phrase ends", () => {
    const groups = buildGroups(phrase, stack);
    expect(groups.length).toBe(1);
    const L = { W: 1080, H: 1920, groups, cap: stack, texts: [], fx: [] };
    const drawn = (t) => { const ctx = fakeCtx(); drawCaptions(ctx, L, layerState(L, t).cap, 1); return ctx.calls.map((c) => c[1]); };
    expect(drawn(0.1)).toEqual(["UNTIL"]);
    expect(drawn(0.5)).toEqual(["UNTIL", "THE", "ACT"]);
    // after the last word's highlight window, the whole phrase is still there (reveal used to collapse to 1 word)
    expect(drawn(1.4)).toEqual(["UNTIL", "THE", "ACT", "BECOMES"]);
  });

  test("the newest word animates in, then holds still (frames dedupe)", () => {
    const L = { W: 1080, H: 1920, groups: buildGroups(phrase, stack), cap: stack, texts: [], fx: [] };
    expect(layerState(L, 0.85).cap.we).toBeLessThan(1);
    expect(layerState(L, 1.2).cap).toEqual(layerState(L, 1.25).cap);
  });
});
