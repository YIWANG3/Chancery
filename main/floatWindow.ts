// The floating window: a small always-on-top view of the sessions that matter right now, standing in for the main
// window while that is minimized (the two are never shown together; main/index.ts keeps that). Its page (#/float)
// decides what it shows; this side owns the windows. The float has two places, and is in one of them at a time:
//
//   the corner   one free-standing window: on top of everything, on every desktop, draggable, its position
//                remembered, sized by its page, never taking focus when it appears or changes size
//   the top      one window per display it is to show on, hung from the middle of the display's top edge, where a
//                camera housing (the notch) is if the display has one. Such a window does not move or change size:
//                it is as large as the page can ever get and lets every click through. The page draws a black shape
//                growing out of the top edge and says when the pointer is on it (float:hit), which is when the
//                window takes the mouse. The shape can then grow and shrink as fast as the page paints, with no
//                window to resize.
//
// Which place, and on which displays, is asked of `deps.notches()` every time the windows are arranged: after a
// change of settings or of displays, and when the person moves to another display.
import { BrowserWindow, ipcMain, screen } from "electron";
import { hungFromTop, keepInside } from "../core/util/rect.js";

/** Where a window hangs at the top of a display: the display, and the housing's size (it is centred on the top
 *  edge). A display without a housing gets a stand-in the height of its menu bar; `real` tells the two apart. */
export interface NotchSpot {
  /** The display's id. */
  id: number;
  display: Electron.Rectangle;
  width: number;
  height: number;
  real: boolean;
}

/** A window at the top: this wide, and this much taller than the housing. The page stays inside it. */
export const NOTCH_WINDOW = { width: 520, below: 640 };

export interface FloatDeps {
  /** `notch` is the spot the window is going to hang from; null for the free-standing window. */
  createWindow: (notch: NotchSpot | null) => BrowserWindow;
  /** The spots to show a window at right now, when the float's place is the top; none when it is the corner. */
  notches: () => NotchSpot[];
  /** How much of the menu bar is free on each side of a spot's housing, in points; null where that is not known. */
  room: (spot: NotchSpot) => Room;
  /** The remembered top-left corner, if any. */
  position: () => { x: number; y: number } | null;
  savePosition: (p: { x: number; y: number }) => void;
  /** Keep it outside every display (test runs). */
  offscreen?: boolean;
  onVisibility: (visible: boolean) => void;
}

/** Free width in the menu bar on each side of a housing; null where it could not be measured. */
export interface Room {
  left: number | null;
  right: number | null;
}

export interface FloatControl {
  /** `quiet` shows or hides the float alone, without the main window being put away or brought back for it: for
   *  when the float comes and goes by itself rather than because the person asked. */
  show(opts?: { quiet?: boolean }): void;
  hide(opts?: { quiet?: boolean }): void;
  toggle(): void;
  isVisible(): boolean;
  /** Where the free-standing window is on screen, for other floating things to keep clear of; null while hidden,
   *  and at the top, which is nowhere near the corner the others share. */
  bounds(): Electron.Rectangle | null;
  /** Makes the windows again, for a change of how they look; the float stays shown if it was. */
  remake(): void;
  /** Brings the windows in line with where the float should be now: after the displays changed, or the person
   *  moved to another one. Does nothing when everything is already in place. */
  rehang(): void;
}

const MARGIN = 16;

