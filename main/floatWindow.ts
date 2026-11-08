// The floating window: a small always-on-top view of the sessions that matter right now, standing in for the main
// window while that is minimized (the two are never shown together; main/index.ts keeps that). Its page (#/float) decides what it shows and how big it wants to be; this side owns the
// window: on top of everything, on every desktop, draggable, its position remembered, never taking focus when it
// appears or changes size.
import { BrowserWindow, ipcMain, screen } from "electron";
import { keepInside } from "../core/util/rect.js";

export interface FloatDeps {
  createWindow: () => BrowserWindow;
  /** The remembered top-left corner, if any. */
  position: () => { x: number; y: number } | null;
  savePosition: (p: { x: number; y: number }) => void;
  /** Keep it outside every display (test runs). */
  offscreen?: boolean;
  onVisibility: (visible: boolean) => void;
}

export interface FloatControl {
  show(): void;
  hide(): void;
  toggle(): void;
  isVisible(): boolean;
  /** Where it is on screen, for other floating things to keep clear of; null while hidden. */
  bounds(): Electron.Rectangle | null;
}

const MARGIN = 16;

export function createFloatControl(deps: FloatDeps): FloatControl {
  let win: BrowserWindow | null = null;
  let size = { width: 240, height: 40 };

  /** The remembered corner, pulled back onto a display when it would be off every one of them. */
  function placement(): { x: number; y: number } {
    if (deps.offscreen) return { x: -20_000, y: -20_000 };
    const saved = deps.position();
    const display = saved ? screen.getDisplayNearestPoint(saved) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { workArea } = display;
    const corner = saved ?? { x: workArea.x + workArea.width - size.width - MARGIN, y: workArea.y + MARGIN };
    return keepInside({ ...corner, ...size }, workArea, MARGIN);
  }

  /** The window at its current size, moved back onto its display if growing pushed it off. */
  function fit(w: BrowserWindow) {
    const b = w.getBounds();
    if (deps.offscreen) return w.setBounds({ x: b.x, y: b.y, ...size });
    const { workArea } = screen.getDisplayMatching(b);
    w.setBounds(keepInside({ x: b.x, y: b.y, ...size }, workArea, MARGIN));
  }

  function ensure(): BrowserWindow {
    if (win && !win.isDestroyed()) return win;
    win = deps.createWindow();
    win.on("moved", () => {
      if (win && !deps.offscreen) {
        const b = win.getBounds();
        deps.savePosition({ x: b.x, y: b.y });
      }
    });
    win.on("closed", () => {
      win = null;
      deps.onVisibility(false);
    });
    return win;
  }

  const control: FloatControl = {
    show() {
      const w = ensure();
      const { x, y } = placement();
      w.setBounds({ x, y, ...size });
      // The main window goes away first. Hidden after this one is up, AppKit would hand its key status to the only
      // focusable window left, this one, and the float would come up focused after all.
      deps.onVisibility(true);
      if (!w.isVisible()) w.showInactive();
    },
    hide() {
      if (!control.isVisible()) return;
      win!.hide();
      deps.onVisibility(false);
    },
    toggle() {
      if (control.isVisible()) control.hide();
      else control.show();
    },
    isVisible: () => Boolean(win && !win.isDestroyed() && win.isVisible()),
    bounds: () => (control.isVisible() ? win!.getBounds() : null),
  };

  // The page measures itself after every render and asks for that size. The top-left corner stays put, so a
  // window that grows or shrinks does so downwards, like a list, unless that would push it off the screen, in
  // which case it is moved back by just enough (it starts out placed for its default size, before the page has
  // said how wide it really is).
  ipcMain.handle("float:fit", (_ev, s: { width: number; height: number }) => {
    size = { width: Math.round(s.width), height: Math.round(s.height) };
    if (win && !win.isDestroyed() && win.isVisible()) fit(win);
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
