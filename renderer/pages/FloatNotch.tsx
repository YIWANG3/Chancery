// The floating window at the top of a display, on its camera housing (the notch) where it has one. The window
// itself never moves or changes size (main/floatWindow.ts): it hangs from the top of the screen, lets clicks
// through, and this page draws one black shape in it, centred, so that shape and housing read as one thing.
//
//   at rest   on a housing: the housing, plus an ear on each side when there is something to count
//             without one: a small tab holding the counts, or nothing at all when there is nothing to count
//   open      while the pointer is on it (or a reply is being typed): the counts and the sessions, under the strip
//
// A display without a housing has nothing to keep clear of and nothing to hide behind, which is all the difference:
// the counts sit together in the middle, and with none to show the shape draws up into the top edge. The place it
// was stays live to the pointer, so it can still be opened.
//
// The outline, its radii and the springs are the ones the notch apps people know use (boring.notch, after
// DynamicNotchKit's NotchShape): the top corners flare outward into the screen's edge, the bottom ones are quadratic
// curves rather than circle arcs, and both grow when it opens. The shape is a clip on a black sheet that is always
// the size of the open form, so growing is only the clip's path moving. It moves on a spring worked out here frame
// by frame: a CSS transition between two paths is drawn wrong by Chromium part of the way (half the sheet goes
// missing), and a spring that is stepped by hand keeps its speed when the pointer leaves while it is still opening.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { placeEars } from "@core/util/notchEars";
import { api } from "../api";
import { cn } from "../cn";
import { useT } from "../i18n";
import { NOTCH } from "../look";
import { bucketKey, type Bucket } from "../sessionBits";
import { Counts, DOT, FloatRow, HowMany, IconButton, SHOWN, useLive, usePrefs } from "./Float";

const OPEN_WIDTH = 440;
/** How far an ear reaches past the housing: room for a dot and a two-digit count. */
const EAR = 42;
/** What a side with ears needs besides them: the shape's flare, and a little air before a menu or an icon. */
const EAR_EDGE = 10;
/** How often the page asks how much of the menu bar is free beside the housing: apps and their menus come and go. */
const ROOM_EVERY_MS = 2500;
/** Corner radii: `top` is the outward flare where the shape meets the screen's edge, `bottom` the two lower corners. */
const RADII = { rest: { top: 6, bottom: 14 }, open: { top: 19, bottom: 24 } };
/** The black sheet the shape is cut from: the open form, its flares, and room for the spring to overshoot. */
const SHEET_WIDTH = OPEN_WIDTH + RADII.open.top * 2 + 24;
/** The pointer has to stay this long before the shape opens, so crossing it on the way to a menu does nothing. */
const OPEN_AFTER_MS = 120;
const CLOSE_AFTER_MS = 240;

/** SwiftUI's `spring(response:dampingFraction:)`: `response` is the period in seconds of the undamped spring, and a
 *  `damping` of 1 settles without overshoot. Opening has a little bounce; closing has none. */
interface Spring {
  response: number;
  damping: number;
}
const OPENING: Spring = { response: 0.42, damping: 0.8 };
const CLOSING: Spring = { response: 0.45, damping: 1 };

/** The shape's five numbers, each on its own spring: how far its body reaches to the left and to the right of the
 *  middle of the screen (it need not be the same: the counts go where the menu bar has room), how tall it is, and
 *  the two radii. */
type Form = [left: number, right: number, height: number, top: number, bottom: number];

/**
 * Moves `el`'s clip toward `form` on a spring, writing the path straight to the element every frame (the rows in it
 * have no reason to render sixty times a second). The first form is taken as it is; a later one starts from wherever
 * the shape is, at the speed it has.
 */