export function createFloatControl(deps: FloatDeps): FloatControl {
  /** Whether the float is up, whichever windows that means right now. */
  let shown = false;
  let standing: BrowserWindow | null = null;
  /** The windows at the top, by display; `key` is the spot each was made for. One whose display is not being shown
   *  on right now stays, hidden, so coming back to that display costs nothing. */
  const hung = new Map<number, { win: BrowserWindow; key: string; spot: NotchSpot }>();
  /** Windows this module took away itself: their closing is not the float going away. */
  const discarded = new WeakSet<BrowserWindow>();
  let size = { width: 240, height: 40 };

  const alive = (w: BrowserWindow | null): w is BrowserWindow => Boolean(w && !w.isDestroyed());
  const discard = (w: BrowserWindow | null) => {
    if (!alive(w)) return;
    discarded.add(w);
    w.destroy();
  };
  const anyVisible = () => (alive(standing) && standing.isVisible()) || [...hung.values()].some((h) => alive(h.win) && h.win.isVisible());
  const setBounds = (w: BrowserWindow, to: Electron.Rectangle) => {
    const b = w.getBounds();
    if (b.x !== to.x || b.y !== to.y || b.width !== to.width || b.height !== to.height) w.setBounds(to);
  };

  /** A window the person closed themself: when it was the last one showing, the float has gone away. */
  function watch(w: BrowserWindow) {
    w.on("closed", () => {
      if (discarded.has(w)) return;
      if (standing === w) standing = null;
      for (const [id, h] of hung) if (h.win === w) hung.delete(id);
      if (shown && !anyVisible()) {
        shown = false;
        deps.onVisibility(false);
      }
    });
  }

  /** The remembered corner, pulled back onto a display when it would be off every one of them. */
  function placement(): { x: number; y: number } {
    if (deps.offscreen) return { x: -20_000, y: -20_000 };
    const saved = deps.position();
    const display = saved ? screen.getDisplayNearestPoint(saved) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { workArea } = display;
    const corner = saved ?? { x: workArea.x + workArea.width - size.width - MARGIN, y: workArea.y + MARGIN };
    return keepInside({ ...corner, ...size }, workArea, MARGIN);
  }

  /** The free-standing window at its current size, moved back onto its display if growing pushed it off. */
  function fit(w: BrowserWindow) {
    const b = w.getBounds();
    if (deps.offscreen) return setBounds(w, { x: b.x, y: b.y, ...size });
    const { workArea } = screen.getDisplayMatching(b);
    setBounds(w, keepInside({ x: b.x, y: b.y, ...size }, workArea, MARGIN));
  }

  function notchFrame(spot: NotchSpot): Electron.Rectangle {
    const frame = hungFromTop({ width: NOTCH_WINDOW.width, height: spot.height + NOTCH_WINDOW.below }, spot.display);
    return deps.offscreen ? { ...frame, x: -20_000, y: -20_000 } : frame;
  }

  /** The one place the windows are made, shown, moved and hidden: brings them in line with `shown` and the spots. */
  function arrange() {
    const spots = deps.notches();

    if (!spots.length) {
      for (const h of hung.values()) discard(h.win);
      hung.clear();
      if (!shown) {
        if (alive(standing)) standing.hide();
        return;
      }
      if (!alive(standing)) {
        const made = deps.createWindow(null);
        standing = made;
        watch(made);
        made.on("moved", () => {
          if (standing === made && !deps.offscreen) {
            const b = made.getBounds();
            deps.savePosition({ x: b.x, y: b.y });
          }
        });
      }
      if (standing.isVisible()) return fit(standing);
      standing.setBounds({ ...placement(), ...size });
      standing.showInactive();
      return;
    }

    discard(standing);
    standing = null;
    const wanted = new Map(spots.map((s) => [s.id, s]));
    for (const [id, h] of hung) {
      const spot = wanted.get(id);
      // A spot that changed (a display rearranged or rescaled) is a new window: the page is told its housing's
      // size once, in its address.
      if (!alive(h.win) || (spot && JSON.stringify(spot) !== h.key)) {
        discard(h.win);
        hung.delete(id);
      } else if (!spot || !shown) {
        h.win.hide();
      }
    }
    if (!shown) return;
    for (const spot of spots) {
      let h = hung.get(spot.id);
      if (!h) {
        const made = deps.createWindow(spot);
        made.setIgnoreMouseEvents(true, { forward: true });
        watch(made);
        h = { win: made, key: JSON.stringify(spot), spot };
        hung.set(spot.id, h);
      }
      setBounds(h.win, notchFrame(spot));
      if (!h.win.isVisible()) h.win.showInactive();
    }
  }

  const control: FloatControl = {
    show(opts) {
      const was = shown;
      shown = true;
      // The main window goes away first. Hidden after the float is up, AppKit would hand its key status to the only
      // focusable window left, the float, which would come up focused after all.
      if (!opts?.quiet) deps.onVisibility(true);
      if (!was || !opts?.quiet) arrange();
    },
    hide(opts) {
      if (!shown) return;
      shown = false;
      arrange();
      if (!opts?.quiet) deps.onVisibility(false);
    },
    toggle() {
      if (shown) control.hide();
      else control.show();
    },
    isVisible: () => shown,
    bounds: () => (shown && alive(standing) && standing.isVisible() ? standing.getBounds() : null),
    remake() {
      discard(standing);
      standing = null;
      for (const h of hung.values()) discard(h.win);
      hung.clear();
      arrange();
    },
    rehang: arrange,
  };

  // The free-standing window's page measures itself after every render and asks for that size. The top-left corner
  // stays put, so a window that grows or shrinks does so downwards, like a list, unless that would push it off the
  // screen, in which case it is moved back by just enough (it starts out placed for its default size, before the
  // page has said how wide it really is).
  ipcMain.handle("float:fit", (_ev, s: { width: number; height: number }) => {
    size = { width: Math.round(s.width), height: Math.round(s.height) };
    if (alive(standing) && standing.isVisible()) fit(standing);
  });
  // A window at the top lets clicks through to whatever is under it, except while the pointer is on its shape.
  ipcMain.handle("float:hit", (ev, hit: boolean) => {
    const from = BrowserWindow.fromWebContents(ev.sender);
    if (from && [...hung.values()].some((h) => h.win === from)) from.setIgnoreMouseEvents(!hit, { forward: true });
  });
  // Asked by a window at the top, about its own housing: the counts it shows at rest go where there is room.
  ipcMain.handle("float:room", (ev): Room => {
    const from = BrowserWindow.fromWebContents(ev.sender);
    const h = [...hung.values()].find((x) => x.win === from);
    return h ? deps.room(h.spot) : { left: null, right: null };
  });
  ipcMain.handle("float:show", () => control.show());
  ipcMain.handle("float:toggle", () => {
    control.toggle();
    return control.isVisible();
  });
  ipcMain.handle("float:hide", () => control.hide());
  ipcMain.handle("float:visible", () => control.isVisible());
  return control;
}
