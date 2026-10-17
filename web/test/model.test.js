import { describe, expect, test } from "bun:test";
import * as M from "../src/core/model.js";
import { kfValue, setKf, splitKf } from "../src/core/kf.js";

const clip = (id, inT, outT, extra = {}) => ({ id, mid: "m1", in: inT, out: outT, ...extra });
const project = (clips, magnet = false, more = []) =>
  M.normalize({ magnet, tracks: [{ id: "main", kind: "main", clips }, ...more] });
const spans = (p) => M.mainTrack(p).clips.map((c) => [+c.start.toFixed(3), +M.endOf(c, "main").toFixed(3)]);
const words = (list) => list.map(([text, start, end]) => ({ text, start, end }));

describe("main track layout", () => {
  test("magnet on: clips play back to back", () => {
    const p = project([clip("a", 0, 2), clip("b", 5, 8, { gap: 1 })], true);
    expect(spans(p)).toEqual([[0, 2], [2, 5]]);
  });

  test("magnet off: gaps are kept", () => {
    const p = project([clip("a", 0, 2), clip("b", 5, 8, { gap: 1 })]);
    expect(spans(p)).toEqual([[0, 2], [3, 6]]);
  });

  test("a transition overlaps the previous clip, capped at half of either clip", () => {
    const p = project([clip("a", 0, 2), clip("b", 0, 0.4, { trans: { type: "fade", dur: 1 } })], true);
    expect(M.transDur(M.mainTrack(p).clips, 1)).toBeCloseTo(0.2, 2);
    expect(spans(p)[1][0]).toBeCloseTo(1.8, 2);
  });

  test("no transition across a gap", () => {
    const p = project([clip("a", 0, 2), clip("b", 0, 2, { gap: 0.5, trans: { type: "fade", dur: 0.5 } })]);
    expect(M.transDur(M.mainTrack(p).clips, 1)).toBe(0);
  });

  test("deleting with the magnet off leaves later clips where they were", () => {
    const p = project([clip("a", 0, 2), clip("b", 0, 2), clip("c", 0, 2)]);
    M.deleteClips(p, new Set(["b"]));
    expect(spans(p)).toEqual([[0, 2], [4, 6]]);
  });
});

describe("split and cut", () => {
  test("split keeps source times continuous", () => {
    const p = project([clip("a", 10, 14)]);
    const right = M.splitClip(p, "a", 1.5);
    const [l, r] = M.mainTrack(p).clips;
    expect(l.out).toBeCloseTo(11.5);
    expect(r.in).toBeCloseTo(11.5);
    expect(right.id).not.toBe("a");
    expect(spans(p)).toEqual([[0, 1.5], [1.5, 4]]);
  });

  test("split respects speed", () => {
    const p = project([clip("a", 0, 8, { speed: 2 })]);
    M.splitClip(p, "a", 1);
    expect(M.mainTrack(p).clips[0].out).toBeCloseTo(2);
  });

  test("cutRange ripples the main track and shifts later overlays", () => {
    const text = { id: "t", start: 5, dur: 1, text: "hi" };
    const p = project([clip("a", 0, 10)], false, [{ id: "txt", kind: "text", clips: [text] }]);
    M.cutRange(p, 2, 4);
    expect(spans(p)).toEqual([[0, 2], [2, 8]]);
    expect(M.mainTrack(p).clips[1].in).toBeCloseTo(4);
    expect(text.start).toBeCloseTo(3);
  });
});

describe("speech tools", () => {
  const ws = words([
    ["This", 0, 0.3], ["is", 0.3, 0.5], ["a", 0.5, 0.6], ["test.", 0.6, 1.0],
    ["Long", 3.0, 3.4], ["pause", 3.4, 3.9], ["before", 3.9, 4.3], ["this.", 4.3, 4.8],
  ]);

  test("removeSilences cuts pauses longer than the limit", () => {
    const p = project([clip("a", 0, 6)]);
    const r = M.removeSilences(p, () => ws);
    expect(r.cuts).toBe(2); // the 2s pause and the tail after the last word
    expect(M.mainEnd(p)).toBeLessThan(4);
  });

  test("removeSilences leaves short pauses alone", () => {
    const p = project([clip("a", 0, 1.14)]);
    expect(M.removeSilences(p, () => words([["One", 0, 0.5], ["two.", 0.6, 1.0]])).cuts).toBe(0);
  });

  const tl = (list) => list.map(([text, os, oe]) => ({ text, os, oe }));

  test("findRetakes finds a restarted phrase", () => {
    const w = tl([["So", 0, 0.2], ["the", 0.2, 0.4], ["best", 0.4, 0.7], ["So", 1.5, 1.7], ["the", 1.7, 1.9], ["best", 1.9, 2.2], ["way", 2.2, 2.5]]);
    expect(M.findRetakes(w)).toEqual([[0, 2]]);
  });

  test("findRetakes ignores ordinary repeated words", () => {
    const w = tl([["I", 0, 0.1], ["think", 0.1, 0.4], ["that", 0.4, 0.6], ["that", 0.6, 0.8], ["works.", 0.8, 1.2]]);
    expect(M.findRetakes(w)).toEqual([]);
  });

  test("filler detection", () => {
    expect(["um", "Uhh,", "hmm"].every((t) => M.isFiller({ text: t }))).toBe(true);
    expect(["umbrella", "a", "hum"].some((t) => M.isFiller({ text: t }))).toBe(false);
  });
});

describe("keyframes", () => {
  test("smoothstep interpolation between keyframes", () => {
    const c = {};
    setKf(c, "x", 0, 0); setKf(c, "x", 2, 1);
    expect(kfValue(c, "x", -1, 9)).toBe(0);
    expect(kfValue(c, "x", 1, 9)).toBeCloseTo(0.5);
    expect(kfValue(c, "x", 0.5, 9)).toBeLessThan(0.25); // eases in
    expect(kfValue(c, "x", 3, 9)).toBe(1);
    expect(kfValue({}, "x", 1, 9)).toBe(9);
  });

  test("splitting keeps the animated value continuous", () => {
    const left = {}; const right = {};
    setKf(left, "zoom", 0, 1); setKf(left, "zoom", 4, 2);
    const at = kfValue(left, "zoom", 1, 1);
    splitKf(left, right, 1);
    expect(kfValue(left, "zoom", 1, 1)).toBeCloseTo(at);
    expect(kfValue(right, "zoom", 0, 1)).toBeCloseTo(at);
    expect(right.kf.zoom.at(-1)).toEqual({ t: 3, v: 2 });
  });
});
