import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerSaveBlocker, screen, Tray } from "electron";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { SESSION_APP_INFO, createClaudeDesktopExecutor, createCodexExecutor, createDaemon, createDb, createRepo, heldUpSessions, migrate, resolveLang, t, triageTicket, type Daemon, type Db, type Lang, type SessionRow, type Triage } from "../core/index.js";
import { broadcast, registerIpc, type Backend } from "./ipc.js";
import { createFloatControl, type FloatControl, type NotchSpot, type Room } from "./floatWindow.js";
import { loadGlass } from "./glass.js";
import { createNotifier, type Notifier } from "./notify.js";
import { openSession } from "./openSession.js";
import { startSessionWatch, type SessionWatch } from "./sessionWatch.js";
import { startPg, type PgHandle } from "./pg.js";
import { startMcpHttp } from "./mcpHttp.js";
import type { Server } from "node:http";
import { loadSettings, saveSettings, type FloatPlace, type FloatStyle, type Settings, type ThemePref } from "./settings.js";

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code !== "EPIPE") throw err;
  });
}

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
// CHANCERY_USER_DATA points a second copy of the app (e2e tests, a scratch profile) at its own settings, Postgres
// cluster, logs and single-instance lock, so it never touches the real one.
if (process.env.CHANCERY_USER_DATA) {
  app.setPath("userData", process.env.CHANCERY_USER_DATA);
  app.setPath("logs", join(process.env.CHANCERY_USER_DATA, "logs"));
} else {
  // The packaged app is called "Chancery" on the Dock, but its settings, Postgres cluster and logs stay where the
  // dev build, the README and the CLI expect them: ~/Library/Application Support/chancery-claude and
  // ~/Library/Logs/chancery-claude.
  app.setPath("userData", join(app.getPath("appData"), "chancery-claude"));
  app.setPath("logs", join(homedir(), "Library", "Logs", "chancery-claude"));
}
const userData = app.getPath("userData");
const logDir = join(app.getPath("logs"));

// Started from the Dock or as a login item the app inherits launchd's minimal PATH, and then `claude`, `codex`,
// `gh`, `node` for a project's setup are all missing. Add the places they usually live.
for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".npm-global", "bin"), join(homedir(), ".bun", "bin"), join(homedir(), ".cargo", "bin")]) {
  const path = process.env.PATH ?? "";
  if (existsSync(dir) && !path.split(delimiter).includes(dir)) process.env.PATH = path ? `${path}${delimiter}${dir}` : dir;
}
mkdirSync(logDir, { recursive: true });
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    appendFileSync(join(logDir, "chancery.log"), line + "\n");
  } catch {}
};

const settingsPath = join(userData, "settings.json");
const axctlPath = process.env.CHANCERY_AXCTL || join(app.getAppPath(), "native", "bin", "axctl");
// CHANCERY_GLASS=0 keeps the floating windows solid on a machine that could put them on Liquid Glass.
const glass = loadGlass(join(app.getAppPath(), "native", "bin", "glass.node"), log);
const GLASS = glass.available && process.env.CHANCERY_GLASS !== "0";
/** The corner radius macOS 26 gives a window without a toolbar; the glass and the page's veil are cut to it. */
const GLASS_RADIUS = 16;
let settings: Settings = loadSettings(settingsPath);
let pg: PgHandle | null = null;
let db: Db | null = null;
let quitting = false;
/** Set the moment quitting starts (before-quit), ahead of `quitting`, which marks the shutdown steps proper. */
let quitRequested = false;
let daemon: Daemon | null = null;
/** The database's side coming up (boot), from the moment it starts until it is up or has failed; quitting waits for
 *  it, so a Postgres that is still starting is not left behind. */
let booting: Promise<unknown> | null = null;
let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let mcpHttp: Server | null = null;
let awakeBlocker: number | null = null;
let sessionWatch: SessionWatch | null = null;
let floatControl: FloatControl | null = null;
let notifier: Notifier | null = null;
const OFFSCREEN = process.env.CHANCERY_OFFSCREEN === "1";
/** Sessions stopped until the person does something; drives the menu bar item and the dock badge. */
let heldUp: SessionRow[] = [];

/** Keeps the machine from idle-sleeping while a worker or auditor is running; released as soon as none is. */
function keepAwake(active: boolean) {
  if (active && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!active && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = null;
  }
}

