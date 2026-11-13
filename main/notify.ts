// Puts a short notice in front of the person without taking focus from what they are doing.
//
// Two channels. The system notification is tried first. macOS refuses it for an app it has not been allowed to
// notify, and never offers to allow one that is only ad-hoc signed, which is what a development build of this app is
// (`UNErrorDomain error 1`). So when a notification is refused, the notice goes to the app's own small panel in the
// top-right corner instead, and so does every later one in this run.
import { BrowserWindow, ipcMain, Notification, screen } from "electron";

export interface Notice {
  title: string;
  subtitle?: string;
  body: string;
  onClick: () => void;
}

/** What the panel's page shows for one notice. */
export interface PanelNotice {
  id: number;
  title: string;
  subtitle: string;
  body: string;
}

export interface NotifierDeps {
  /** "panel" skips the system notification altogether (a machine where it is known to be refused). */
  channel: "auto" | "panel";
  /** Keep the panel far outside every display. For test runs: the panel floats above all windows on every desktop,
   *  and a test's made-up notices have no business on the screen of whoever is running the tests. */
  offscreen?: boolean;
  /** Something else floating in the top-right corner (the floating session window) to stay clear of. */
  keepClearOf?: () => Electron.Rectangle | null;
  /** Builds the panel's window. It must not take focus; this module positions, sizes, shows and hides it. */
  createPanel: () => BrowserWindow;
  /** Tells the panel's page that the list changed. */
  onPanelChange: () => void;
  log: (msg: string) => void;
}

export interface Notifier {
  notify(notice: Notice): void;
  /** Makes the panel's window again, for a change of style; what it was showing stays. */
  remakePanel(): void;
}

const PANEL_WIDTH = 360;
const PANEL_ROW = 84;
/** The frame around the rows, so a highlighted row sits inside the panel instead of filling it; the same 6px a row
 *  in the floating window keeps from its edge (renderer/pages/Float.tsx). */
const PANEL_PAD = 6;
const PANEL_MARGIN = 16;
const PANEL_MAX = 4;
/** A notice leaves the panel by itself after this long; the counts on the dock and the menu bar stay. */
const PANEL_STAY_MS = 20_000;

export function createNotifier(deps: NotifierDeps): Notifier {
  // A notification that is garbage-collected loses its click handler, so shown ones are held until they close.
  const shown = new Set<Notification>();
  let systemRefused = deps.channel === "panel";
  let panel: BrowserWindow | null = null;
  let nextId = 1;
  const items: Array<PanelNotice & { onClick: () => void; timer: NodeJS.Timeout }> = [];

  function layout() {
    if (!items.length) {
      panel?.hide();
      deps.onPanelChange();
      return;
    }
    if (!panel || panel.isDestroyed()) {
      const made = deps.createPanel();
      panel = made;
      made.on("closed", () => {
        if (panel === made) panel = null;
      });
    }
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const height = PANEL_PAD * 2 + Math.min(items.length, PANEL_MAX) * PANEL_ROW;
    const x = deps.offscreen ? -20_000 : workArea.x + workArea.width - PANEL_WIDTH - PANEL_MARGIN;
    let y = workArea.y + PANEL_MARGIN;
    // Under the floating window when that sits in the same corner.
    const other = deps.keepClearOf?.();
    if (other && other.y < y + height && other.y + other.height > y && other.x < x + PANEL_WIDTH && other.x + other.width > x) y = other.y + other.height + 8;
    panel.setBounds({ x, y: deps.offscreen ? -20_000 : y, width: PANEL_WIDTH, height });
    if (!panel.isVisible()) panel.showInactive();
    deps.onPanelChange();
  }

  function remove(id: number): (() => void) | null {
    const i = items.findIndex((it) => it.id === id);
    if (i < 0) return null;
    const [it] = items.splice(i, 1);
    clearTimeout(it!.timer);
    layout();
    return it!.onClick;
  }

  function toPanel(n: Notice) {
    const id = nextId++;
    items.unshift({ id, title: n.title, subtitle: n.subtitle ?? "", body: n.body, onClick: n.onClick, timer: setTimeout(() => remove(id), PANEL_STAY_MS) });
    for (const extra of items.slice(PANEL_MAX)) remove(extra.id);
    deps.log("session notice shown in the panel");
    layout();
  }

  ipcMain.handle("notices:list", (): PanelNotice[] => items.map(({ id, title, subtitle, body }) => ({ id, title, subtitle, body })));
  ipcMain.handle("notices:open", (_ev, { id }: { id: number }) => remove(id)?.());
  ipcMain.handle("notices:dismiss", (_ev, { id }: { id: number }) => void remove(id));

  return {
    remakePanel() {
      const old = panel;
      panel = null;
      if (old && !old.isDestroyed()) old.destroy();
      if (items.length) layout();
    },
    notify(n) {
      if (systemRefused || !Notification.isSupported()) return toPanel(n);
      const native = new Notification({ title: n.title, subtitle: n.subtitle, body: n.body });
      shown.add(native);
      native.on("click", () => {
        shown.delete(native);
        n.onClick();
      });
      native.on("close", () => shown.delete(native));
      native.on("show", () => deps.log("session notification shown"));
      native.on("failed", (_ev, error) => {
        shown.delete(native);
        if (!systemRefused) deps.log(`system notifications are refused (${error}); using the panel from now on`);
        systemRefused = true;
        toPanel(n);
      });
      native.show();
    },
  };
}
