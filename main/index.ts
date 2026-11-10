import { app, BrowserWindow, globalShortcut, Menu, nativeImage, nativeTheme, powerSaveBlocker, screen, Tray } from "electron";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createClaudeDesktopExecutor, createCodexExecutor, createDaemon, createDb, createRepo, heldUpSessions, migrate, resolveLang, t, triageTicket, type Daemon, type Db, type Lang, type SessionRow, type Triage } from "../core/index.js";
import { broadcast, registerIpc } from "./ipc.js";
import { createFloatControl, type FloatControl } from "./floatWindow.js";
import { createNotifier } from "./notify.js";
import { openSession } from "./openSession.js";
import { startSessionWatch, type SessionWatch } from "./sessionWatch.js";
import { startPg, type PgHandle } from "./pg.js";
import { startMcpHttp } from "./mcpHttp.js";
import type { Server } from "node:http";
import { loadSettings, saveSettings, type Settings, type ThemePref } from "./settings.js";

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
let settings: Settings = loadSettings(settingsPath);
let pg: PgHandle | null = null;
let db: Db | null = null;
let quitting = false;
/** Set the moment quitting starts (before-quit), ahead of `quitting`, which marks the shutdown steps proper. */
let quitRequested = false;
let daemon: Daemon | null = null;
let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let mcpHttp: Server | null = null;
let awakeBlocker: number | null = null;
let sessionWatch: SessionWatch | null = null;
let floatControl: FloatControl | null = null;
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
nativeTheme.on("updated", () => {
  for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(bg());
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
  });
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
    label: `${clip(s.title || t(l, "common.untitled"), 36)} — ${s.app === "claude" ? "Claude" : "Codex"}`,
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

/** A window that floats above everything on every desktop and never comes forward on its own. */
function floating(route: string, opts: { width: number; height: number; focusable: boolean; movable?: boolean }): BrowserWindow {
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
    hasShadow: true,
    backgroundColor: bg(),
    show: false,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  void loadRoute(win, route);
  return win;
}

/** The notice panel: for when system notifications are refused. It never takes focus. */
const createNoticePanel = () => floating("/notices", { width: 360, height: 84, focusable: false });

/** The floating session window: the main window's minimized form, so exactly one of the two is showing. It can take
 *  focus, since a reply is typed into it, but never comes forward on its own; it is dragged by its header. */
function setupFloat() {
  floatControl = createFloatControl({
    createWindow: () => floating("/float", { width: 240, height: 40, focusable: true, movable: true }),
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
}

/** Independent of the database: sessions are read from the two apps' own files, so this runs even when boot fails. */
function startWatchingSessions() {
  const notifier = createNotifier({
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
    notify: (notice) => notifier.notify(notice),
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

async function boot() {
  log(`chancery starting, userData ${userData}`);
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
  registerIpc({
    repo,
    daemon,
    settings: () => settings,
    saveSettings: (s) => {
      if (s.theme !== settings.theme) applyTheme(s.theme);
      if (s.launchAtLogin !== settings.launchAtLogin) applyLoginItem(s.launchAtLogin);
      const languageChanged = s.language !== settings.language;
      settings = s;
      saveSettings(settingsPath, s);
      if (languageChanged) applyLanguage();
    },
    lang,
    worktreeRoot: () => settings.worktreeRoot,
    pgInfo: () => ({ embedded: pg?.embedded ?? false, connectionString: pg?.connectionString.replace(/:[^:@/]+@/, ":***@") ?? "" }),
    axctlPath,
    log,
    showMain,
    sessions: () => sessionWatch?.latest() ?? Promise.reject(new Error("session watch is not running")),
    refreshSessions: () => void sessionWatch?.refresh().catch(() => {}),
    sessionsHome: process.env.CHANCERY_SESSIONS_HOME || undefined,
  });
  await daemon.start();
  log("daemon started");
  applyLoginItem(settings.launchAtLogin);
  mcpHttp = startMcpHttp({ repo, daemon }, settings.mcpPort, log);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMain);
  app.whenReady().then(async () => {
    startWatchingSessions();
    setupFloat();
    try {
      await boot();
    } catch (err) {
      log(`boot failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    // Started minimized to the floating window: the main window waits until that is put away.
    if (!floatControl?.isVisible()) showMain();
    setupTray();
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
    if (quitting || (!pg && !daemon)) return;
    ev.preventDefault();
    void shutdown();
  });
}

/** Stops the daemon, the pool and the embedded Postgres in order, each step bounded, then exits whatever happened. */
async function shutdown(): Promise<void> {
  quitting = true;
  const d = daemon;
  const p = pg;
  const database = db;
  daemon = null;
  pg = null;
  db = null;
  const step = async (name: string, fn: () => Promise<unknown>, ms: number) => {
    const t0 = Date.now();
    const result = await Promise.race([fn().then(() => "ok", (err: unknown) => `failed: ${String(err)}`), new Promise<string>((r) => setTimeout(() => r(`timed out after ${ms} ms`), ms))]);
    log(`quit: ${name} ${result} (${Date.now() - t0} ms)`);
  };
  // Whatever the steps do, the process ends: a stuck step must never keep a half-closed app alive.
  const deadline = setTimeout(() => {
    log("quit: deadline passed; exiting");
    app.exit(0);
  }, 12_000);
  mcpHttp?.close();
  if (d) await step("daemon stopped", () => d.stop(), 5_000);
  if (database) await step("pool closed", () => database.close(), 2_000);
  if (p) await step("postgres stopped", () => p.stop(), 5_000);
  clearTimeout(deadline);
  app.exit(0);
}