function applyLoginItem(enabled: boolean) {
  if (DEV_URL) return; // the dev build is not the app the user wants at login
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch (err) {
    log(`login item: ${String(err)}`);
  }
}

/** The clerk's triage call, built from the current settings on every tick so a changed key or switch applies live. */
function clerkFor(): Triage | null {
  const s = settings;
  if (!s.autoTriage) return null;
  const backend = s.clerkBackend === "auto" ? (s.deepseekApiKey ? "deepseek" : "claude") : s.clerkBackend;
  return (ticket, project, decisions) => triageTicket(ticket, project, decisions, { backend, deepseekApiKey: s.deepseekApiKey, deepseekModel: s.deepseekModel, claudeBin: s.claudeBin });
}

// Window background matches the renderer's app token in each theme, so there is never a white (or black) flash.
const BG = { light: "#f7f7f7", dark: "#000000" } as const;
const bg = () => (nativeTheme.shouldUseDarkColors ? BG.dark : BG.light);
nativeTheme.themeSource = settings.theme;
/** Windows with nothing of their own behind the page (glass, or nothing at all): they have no background color to
 *  keep in step with the theme. */
const seeThrough = new WeakSet<BrowserWindow>();
nativeTheme.on("updated", () => {
  for (const win of BrowserWindow.getAllWindows()) if (!seeThrough.has(win)) win.setBackgroundColor(bg());
});
const applyTheme = (theme: ThemePref) => {
  nativeTheme.themeSource = theme;
};

/** The language the app speaks: the setting, or the system's languages in order when the setting says so. */
const lang = (): Lang => resolveLang(settings.language, app.getPreferredSystemLanguages());
/** After the language setting changed: the menu bar menu is rebuilt, every window is told, and the session
 *  overview is read again so its own words (details, errors, the catch-all group) come back in the new language. */
function applyLanguage() {
  refreshAttention();
  broadcast("chancery:language", lang());
  void sessionWatch?.refresh().catch(() => {});
}

function loadRoute(win: BrowserWindow, route: string) {
  if (DEV_URL) return win.loadURL(`${DEV_URL}/#${route}`);
  return win.loadFile(join(__dirname, "renderer", "index.html"), { hash: route });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: bg(),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    mainWindow = null;
    // Its settings page went with it, without saying that the preview is over.
    previewing = false;
    followMainWindow();
  });
  win.on("focus", followMainWindow);
  win.on("blur", followMainWindow);
  win.on("show", followMainWindow);
  win.on("hide", () => {
    previewing = false;
    followMainWindow();
  });
  win.on("minimize", followMainWindow);
  win.on("restore", followMainWindow);
  void loadRoute(win, process.env.CHANCERY_ROUTE ?? "/sessions");
  // Dev aid: CHANCERY_SCREENSHOT=<png path> captures the window once it has rendered, then quits.
  const shot = process.env.CHANCERY_SCREENSHOT;
  if (shot) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        const { writeFileSync } = await import("node:fs");
        writeFileSync(shot, image.toPNG());
        log(`screenshot written to ${shot}`);
        app.quit();
      }, Number(process.env.CHANCERY_SCREENSHOT_DELAY ?? 2500));
    });
  }
  return win;
}

/** Brings the main window up. The floating window is its minimized form, so this also puts that away. */
function showMain() {
  // While quitting, the windows are being closed; one made now would never be closed and would keep the app alive.
  // The floating window's `closed` asks for the main window back, and when the main window went first that is here.
  if (quitRequested) return;
  if (!mainWindow) mainWindow = createMainWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
  }
  mainWindow.focus();
  floatControl?.hide();
}

function toggleCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    if (captureWindow.isVisible()) {
      captureWindow.hide();
      return;
    }
    captureWindow.show();
    captureWindow.focus();
    return;
  }
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = 560;
  const height = 220;
  captureWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height * 0.22),
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: bg(),
    show: false,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  captureWindow.once("ready-to-show", () => captureWindow?.show());
  captureWindow.on("blur", () => captureWindow?.hide());
  captureWindow.on("closed", () => {
    captureWindow = null;
  });
  void loadRoute(captureWindow, "/capture");
}

function setupTray() {
  // Text-only menu bar item until there is a real icon asset.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Chancery");
  refreshAttention();
}

