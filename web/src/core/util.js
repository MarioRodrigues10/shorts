export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const uid = () => Math.random().toString(16).slice(2, 10);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const FPS = 30;
export const snapFrame = (t) => Math.round(t * FPS) / FPS;

export async function api(path, body, method) {
  const opts = body === undefined && !method ? {} : {
    method: method || "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const r = await fetch(path, opts);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}

export function fmt(t, frames = false) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = Math.floor(t - m * 60);
  if (frames) return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(Math.floor((t % 1) * FPS)).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}.${Math.floor((t % 1) * 10)}`;
}
export const tildify = (p) => (p || "").replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, "~");
export const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : b > 1e6 ? (b / 1e6).toFixed(0) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";

import { toast as sonner } from "sonner";
export function toast(msg, action) {
  sonner(msg, action ? { action: { label: action.label, onClick: action.fn } } : undefined);
}

export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "style") Object.assign(e.style, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
// Returns an unsubscribe function (use it as a React effect cleanup).
export const on = (name, fn) => {
  const h = (e) => fn(e.detail);
  bus.addEventListener(name, h);
  return () => bus.removeEventListener(name, h);
};
