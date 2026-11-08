import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Maximize2 } from "lucide-react";
import type { Overview, SessionRow } from "@core/overview";
import { HELD_UP_WINDOW_MS } from "@core/sessionAlerts";
import { api } from "../api";
import { cn } from "../cn";
import { useChanged } from "../hooks";
import { APP_LABEL, BUCKET, BUCKET_LABEL, STATE_DOT, STATE_LABEL, ago, useReply, type Bucket } from "../sessionBits";

/** Folded: one line of counts. Open: the counts and the sessions under them. */
type Mode = "mini" | "full";
const COUNTS = [5, 10] as const;
type Count = (typeof COUNTS)[number];

const KEY = "chancery.float";
interface Prefs {
  mode: Mode;
  count: Count;
}
const load = (): Prefs => {
  try {
    return { mode: "full", count: 5, ...(JSON.parse(localStorage.getItem(KEY) ?? "") as Partial<Prefs>) };
  } catch {
    return { mode: "full", count: 5 };
  }
};

const WIDTH: Record<Mode, number> = { mini: 300, full: 360 };
const SHOWN: Bucket[] = ["needs", "look", "running"];
const DOT: Record<Bucket, string> = { needs: "bg-warn", look: "bg-success", running: "bg-accent", ended: "bg-muted/60" };

/**
 * The floating window's page: the main window, minimized. Only sessions that still matter are listed (held up, waiting to be looked at,
 * running), newest-relevant first, in the overview's own order; finished ones take no room here. The page measures
 * itself after every render and the main process gives the window that size.
 */
export function Float() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(load);
  const root = useRef<HTMLDivElement>(null);

  useChanged(
    () => {
      api.sessions
        .overview()
        .then(setOverview)
        .catch(() => {});
    },
    [],
    { everyMs: 10_000 },
  );
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {}
  }, [prefs]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) void api.float.hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const now = overview?.readAt ?? Date.now();
  const live = useMemo(() => {
    const since = now - HELD_UP_WINDOW_MS;
    return (overview?.sessions ?? []).filter((s) => s.at >= since && SHOWN.includes(BUCKET[s.state]));
  }, [overview, now]);
  const counts = useMemo(() => {
    const n: Record<Bucket, number> = { needs: 0, look: 0, running: 0, ended: 0 };
    for (const s of live) n[BUCKET[s.state]] += 1;
    return n;
  }, [live]);
  const rows = prefs.mode === "full" ? live.slice(0, prefs.count) : [];

  // Size follows content; the window is told after every paint.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const fit = () => void api.float.fit({ width: WIDTH[prefs.mode], height: Math.min(Math.ceil(el.getBoundingClientRect().height), 640) });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [prefs.mode]);

  const mini = prefs.mode === "mini";
  return (
    <div ref={root} style={{ width: WIDTH[prefs.mode] }} className="bg-panel text-text text-[13px] select-none">
      {/* The header is the handle: drag anywhere on it that is not a button. */}
      <div className={cn("drag flex items-center gap-3 px-3", mini ? "h-10" : "h-10 border-b border-line")}>
        <span className="flex items-center gap-3 min-w-0" aria-label="会话计数">
          {SHOWN.map((b) => (
            <span key={b} className={cn("inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums", counts[b] ? "text-text" : "text-muted")} title={BUCKET_LABEL[b]}>
              <span className={cn("size-1.5 rounded-full", counts[b] ? DOT[b] : "bg-muted/40")} />
              {BUCKET_LABEL[b]} {counts[b]}
            </span>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          {!mini && (
            <span role="radiogroup" aria-label="显示几条" className="mr-1 inline-flex items-center rounded bg-panel2 p-0.5">
              {COUNTS.map((c) => (
                <button key={c} role="radio" aria-checked={prefs.count === c} onClick={() => setPrefs({ ...prefs, count: c })} className={cn("no-drag h-5 px-1.5 rounded-[3px] text-[11px] tabular-nums", prefs.count === c ? "bg-raised text-text" : "text-muted hover:text-text")}>
                  {c}
                </button>
              ))}
            </span>
          )}
          <IconButton label={mini ? "展开" : "收起"} onClick={() => setPrefs({ ...prefs, mode: mini ? "full" : "mini" })}>
            {mini ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </IconButton>
          <IconButton label="回到主窗口" onClick={() => void api.main.show()}>
            <Maximize2 size={13} />
          </IconButton>
        </span>
      </div>
      {!mini && (
        <div role="list" aria-label="浮窗里的会话" className="flex flex-col gap-0.5 p-1.5">
          {rows.map((s) => (
            <FloatRow key={`${s.app}:${s.id}`} s={s} now={now} />
          ))}
          {!rows.length && <span className="px-1.5 py-1.5 text-muted">{overview ? "没有在等你、待看或在跑的会话。" : "在读…"}</span>}
          {live.length > rows.length && (
            <span className="px-1.5 py-1 text-[12px] text-muted">
              还有 {live.length - rows.length} 个，在主窗口里看
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="no-drag size-6 inline-flex items-center justify-center rounded text-muted hover:text-text hover:bg-hover">
      {children}
    </button>
  );
}

/** One session: the exact state as a dot, the title, how long ago, then reply and jump. Clicking the title jumps. The
 *  row lights up as a rounded card inside the list's 6px frame, like rows in the main window, not edge to edge. */
function FloatRow({ s, now }: { s: SessionRow; now: number }) {
  const reply = useReply(s, now);
  const heldUp = BUCKET[s.state] === "needs";
  return (
    <div role="listitem" className="rounded-md px-1.5 py-1.5 flex flex-col gap-1.5 hover:bg-panel2">
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", STATE_DOT[s.state])} title={STATE_LABEL[s.state]} />
        <button type="button" onClick={() => s.open && void api.session.open(s.open)} title={`${STATE_LABEL[s.state]} · ${s.title}${s.detail ? `\n${s.detail}` : ""}`} className="no-drag flex-1 min-w-0 text-left truncate leading-5 hover:underline">
          {s.title || "（无标题）"}
        </button>
        <span className="shrink-0 text-[11px] text-muted whitespace-nowrap tabular-nums">
          {APP_LABEL[s.app]} · {ago(s.at, now)}
        </span>
        <span className="shrink-0 flex items-center">{reply.buttons}</span>
      </div>
      {heldUp && s.detail && !reply.open && (
        <span className="pl-4 text-[12px] leading-4 text-muted line-clamp-2" title={s.detail}>
          {s.detail}
        </span>
      )}
      {reply.open && reply.box({ className: "pl-4", stacked: true })}
      {reply.sent && <span className="pl-4 text-[12px] text-muted">{reply.sent}</span>}
    </div>
  );
}