const TRAY_SESSIONS = 8;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function jumpTo(s: SessionRow) {
  if (!s.open) return showMain();
  void openSession(s.open, settings, log).catch((err: unknown) => log(`open session ${s.app}:${s.id}: ${String(err)}`));
}

/** Puts the number of sessions waiting on the person on the menu bar item and the dock icon, and lists them in the
 *  menu bar item's menu, each one a jump to its conversation. */
function refreshAttention() {
  const n = heldUp.length;
  app.dock?.setBadge(n ? String(n) : "");
  if (!tray) return;
  tray.setTitle(n ? `Ch ${n}` : "Ch");
  const l = lang();
  const waiting: Electron.MenuItemConstructorOptions[] = heldUp.slice(0, TRAY_SESSIONS).map((s) => ({
    label: `${clip(s.title || t(l, "common.untitled"), 36)} — ${SESSION_APP_INFO[s.app].name}`,
    toolTip: s.detail || undefined,
    click: () => jumpTo(s),
  }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t(l, "tray.open"), click: showMain },
      ...(floatControl?.isVisible() ? [] : [{ label: t(l, "app.minimizeToFloat"), click: () => floatControl?.show() }]),
      { label: t(l, "tray.capture"), click: toggleCapture },
      { type: "separator" },
      ...(n ? [{ label: t(l, "tray.waiting", { n }), enabled: false }, ...waiting, ...(n > TRAY_SESSIONS ? [{ label: t(l, "tray.more", { n: n - TRAY_SESSIONS }), click: showMain }] : []), { type: "separator" as const }] : []),
      { label: t(l, "tray.quit"), click: () => app.quit() },
    ]),
  );
}

/** How often the float at the top checks which display the person is working on. */
const FOLLOW_DISPLAY_MS = 800;
/** The top of the screen is a place for the float where the system has a menu bar strip to hang it in. */
const TOP_PLACE = process.platform === "darwin";
/** What stands in for a housing on a display without one: as wide as the shape needs for its counts, and as tall as
 *  the menu bar, or this where the display has no menu bar of its own. */
const STAND_IN = { width: 100, height: 30 };

/**
 * Where the float hangs when its place is the top: one spot per display it is to show on. A display with a camera
 * housing gives the housing's own size; any other gets a stand-in in the same place, so the float works the same on
 * an external display. None when the place is the corner, or when the only display asked for is not connected (the
 * built-in one of a laptop with its lid shut): the float then stands in the corner.
 */
function notchSpots(): NotchSpot[] {
  if (!TOP_PLACE || settings.floatPlace !== "top") return [];
  const housings = new Map(glass.notches().map((n) => [n.id, n]));
  const spot = (d: Electron.Display): NotchSpot => {
    const housing = housings.get(d.id);
    const bar = d.workArea.y - d.bounds.y;
    return housing ? { id: d.id, display: d.bounds, width: Math.round(housing.width), height: Math.round(housing.height), real: true } : { id: d.id, display: d.bounds, width: STAND_IN.width, height: bar > 0 ? bar : STAND_IN.height, real: false };
  };
  const displays = screen.getAllDisplays();
  if (settings.notchDisplay === "all") return displays.map(spot);
  if (settings.notchDisplay === "builtin") return displays.filter((d) => d.internal).slice(0, 1).map(spot);
  // The display being worked on: the one whose window has the keyboard, or failing that the one the pointer is on.
  const working = glass.mainDisplay();
  return [spot(displays.find((d) => d.id === working) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))];
}

/**
 * How much of the menu bar is free on each side of a spot's housing. The frontmost app's menus come up to it from
 * the left and the status icons from the right. Both are read off whichever display has them (the menus where the
 * app draws them, the icons where they are windows) and carried over to this one: every display's bar is laid out
 * alike, the menus from its left edge and the icons from its right.
 */
