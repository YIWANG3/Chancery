// Launches one copy of the app per worker against its own userData (settings, embedded Postgres, logs) and a
// throwaway git repository to register as a project. `claude`, `codex` and `gh` on PATH are the fakes in ./bin.
import { _electron as electron, test as base, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** CHANCERY_E2E_REAL=1 runs the specs that spend tokens: the real `claude` CLI (print mode) and, with
 *  DEEPSEEK_API_KEY set, DeepSeek as the clerk. Everything else on PATH stays real too (git, gh). */
export const REAL = process.env.CHANCERY_E2E_REAL === "1";

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The Codex thread every test environment starts with, mid-turn. */
export const CODEX_THREAD = "01a1e2e0-0000-7000-8000-000000000001";

export interface TestEnv {
  root: string;
  userData: string;
  /** The git repository registered as the project "demo-project". */
  projectDir: string;
  /** Where the fake CLIs record each call: claude-<n>.args / claude-<n>.prompt */
  fakeLog: string;
  worktreeRoot: string;
  /** Stands in for the home directory the session overview reads Claude Desktop's and Codex's state from. */
  sessionsHome: string;
  /** This worker's ports: each worker runs its own copy of the app, so two spec files can run side by side. */
  pgPort: number;
  mcpPort: number;
}

/** Writes one entry of Claude Desktop's session index under the stand-in home, the way the app itself would. */
export function writeClaudeSession(env: TestEnv, id: string, entry: Record<string, unknown>): void {
  const dir = join(env.sessionsHome, "Library", "Application Support", "Claude", "claude-code-sessions", "org", "user");
  mkdirSync(dir, { recursive: true });
  // Written whole: the overview only reads `local_*.json`, so a half-written `.tmp` is never picked up by a read
  // that lands between the two steps.
  const tmp = join(dir, `${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ sessionId: id, cwd: env.projectDir, originCwd: env.projectDir, isArchived: false, lastActivityAt: Date.now(), ...entry }));
  renameSync(tmp, join(dir, `${id}.json`));
}

/** Puts one thread, with its newest turn, into stand-ins for the Codex app's two databases. Only the columns the
 *  overview reads exist. Calling it again for the same thread replaces what was there, like the next turn would. */
export function writeCodexThread(env: TestEnv, id: string, t: { title: string; turn: number; status: "inProgress" | "completed" | "failed" | "interrupted"; unread?: boolean; error?: string }): void {
  const dir = join(env.sessionsHome, ".codex");
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const sqlite = (db: string, sql: string) => execFileSync("sqlite3", [join(dir, db), sql], { stdio: "pipe" });
  sqlite(
    "state_5.sqlite",
    `CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, source TEXT, archived INTEGER, recency_at_ms INTEGER, updated_at_ms INTEGER, updated_at INTEGER);
     CREATE TABLE IF NOT EXISTS thread_read_receipts (thread_id TEXT PRIMARY KEY, first_unread_turn TEXT);
     INSERT OR REPLACE INTO threads VALUES (${sqlText(id)}, ${sqlText(t.title)}, NULL, ${sqlText(env.projectDir)}, 'vscode', 0, ${now}, ${now}, ${Math.floor(now / 1000)});
     INSERT OR REPLACE INTO thread_read_receipts VALUES (${sqlText(id)}, ${t.unread ? sqlText(`turn-${t.turn}`) : "NULL"});`,
  );
  sqlite(
    "thread_history_1.sqlite",
    `CREATE TABLE IF NOT EXISTS thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT, error_json TEXT, PRIMARY KEY (thread_id, rollout_ordinal));
     CREATE TABLE IF NOT EXISTS thread_items (thread_id TEXT, created_at_ms INTEGER);
     INSERT OR REPLACE INTO thread_turns VALUES (${sqlText(id)}, ${t.turn}, ${sqlText(t.status)}, ${t.error ? sqlText(JSON.stringify({ message: t.error })) : "NULL"});
     INSERT INTO thread_items VALUES (${sqlText(id)}, ${now});`,
  );
  // Leave both databases the way the real ones are whenever the Codex app has no connection open: WAL mode with
  // neither side file on disk. A plain read-only open fails on that, so every read in the suite goes through the
  // overview's fallback.
  for (const db of ["state_5.sqlite", "thread_history_1.sqlite"]) {
    sqlite(db, "PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);");
    for (const side of ["-wal", "-shm"]) rmSync(join(dir, `${db}${side}`), { force: true });
  }
}

/** Puts one agent session ("composer") into a stand-in for Cursor's global state database, the way Cursor keeps
 *  it: a header row with the name, the folder and the flags its sidebar reads, and the composer's own record. */
export function writeCursorComposer(env: TestEnv, id: string, c: { name: string; status: "generating" | "completed" | "aborted"; blocking?: boolean; unread?: boolean }): void {
  const dir = join(env.sessionsHome, "Library", "Application Support", "Cursor", "User", "globalStorage");
  mkdirSync(dir, { recursive: true });
  const header = { name: c.name, isDraft: false, workspaceIdentifier: { id: "w", uri: { fsPath: env.projectDir } }, hasBlockingPendingActions: Boolean(c.blocking), hasPendingPlan: false, hasUnreadMessages: Boolean(c.unread) };
  execFileSync(
    "sqlite3",
    [
      join(dir, "state.vscdb"),
      `CREATE TABLE IF NOT EXISTS composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, value TEXT);
       CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
       INSERT OR REPLACE INTO composerHeaders VALUES (${sqlText(id)}, 'w', ${Date.now()}, ${Date.now()}, 0, 0, ${sqlText(JSON.stringify(header))});
       INSERT OR REPLACE INTO cursorDiskKV VALUES (${sqlText(`composerData:${id}`)}, ${sqlText(JSON.stringify({ status: c.status }))});`,
    ],
    { stdio: "pipe" },
  );
}

/** Writes the transcript of a Claude Code session started in a terminal, the way the CLI keeps it: one JSON line
 *  per message, each saying where it came from (`entrypoint`) and where it ran. */
export function writeClaudeCliTranscript(env: TestEnv, id: string, t: { ask: string; ended: boolean }): void {
  const dir = join(env.sessionsHome, ".claude", "projects", "-demo-project");
  mkdirSync(dir, { recursive: true });
  const common = { entrypoint: "cli", cwd: env.projectDir, isSidechain: false, sessionId: id };
  const lines: Array<Record<string, unknown>> = [
    { type: "user", uuid: "u1", ...common, message: { role: "user", content: t.ask } },
    { type: "assistant", uuid: "a1", ...common, message: { role: "assistant", stop_reason: t.ended ? "end_turn" : "tool_use", content: [{ type: "text", text: "…" }] } },
    ...(t.ended ? [{ type: "system", subtype: "turn_duration", uuid: "t1", ...common }] : []),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fakeBin = join(repoRoot, "tests", "e2e", "bin");

function makeEnv(workerIndex: number): TestEnv {
  const root = mkdtempSync(join(process.env.CHANCERY_E2E_ROOT ?? tmpdir(), "chancery-e2e-"));
  // Ports differ from the app's defaults so the tests can run while the real app is open, and from each other so
  // two workers can run at once.
  const pgPort = 54339 + workerIndex;
  const mcpPort = 41720 + workerIndex;
  const userData = join(root, "userData");
  const projectDir = join(root, "demo-project");
  const fakeLog = join(root, "fake-log");
  const worktreeRoot = join(root, "worktrees");
  const sessionsHome = join(root, "sessions-home");
  for (const d of [userData, projectDir, fakeLog, worktreeRoot, sessionsHome]) mkdirSync(d, { recursive: true });

  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd: projectDir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(projectDir, "README.md"), "# demo project\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");

  // The shortcut differs from the default for the same reason as the ports.
  writeFileSync(
    join(userData, "settings.json"),
    JSON.stringify(
      {
        theme: "light",
        // The specs read the interface in Chinese whatever language the machine running them is in.
        language: "zh",
        pgPort,
        mcpPort,
        worktreeRoot,
        claudeBin: REAL ? (process.env.CHANCERY_E2E_CLAUDE ?? "claude") : join(fakeBin, "claude"),
        claudeLaunchMode: "print",
        permissionMode: REAL ? (process.env.CHANCERY_E2E_PERMISSION_MODE ?? "bypassPermissions") : "auto",
        codexBin: REAL ? "codex" : join(fakeBin, "codex"),
        quickCaptureShortcut: "CommandOrControl+Alt+Shift+F19",
        daemonIntervalMs: 1000,
        clerkBackend: REAL ? "auto" : "claude",
        autoTriage: false,
        auditEnabled: true,
        workerLowPriority: false,
        // Notices are on, but CHANCERY_NOTICES=panel (below) keeps them in the app's own panel, and
        // CHANCERY_OFFSCREEN puts that panel and the floating window outside every display: a test run raises no
        // system notification and puts nothing on top of the windows of whoever runs it.
        // CHANCERY_NO_EXTERNAL_OPEN makes a jump only log where it would have gone.
        sessionAlerts: true,
        // The first-open note is put away; the spec that is about it brings it back.
        welcomed: true,
        deepseekApiKey: REAL ? (process.env.DEEPSEEK_API_KEY ?? "") : "",
      },
      null,
      2,
    ),
  );
  const env = { root, userData, projectDir, fakeLog, worktreeRoot, sessionsHome, pgPort, mcpPort };
  writeClaudeSession(env, "local_e2e-1", { title: "端到端会话", lastAssistantUuid: "u1", postTurnSummaryFor: "u1", postTurnSummary: { status_category: "completed", status_detail: "第一轮做完了" } });
  writeCodexThread(env, CODEX_THREAD, { title: "端到端线程", turn: 1, status: "inProgress" });
  return env;
}

export const test = base.extend<{ evidence: void }, { env: TestEnv; app: ElectronApplication; win: Page }>({
  env: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const env = makeEnv(workerInfo.parallelIndex);
      await use(env);
      if (!process.env.CHANCERY_E2E_KEEP) rmSync(env.root, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],
  app: [
    async ({ env }, use) => {
      const app = await electron.launch({
        args: [repoRoot],
        // These specs exercise the ticket pipeline, whose page is no longer in the navigation, so start on it.
        // CHANCERY_STEWARD_CONFIRM answers the dialog the steward's reply and new-session tools put up, which
        // nobody is there to click.
        // The session watch reads every second instead of every ten: the specs that change a session file and wait
        // for the list to follow would otherwise spend most of their time waiting for the next read.
        env: { ...process.env, CHANCERY_ROUTE: "/tickets", CHANCERY_USER_DATA: env.userData, CHANCERY_SESSIONS_HOME: env.sessionsHome, CHANCERY_SESSION_POLL_MS: "1000", CHANCERY_NOTICES: "panel", CHANCERY_OFFSCREEN: "1", CHANCERY_NO_EXTERNAL_OPEN: "1", CHANCERY_STEWARD_CONFIRM: "yes", CHANCERY_AXCTL: join(fakeBin, "axctl"), CHANCERY_FAKE_LOG: env.fakeLog, PATH: REAL ? (process.env.PATH ?? "") : `${fakeBin}:${process.env.PATH ?? ""}` },
        timeout: 120_000, // the first start initialises the embedded Postgres cluster
      });
      await use(app);
      await app.close();
    },
    { scope: "worker" },
  ],
  win: [
    async ({ app }, use) => {
      const win = await app.firstWindow();
      await win.waitForLoadState("domcontentloaded");
      await use(win);
    },
    { scope: "worker" },
  ],
  // When a test fails, what was on every window, the app's log and the fake CLIs' records are attached to the
  // report. The specs are serial, so without this a failure deep in the chain leaves nothing to look at in CI.
  evidence: [
    async ({ app, env }, use, testInfo) => {
      await use();
      if (testInfo.status === testInfo.expectedStatus) return;
      for (const [i, page] of app.windows().entries()) {
        const name = page.url().split("#")[1]?.replace(/\W+/g, "-").replace(/^-+|-+$/g, "") || `window-${i}`;
        const path = testInfo.outputPath(`${name}.png`);
        await page.screenshot({ path, fullPage: true }).then(() => testInfo.attach(`window ${name}`, { path, contentType: "image/png" })).catch(() => {});
      }
      const log = join(env.userData, "logs", "chancery.log");
      if (existsSync(log)) await testInfo.attach("chancery.log", { path: log, contentType: "text/plain" });
      if (existsSync(env.fakeLog)) {
        for (const f of readdirSync(env.fakeLog).sort()) {
          const path = join(env.fakeLog, f);
          if (!f.startsWith(".")) await testInfo.attach(`fake-log/${f}`, { path, contentType: "text/plain" });
        }
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
