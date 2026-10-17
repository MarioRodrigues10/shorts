import { useEffect, useReducer } from "react";
import { bus } from "../core/util.js";
import { S } from "../core/store.js";

// Re-render the component when any of the engine events fire.
export function useBus(events = ["changed", "selection", "media", "history", "save", "words"]) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const h = () => force();
    for (const e of events) bus.addEventListener(e, h);
    return () => { for (const e of events) bus.removeEventListener(e, h); };
  }, [events.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  return S;
}

export function cn(...xs) { return xs.filter(Boolean).join(" "); }