function barRoom(spot: NotchSpot): Room {
  const displays = screen.getAllDisplays();
  const target = displays.find((d) => d.id === spot.id);
  if (!target) return { left: null, right: null };
  const strip = (d: Electron.Display) => ({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: Math.max(d.workArea.y - d.bounds.y, STAND_IN.height) });
  const here = glass.menuBar(strip(target));
  const drawnOn = here.menus ? displays.find((d) => Math.abs(d.bounds.y - here.menusTop) <= 2 && here.menusStart >= d.bounds.x && here.menusStart < d.bounds.x + d.bounds.width) : undefined;
  const menus = drawnOn ? here.menusEnd - drawnOn.bounds.x : null;
  let icons = here.items ? target.bounds.x + target.bounds.width - here.itemsStart : null;
  for (const d of displays) {
    if (icons !== null) break;
    if (d.id === target.id) continue;
    const there = glass.menuBar(strip(d));
    if (there.items) icons = d.bounds.x + d.bounds.width - there.itemsStart;
  }
  // The housing is centred, so it is as far from one edge as from the other.
  const beside = (target.bounds.width - spot.width) / 2;
  return { left: menus === null ? null : beside - menus, right: icons === null ? null : beside - icons };
}

/**
 * At the top the float is ambient: it is there whenever the main window is not the one being looked at, and steps
 * aside while it is, since the two show the same sessions. (In the corner it is the main window's minimized form
 * and only comes when asked for.) Focus passes through other windows on its way, so this waits a moment.
 */
const ambient = () => TOP_PLACE && settings.floatPlace === "top";
let ambientTimer: NodeJS.Timeout | undefined;
/** The float is up beside the main window so the person can see what a setting does to it (the settings page asks
 *  for this while its float settings are being changed). Until that is over neither rule above takes it away. */
let previewing = false;
function setPreview(on: boolean) {
  if (!floatControl || quitRequested) return;
  previewing = on;
  if (on) return floatControl.show({ quiet: true });
  // Over: in the corner the float is the main window's minimized form again, at the top it follows the main window.
  if (!ambient() && mainWindow?.isVisible()) floatControl.hide({ quiet: true });
  followMainWindow();
}

/** The `clear` style's sheet at its current thickness, on the windows already up: they take it in their address
 *  when they are made, and a change is written straight into their page, so dragging the slider is seen at once. */
function applyFloatOpacity() {
  const alpha = Math.max(0, Math.min(100, Math.round(Number(settings.floatOpacity) || 0))) / 100;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.getURL().includes("look=clear")) continue;
    void win.webContents.executeJavaScript(`document.documentElement.style.setProperty("--glass-veil", "0 0 0 / ${alpha}")`).catch(() => {});
  }
}

function followMainWindow() {
  clearTimeout(ambientTimer);
  ambientTimer = setTimeout(() => {
    if (!ambient() || !floatControl || quitRequested || previewing) return;
    const looking = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused());
    if (looking === floatControl.isVisible()) {
      if (looking) floatControl.hide({ quiet: true });
      else floatControl.show({ quiet: true });
      refreshAttention();
    }
  }, 150);
}

/** How a free-standing floating window looks: the chosen style, or the nearest this machine can do (glass needs
 *  macOS 26). */
function standingLook(): FloatStyle {
  const want = settings.floatStyle;
  if (want === "clear" || want === "solid") return want;
  return GLASS ? "glass" : "solid";
}

/** What this machine can show, for the settings page to offer. */
const floatStyles = (): FloatStyle[] => [...(GLASS ? (["glass"] as const) : []), "clear", "solid"];
const floatPlaces = (): FloatPlace[] => ["corner", ...(TOP_PLACE ? (["top"] as const) : [])];

/**
 * A window that floats above everything on every desktop and never comes forward on its own. Its page is told the
 * look in its address (`?look=`) and paints accordingly (renderer/styles.css):
 *   glass  clear Liquid Glass behind the page (macOS 26), which adds only a thin veil for legibility
 *   clear  nothing behind the page at all; what the window covers shows through sharp, under a dark sheet as
 *          thick as the person set (`&tint=`, percent)
 *   solid  the app's panel color
 *   notch  nothing behind the page, which draws a black shape out of the camera housing; above the menu bar
 */
