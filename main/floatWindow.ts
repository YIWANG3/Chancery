// The floating window: a small always-on-top view of the sessions that matter right now, for when the main window
// is out of the way. Its page (#/float) decides what it shows and how big it wants to be; this side owns the
// window: on top of everything, on every desktop, draggable, its position remembered, never taking focus when it
// appears or changes size.
import { BrowserWindow, ipcMain, screen } from "electron";

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
    const fallback = { x: workArea.x + workArea.width - size.width - MARGIN, y: workArea.y + MARGIN };
    if (!saved) return fallback;
    const x = Math.min(Math.max(saved.x, workArea.x), workArea.x + workArea.width - size.width);
    const y = Math.min(Math.max(saved.y, workArea.y), workArea.y + workArea.height - size.height);
    return { x, y };
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
      if (!w.isVisible()) w.showInactive();
      deps.onVisibility(true);
    },
    hide() {
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
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
  // window that grows or shrinks does so downwards, like a list.
  ipcMain.handle("float:fit", (_ev, s: { width: number; height: number }) => {
    size = { width: Math.round(s.width), height: Math.round(s.height) };
    if (win && !win.isDestroyed() && win.isVisible()) {
      const b = win.getBounds();
      win.setBounds({ x: b.x, y: b.y, ...size });
    }
  });
  ipcMain.handle("float:toggle", () => {
    control.toggle();
    return control.isVisible();
  });
  ipcMain.handle("float:hide", () => control.hide());
  ipcMain.handle("float:visible", () => control.isVisible());
  return control;
}
