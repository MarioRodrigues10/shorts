import { useEffect, useState } from "react";

const KEY = "shorts.theme";
const read = () => { try { return localStorage.getItem(KEY) || "light"; } catch { return "light"; } };
export const applyTheme = (t = read()) => document.documentElement.classList.toggle("dark", t === "dark");

export function useTheme() {
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(KEY, theme); } catch { /* private mode */ }
    window.dispatchEvent(new Event("themechange"));
  }, [theme]);
  return [theme, () => setTheme(theme === "dark" ? "light" : "dark")];
}

// Persisted panel size (px) with limits.
export function usePanelSize(key, initial, min, max) {
  const [v, setV] = useState(() => {
    try { const n = Number(localStorage.getItem("shorts.size." + key)); return n ? Math.min(max, Math.max(min, n)) : initial; } catch { return initial; }
  });
  const set = (n) => {
    const c = Math.round(Math.min(max, Math.max(min, n)));
    setV(c);
    try { localStorage.setItem("shorts.size." + key, String(c)); } catch { /* private mode */ }
  };
  return [v, set];
}