function useSprungOutline(el: React.RefObject<HTMLElement | null>, form: Form, spring: Spring) {
  const at = useRef<{ x: number[]; v: number[] } | null>(null);
  const frame = useRef(0);
  const [left, right, height, top, bottom] = form;
  useLayoutEffect(() => {
    const target = [left, right, height, top, bottom];
    const draw = (x: number[]) => {
      // A radius cannot outgrow the shape it rounds, which a spring that overshoots on the way down would ask for.
      const [l = 0, r = 0, h = 0, t = 0, b = 0] = x.map((n) => Math.max(0, n));
      if (el.current) el.current.style.clipPath = `path("${outline(SHEET_WIDTH / 2 - l - t, l + r + t * 2, h, t, Math.min(b, h, (l + r) / 2))}")`;
    };
    if (!at.current) {
      at.current = { x: target, v: target.map(() => 0) };
      draw(target);
      return;
    }
    const state = at.current;
    const w = (2 * Math.PI) / spring.response;
    let last = performance.now();
    const tick = (now: number) => {
      // Small fixed steps, so the spring is the same spring whatever the frame rate; a long gap (a hidden window)
      // is not caught up on.
      let left = Math.min(now - last, 64) / 1000;
      last = now;
      while (left > 0) {
        const dt = Math.min(left, 0.004);
        left -= dt;
        for (let i = 0; i < target.length; i++) {
          const a = -w * w * (state.x[i]! - target[i]!) - 2 * spring.damping * w * state.v[i]!;
          state.v[i]! += a * dt;
          state.x[i]! += state.v[i]! * dt;
        }
      }
      const resting = target.every((goal, i) => Math.abs(state.x[i]! - goal) < 0.05 && Math.abs(state.v[i]!) < 0.5);
      if (resting) at.current = { x: target, v: target.map(() => 0) };
      draw(resting ? target : state.x);
      if (!resting) frame.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [el, left, right, height, top, bottom, spring]);
}

/** The outline as an SVG path: `x` is its left end on the screen's edge, `width` runs flare to flare. */
function outline(x: number, width: number, height: number, top: number, bottom: number): string {
  const l = x + top;
  const r = x + width - top;
  return [`M ${x} 0`, `Q ${l} 0 ${l} ${top}`, `L ${l} ${height - bottom}`, `Q ${l} ${height} ${l + bottom} ${height}`, `L ${r - bottom} ${height}`, `Q ${r} ${height} ${r} ${height - bottom}`, `L ${r} ${top}`, `Q ${r} 0 ${x + width} 0`, "Z"].join(" ");
}

export function NotchFloat() {
  const t = useT();
  const { loaded, now, live, counts } = useLive();
  const [prefs, setPrefs] = usePrefs();
  const [open, setOpen] = useState(false);
  const [bodyHeight, setBodyHeight] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const inside = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => setBodyHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The window takes the mouse from the moment the pointer is on the shape until the shape has closed again.
  const enter = () => {
    inside.current = true;
    void api.float.hit(true);
    clearTimeout(timer.current);
    if (NOTCH.open === "hover") timer.current = setTimeout(() => setOpen(true), OPEN_AFTER_MS);
  };
  /** Closes a moment later, unless the pointer came back or a reply is being typed in it. */
  const settle = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (inside.current) return;
      if (document.hasFocus() && document.activeElement instanceof HTMLTextAreaElement) return;
      setOpen(false);
      void api.float.hit(false);
    }, CLOSE_AFTER_MS);
  };
  const leave = () => {
    inside.current = false;
    settle();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.target instanceof HTMLTextAreaElement) return;
      setOpen(false);
      if (!inside.current) void api.float.hit(false);
    };
    window.addEventListener("blur", settle);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("blur", settle);
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer.current);
    };
  }, []);

  // Beside a housing the menu bar is shared with the frontmost app's menus and the status icons, so the page keeps
  // asking how much of it is free on each side. Unknown counts as free.
  const [room, setRoom] = useState({ left: Infinity, right: Infinity });
  useEffect(() => {
    if (!NOTCH.real) return;
    const ask = () =>
      void api.float
        .room()
        .then((r) => r && setRoom({ left: r.left ?? Infinity, right: r.right ?? Infinity }))
        .catch(() => {});
    ask();
    const every = setInterval(ask, ROOM_EVERY_MS);
    return () => clearInterval(every);
  }, []);

  // Two counts for three kinds: the most pressing kind there is, and the least. Beside a housing one goes on each
  // side of it, or wherever the menu bar has room; without a housing they sit together in the middle.
  const present = SHOWN.filter((b) => counts[b] > 0);
  const kinds = present.length > 1 ? [present[0]!, present[present.length - 1]!] : present;
  const natural = NOTCH.real ? { left: kinds.slice(0, 1), right: kinds.slice(1) } : { left: kinds, right: [] };
  const placed = NOTCH.rest !== "counts" ? { left: [], right: [] } : NOTCH.real ? placeEars(kinds, room, EAR, EAR_EDGE) : natural;
  const ears = placed.left.length + placed.right.length > 0;
  // Open, the strip shows the counts where they were at rest; when none fitted there, where they would have been.
  const strip = ears ? placed : open ? natural : placed;
  const rows = live.slice(0, prefs.count);

  // Without ears (nothing to count, no room for them, or the person wants nothing shown) nothing shows at rest: on
  // a housing the shape is the housing exactly, flares and all tucked behind it; without one it has no height.
  const radii = open ? (NOTCH.corners === "round" ? RADII.open : RADII.rest) : ears ? RADII.rest : { top: 0, bottom: RADII.rest.bottom };
  const half = NOTCH.width / 2;
  const tab = (kinds.length * EAR + 14) / 2;
  const reach = open ? [OPEN_WIDTH / 2, OPEN_WIDTH / 2] : NOTCH.real ? [half + placed.left.length * EAR, half + placed.right.length * EAR] : ears ? [tab, tab] : [half, half];
  const height = open ? NOTCH.height + bodyHeight : NOTCH.real || ears ? NOTCH.height : 0;
  useSprungOutline(sheet, [reach[0]!, reach[1]!, height, radii.top, radii.bottom], open ? OPENING : CLOSING);

  return (
    <div className="relative h-full text-[13px] text-text select-none">
      {/* The shadow is cast by the shape, so it sits on a wrapper: on the sheet itself the clip would cut it off. */}
      <div className="absolute inset-0" style={{ filter: open ? "drop-shadow(0 5px 7px rgb(0 0 0 / 0.55))" : "drop-shadow(0 0 0 rgb(0 0 0 / 0))", transition: "filter 300ms ease-out" }}>
        {/* Where the housing is, or would be: live to the pointer even when no shape is drawn there. */}
        <div aria-hidden onMouseEnter={enter} onMouseLeave={leave} onClick={() => setOpen(true)} className="absolute left-1/2 top-0 -translate-x-1/2" style={{ width: NOTCH.width, height: NOTCH.height }} />
        <section
          ref={sheet}
          aria-label={t("float.list")}
          data-state={open ? "open" : "rest"}
          onMouseEnter={enter}
          onMouseLeave={leave}
          onClick={() => setOpen(true)}
          onBlur={settle}
          className="absolute inset-y-0 left-1/2 -translate-x-1/2 overflow-hidden bg-black"
          style={{ width: SHEET_WIDTH }}
        >
          {/* The strip level with the housing: the middle of it is behind the camera, so the counts are ears beside
              it. With no housing in the way they sit together in the middle. */}
          <div className={cn("relative", !NOTCH.real && "flex justify-center")} style={{ height: NOTCH.height }}>
            {NOTCH.real ? (
              <>
                <span className="absolute inset-y-0 flex" style={{ right: `calc(50% + ${half}px)` }}>
                  {strip.left.map((b) => (
                    <Ear key={b} bucket={b} n={counts[b]} />
                  ))}
                </span>
                <span className="absolute inset-y-0 flex" style={{ left: `calc(50% + ${half}px)` }}>
                  {strip.right.map((b) => (
                    <Ear key={b} bucket={b} n={counts[b]} />
                  ))}
                </span>
              </>
            ) : (
              strip.left.map((b) => <Ear key={b} bucket={b} n={counts[b]} />)
            )}
          </div>
          {/* Laid out at its full width whatever the shape's width is, so nothing reflows while the shape grows;
              it comes into focus as the shape opens over it. */}
          <div
            ref={body}
            inert={!open}
            aria-hidden={!open}
            className="absolute left-1/2 -translate-x-1/2"
            style={{ top: NOTCH.height, width: OPEN_WIDTH, opacity: open ? 1 : 0, filter: open ? "blur(0)" : "blur(6px)", transition: open ? "opacity 260ms ease-out 60ms, filter 300ms ease-out 60ms" : "opacity 140ms ease-in, filter 140ms ease-in" }}
          >
            <div className="flex h-9 items-center gap-3 px-4">
              <Counts counts={counts} />
              <span className="ml-auto flex items-center gap-0.5">
                <HowMany value={prefs.count} onChange={(count) => setPrefs({ ...prefs, count })} />
                <IconButton label={t("float.backToMain")} onClick={() => void api.main.show()}>
                  <Maximize2 size={13} />
                </IconButton>
              </span>
            </div>
            <div role="list" aria-label={t("float.list")} className="flex max-h-[540px] flex-col gap-0.5 overflow-y-auto px-2.5 pb-3">
              {rows.map((s) => (
                <FloatRow key={`${s.app}:${s.id}`} s={s} now={now} />
              ))}
              {!rows.length && <span className="px-1.5 py-1.5 text-muted">{loaded ? t("float.empty") : t("float.loading")}</span>}
              {live.length > rows.length && <span className="px-1.5 py-1 text-[12px] text-muted">{t("float.more", { n: live.length - rows.length })}</span>}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** One count in the strip: a kind's dot and how many there are of it. */
function Ear({ bucket, n }: { bucket: Bucket; n: number }) {
  const t = useT();
  return (
    <span className="flex items-center justify-center gap-1.5 text-[12px] font-medium tabular-nums" style={{ width: EAR }} title={`${t(bucketKey(bucket))} ${n}`}>
      <span className={cn("size-1.5 rounded-full", DOT[bucket], bucket === "running" && "animate-pulse")} />
      {n}
    </span>
  );
}