function floating(route: string, opts: { look: FloatStyle | "notch"; width: number; height: number; focusable: boolean; movable?: boolean; query?: string }): BrowserWindow {
  const transparent = opts.look !== "solid";
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    type: "panel",
    frame: false,
    resizable: false,
    movable: opts.movable ?? false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: opts.focusable,
    alwaysOnTop: true,
    skipTaskbar: true,
    // With nothing behind the page the system would draw a shadow around every letter.
    hasShadow: opts.look === "glass" || opts.look === "solid",
    ...(transparent ? { transparent: true } : { backgroundColor: bg() }),
    // macOS moves a window off the menu bar when it is shown, unless it is one that may be larger than the screen.
    ...(opts.look === "notch" ? { enableLargerThanScreen: true } : {}),
    show: false,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  // The housing is in the menu bar's strip, so the notch form has to be above the menu bar; menus still open over it.
  win.setAlwaysOnTop(true, opts.look === "notch" ? "status" : "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // On the housing it is part of the screen: without this Mission Control shrinks it away from the housing with the
  // rest of the desktop's windows.
  if (opts.look === "notch") glass.pin(win);
  let look = opts.look;
  if (look === "glass" && !glass.attach(win, { radius: GLASS_RADIUS, clear: true })) {
    look = "solid";
    win.setBackgroundColor(bg());
  }
  if (look !== "solid") seeThrough.add(win);
  const tint = look === "clear" ? `&tint=${Math.max(0, Math.min(100, Math.round(Number(settings.floatOpacity) || 0)))}` : "";
  void loadRoute(win, `${route}?look=${look}${tint}${opts.query ?? ""}`);
  return win;
}

/** The notice panel: for when system notifications are refused. It never takes focus. */
const createNoticePanel = () => floating("/notices", { look: standingLook(), width: 360, height: 84, focusable: false });

/** The floating session window: the main window's minimized form, so exactly one of the two is showing. It can take
 *  focus, since a reply is typed into it, but never comes forward on its own; it is dragged by its header, except
 *  in the notch form, which stays on the housing and is told the housing's size in its address. */
function setupFloat() {
  floatControl = createFloatControl({
    createWindow: (notch) => (notch ? floating("/float", { look: "notch", width: 240, height: 40, focusable: true, query: `&nw=${notch.width}&nh=${notch.height}&real=${notch.real ? 1 : 0}&rest=${settings.notchRest}&corners=${settings.notchCorners}&open=${settings.notchOpen}` }) : floating("/float", { look: standingLook(), width: 240, height: 40, focusable: true, movable: true })),
    notches: notchSpots,
    room: barRoom,
    position: () => settings.floatPosition,
    savePosition: (p) => {
      settings = { ...settings, floatPosition: p };
      saveSettings(settingsPath, settings);
    },
    offscreen: OFFSCREEN,
    onVisibility: (visible) => {
      if (visible) mainWindow?.hide();
      else if (!mainWindow?.isVisible()) showMain();
      refreshAttention();
      broadcast("chancery:changed");
    },
  });
  if (settings.floatOnStart) floatControl.show();
  else followMainWindow();
  ipcMain.handle("float:preview", (_ev, on: boolean) => setPreview(Boolean(on)));
  // A lid shut or opened, a display plugged in or rearranged: the housing may have come, gone or moved.
  const rehang = () => floatControl?.rehang();
  screen.on("display-added", rehang);
  screen.on("display-removed", rehang);
  screen.on("display-metrics-changed", rehang);
  // Nothing says when the person moves to another display, so while the float follows them it looks.
  setInterval(() => {
    if (floatControl?.isVisible() && settings.floatPlace === "top" && settings.notchDisplay === "active") rehang();
  }, FOLLOW_DISPLAY_MS).unref();
}

/** Independent of the database: sessions are read from the two apps' own files, so this runs even when boot fails. */
function startWatchingSessions() {
  notifier = createNotifier({
    channel: process.env.CHANCERY_NOTICES === "panel" ? "panel" : "auto",
    offscreen: OFFSCREEN,
    keepClearOf: () => floatControl?.bounds() ?? null,
    createPanel: createNoticePanel,
    onPanelChange: () => broadcast("chancery:notices"),
    log,
  });
  sessionWatch = startSessionWatch({
    claudeBin: () => settings.claudeBin,
    home: process.env.CHANCERY_SESSIONS_HOME || undefined,
    alertsEnabled: () => settings.sessionAlerts,
    lang,
    notify: (notice) => notifier?.notify(notice),
    onChange: (overview) => {
      heldUp = heldUpSessions(overview);
      refreshAttention();
      broadcast("chancery:changed");
    },
    onOpen: (alert) => jumpTo(alert.session),
    onOpenList: () => {
      showMain();
      if (mainWindow) void loadRoute(mainWindow, "/sessions");
    },
    log,
  });
}

/**
 * The ticket pipeline's side: the database, the daemon on top of it, the MCP server. The session overview needs none
 * of it, so the window is up before this starts and stays usable when it fails.
 */
async function boot(): Promise<Backend> {
  pg = await startPg({ dataDir: join(userData, "pgdata"), port: settings.pgPort, external: settings.pgConnectionString || undefined, log });
  db = createDb(pg.connectionString);
  const applied = await migrate(db);
  if (applied.length) log(`migrations applied: ${applied.join(", ")}`);
  const repo = createRepo(db);
  daemon = createDaemon({
    db,
    repo,
    executors: {
      "claude-desktop": createClaudeDesktopExecutor({
        claudeBin: settings.claudeBin,
        permissionMode: settings.permissionMode,
        launchMode: settings.claudeLaunchMode,
        axctlPath,
        runDir: join(logDir, "runs"),
        log,
        onExit: () => void daemon?.tick(),
        lowPriority: settings.workerLowPriority,
        userData,
      }),
      codex: createCodexExecutor({
        codexBin: settings.codexBin,
        model: settings.codexModel || undefined,
        sandbox: settings.codexSandbox,
        launchMode: settings.codexLaunchMode,
        axctlPath,
        runDir: join(logDir, "runs"),
        log,
        onExit: () => void daemon?.tick(),
        lowPriority: settings.workerLowPriority,
      }),
    },
    worktreeRoot: settings.worktreeRoot,
    intervalMs: settings.daemonIntervalMs,
    log,
    onChange: () => {
      keepAwake((daemon?.status().active ?? 0) > 0);
      broadcast("chancery:changed");
    },
    clerk: clerkFor,
    auditEnabled: () => settings.auditEnabled,
  });
  await daemon.start();
  log("daemon started");
  mcpHttp = startMcpHttp({ repo, daemon }, settings.mcpPort, log);
  return { repo, daemon };
}

/** Every channel the pages call. The ones that stand on the database wait for `backend`; the rest answer at once. */
function setupIpc(backend: Promise<Backend>) {
  registerIpc({
    backend: () => backend,
    settings: () => settings,
    saveSettings: (s) => {
      if (s.theme !== settings.theme) applyTheme(s.theme);
      if (s.launchAtLogin !== settings.launchAtLogin) applyLoginItem(s.launchAtLogin);
      const languageChanged = s.language !== settings.language;
      // The page is told all of these in its address, so a change of any of them is a new window.
      const styleChanged = (["floatStyle", "notchRest", "notchCorners", "notchOpen"] as const).some((key) => s[key] !== settings[key]);
      const placeChanged = s.floatPlace !== settings.floatPlace || s.notchDisplay !== settings.notchDisplay;
      const opacityChanged = s.floatOpacity !== settings.floatOpacity;
      settings = s;
      saveSettings(settingsPath, s);
      if (languageChanged) applyLanguage();
      if (styleChanged) {
        floatControl?.remake();
        notifier?.remakePanel();
      } else if (placeChanged) {
        floatControl?.rehang();
      }
      if (opacityChanged) applyFloatOpacity();
      if (placeChanged && !previewing) {
        // Back in the corner the float is the main window's minimized form again: not there while that is up.
        if (!ambient() && mainWindow?.isVisible()) floatControl?.hide({ quiet: true });
        followMainWindow();
      }
    },
    lang,
    worktreeRoot: () => settings.worktreeRoot,
    pgInfo: () => ({ embedded: pg?.embedded ?? false, connectionString: pg?.connectionString.replace(/:[^:@/]+@/, ":***@") ?? "" }),
    axctlPath,
    floatStyles,
    floatPlaces,
    log,
    showMain,
    sessions: () => sessionWatch?.latest() ?? Promise.reject(new Error("session watch is not running")),
    refreshSessions: () => void sessionWatch?.refresh().catch(() => {}),
    sessionsHome: process.env.CHANCERY_SESSIONS_HOME || undefined,
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMain);
  app.whenReady().then(() => {
    log(`chancery starting, userData ${userData}`);
    startWatchingSessions();
    setupFloat();
    // The database comes up behind the window, not before it: the first start initialises a Postgres cluster, which
    // takes seconds, and the sessions on the first page are read from the two apps' own files.
    const backend = boot().catch((err: unknown) => {
      log(`boot failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      throw new Error(t(lang(), "backend.unavailable", { error: err instanceof Error ? err.message : String(err) }));
    });
    // Up or failed, the pages that were waiting on it ask again. A failure is each caller's to report.
    booting = backend.then(
      () => broadcast("chancery:changed"),
      () => broadcast("chancery:changed"),
    );
    setupIpc(backend);
    // Started minimized to the floating window: the main window waits until that is put away.
    if (!floatControl?.isVisible()) showMain();
    setupTray();
    applyLoginItem(settings.launchAtLogin);
    if (!globalShortcut.register(settings.quickCaptureShortcut, toggleCapture)) log(`shortcut ${settings.quickCaptureShortcut} could not be registered`);
  });
  app.on("activate", showMain);
  // A SIGTERM (npm run dev tearing down, a kill from a terminal) must still stop the embedded Postgres.
  // embedded-postgres registers its own SIGTERM/SIGINT handlers (exit-hook) that stop the server and then
  // process.exit; racing them against our own shutdown left the app hanging once, so there is one path: ours.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.removeAllListeners(sig);
    process.on(sig, () => {
      if (quitting) {
        log(`${sig} again while quitting; exiting now`);
        app.exit(1);
        return;
      }
      app.quit();
    });
  }
  app.on("window-all-closed", () => {
    // Stay resident: the daemon keeps working from the tray.
  });
  app.on("before-quit", () => {
    if (quitRequested) return;
    quitRequested = true;
    // Which windows are up when quitting starts, and which of them closes: Electron reaches will-quit only once
    // every window is closed, so a window that stays is what a quit that never finishes looks like in the log.
    const route = (w: BrowserWindow) => `${w.webContents.getURL().split("#")[1] ?? "?"}${w.isVisible() ? "" : "(hidden)"}`;
    log(`quit requested; windows: ${BrowserWindow.getAllWindows().map(route).join(", ") || "none"}`);
    for (const w of BrowserWindow.getAllWindows()) {
      const name = route(w); // read now: the contents are gone by the time the window has closed
      w.once("closed", () => log(`quit: window ${name} closed`));
    }
    sessionWatch?.stop();
    globalShortcut.unregisterAll();
    // Whatever keeps a window open (a page that does not answer, a window made after this point), the quit goes on:
    // the shutdown steps run anyway and end the process.
    setTimeout(() => {
      if (quitting) return;
      log(`quit: will-quit did not come in 5 s; windows: ${BrowserWindow.getAllWindows().map(route).join(", ") || "none"}; shutting down anyway`);
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
      void shutdown();
    }, 5_000).unref?.();
  });
  app.on("will-quit", (ev) => {
    if (quitting || (!pg && !daemon && !booting)) return;
    ev.preventDefault();
    void shutdown();
  });
}

/** Stops the daemon, the pool and the embedded Postgres in order, each step bounded, then exits whatever happened. */
async function shutdown(): Promise<void> {
  quitting = true;
  const step = async (name: string, fn: () => Promise<unknown>, ms: number) => {
    const t0 = Date.now();
    const result = await Promise.race([fn().then(() => "ok", (err: unknown) => `failed: ${String(err)}`), new Promise<string>((r) => setTimeout(() => r(`timed out after ${ms} ms`), ms))]);
    log(`quit: ${name} ${result} (${Date.now() - t0} ms)`);
  };
  // Whatever the steps do, the process ends: a stuck step must never keep a half-closed app alive.
  const deadline = setTimeout(() => {
    log("quit: deadline passed; exiting");
    app.exit(0);
  }, 18_000);
  // A database still coming up is waited for, so what it started is there to be stopped below.
  const coming = booting;
  booting = null;
  if (coming) await step("boot settled", () => coming, 6_000);
  const d = daemon;
  const p = pg;
  const database = db;
  daemon = null;
  pg = null;
  db = null;
  mcpHttp?.close();
  if (d) await step("daemon stopped", () => d.stop(), 5_000);
  if (database) await step("pool closed", () => database.close(), 2_000);
  if (p) await step("postgres stopped", () => p.stop(), 5_000);
  clearTimeout(deadline);
  app.exit(0);
}
