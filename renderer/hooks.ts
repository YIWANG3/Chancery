import { useEffect, useRef } from "react";
import { api } from "./api";

/** Runs fn now and again whenever the main process says the database changed. With `everyMs` it also runs on a
 *  timer while the window is visible, for data that lives outside the database (e.g. Claude's own session list). */
export function useChanged(fn: () => void, deps: unknown[] = [], opts: { everyMs?: number } = {}) {
  const ref = useRef(fn);
  ref.current = fn;
  const everyMs = opts.everyMs;
  useEffect(() => {
    ref.current();
    const off = api.onChanged(() => ref.current());
    if (!everyMs) return off;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") ref.current();
    }, everyMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") ref.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [...deps, everyMs]);
}

export const fmtTime = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "numeric", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
