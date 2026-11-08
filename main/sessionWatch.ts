// Keeps reading the session overview in the background, so a session that stops to wait is noticed while no window
// is open: a notice that jumps to the session when clicked, and a fresh snapshot for the page, the menu bar item and
// the dock badge.
import { BrowserWindow } from "electron";
import { buildOverview, createAlertTracker, type AlertKind, type Overview, type SessionAlert, type SessionApp } from "../core/index.js";
import { run } from "../core/util/run.js";
import type { Notice } from "./notify.js";

const POLL_MS = 10_000;
/** A snapshot this recent is handed to the page as is. Longer than one poll, so while the loop is alive the page
 *  never causes a second read; it only does when the loop has fallen behind. */
const FRESH_MS = 15_000;
/** More alerts than this from one read are folded into a single notification. */
const MAX_SEPARATE = 3;

const APP_NAME: Record<SessionApp, string> = { claude: "Claude", codex: "Codex" };
const APP_BUNDLE: Record<SessionApp, string> = { claude: "com.anthropic.claudefordesktop", codex: "com.openai.codex" };

const KIND_LABEL: Record<AlertKind, string> = { "needs-you": "等你", error: "出错", stuck: "卡住", review: "待审", finished: "跑完了" };

export interface SessionWatchDeps {
  claudeBin: () => string;
  /** Read the two apps' state from under this directory instead of the real home (tests, a scratch profile). */
  home?: string;
  /** Whether to raise notices. The watch keeps the snapshot and the counts current either way. */
  alertsEnabled: () => boolean;
  notify: (notice: Notice) => void;
  /** Called after every read whose sessions differ from the previous one. */
  onChange: (overview: Overview) => void;
  /** A clicked notice about one session. */
  onOpen: (alert: SessionAlert) => void;
  /** A clicked notice that stands for several sessions. */
  onOpenList: () => void;
  log: (msg: string) => void;
}

export interface SessionWatch {
  /** The newest snapshot; reads again when the one in hand is not fresh. Reads in flight are shared. */
  latest(): Promise<Overview>;
  /** Reads now instead of at the next poll, for right after something here changed a session. */
  refresh(): Promise<Overview>;
  stop(): void;
}

/** The bundle id of the app in front, or "" when it cannot be told. No permission needed. */
async function frontmostBundleId(): Promise<string> {
  try {
    const { stdout: asn } = await run("lsappinfo", ["front"], { timeoutMs: 3_000 });
    const { stdout } = await run("lsappinfo", ["info", "-only", "bundleid", asn.trim()], { timeoutMs: 3_000 });
    return /"CFBundleIdentifier"="([^"]+)"/.exec(stdout)?.[1] ?? "";
  } catch {
    return "";
  }
}

/** Everything that would make two reads look different to a person, and nothing that changes on its own. */
const fingerprint = (o: Overview): string => [...o.sessions.map((s) => `${s.app}:${s.id}:${s.state}:${s.turn}:${s.detail}:${s.title}`), ...o.errors].join("\n");

export function startSessionWatch(deps: SessionWatchDeps): SessionWatch {
  const tracker = createAlertTracker();
  let snapshot: Overview | null = null;
  let lastPrint = "";
  let inFlight: Promise<Overview> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function announce(alerts: SessionAlert[]): Promise<void> {
    if (!alerts.length || !deps.alertsEnabled()) return;
    // Looking at the list here, or at the app the session lives in, already shows the change.
    if (BrowserWindow.getFocusedWindow()) {
      deps.log(`sessions: ${alerts.length} not notified, this window is in front`);
      return;
    }
    const front = await frontmostBundleId();
    const due = alerts.filter((a) => APP_BUNDLE[a.session.app] !== front);
    if (due.length < alerts.length) deps.log(`sessions: ${alerts.length - due.length} not notified, their app is in front`);
    if (!due.length) return;
    if (due.length > MAX_SEPARATE) {
      const waiting = due.filter((a) => a.kind !== "finished" && a.kind !== "review").length;
      deps.notify({ title: `${due.length} 个会话有新状态`, body: waiting ? `其中 ${waiting} 个在等你。点开看列表。` : "点开看列表。", onClick: deps.onOpenList });
      return;
    }
    for (const a of due) {
      const s = a.session;
      deps.notify({
        title: `${KIND_LABEL[a.kind]} · ${s.title || "（无标题）"}`,
        subtitle: [APP_NAME[s.app], a.project].filter(Boolean).join(" · "),
        body: s.detail || (a.kind === "finished" ? "这一轮结束了。" : ""),
        onClick: () => deps.onOpen(a),
      });
    }
  }

  async function read(): Promise<Overview> {
    const front = await frontmostBundleId();
    const overview = await buildOverview({ claudeBin: deps.claudeBin(), home: deps.home, claudeInFront: front === APP_BUNDLE.claude });
    snapshot = overview;
    const alerts = tracker.feed(overview);
    const print = fingerprint(overview);
    if (print !== lastPrint) {
      lastPrint = print;
      deps.onChange(overview);
    }
    if (alerts.length) deps.log(`sessions: ${alerts.map((a) => `${a.kind} ${a.session.app}:${a.session.id}`).join(", ")}`);
    void announce(alerts).catch((err: unknown) => deps.log(`session notice failed: ${String(err)}`));
    return overview;
  }

  const shared = (): Promise<Overview> => {
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const loop = () => {
    if (stopped) return;
    void shared()
      .catch((err: unknown) => deps.log(`session watch: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, POLL_MS);
      });
  };
  loop();

  return {
    latest: () => (snapshot && Date.now() - snapshot.readAt < FRESH_MS ? Promise.resolve(snapshot) : shared()),
    refresh: shared,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
