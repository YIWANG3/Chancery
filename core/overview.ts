// The session overview: every Claude Desktop and Codex session on this machine, each with one state, grouped by
// project. Read-only: it looks at the two apps' own local state and writes nothing.
//
// Sources (none is a public format, so every read is defensive and a source that cannot be read lands in `errors`
// instead of taking the overview down):
//   Claude  ~/Library/Application Support/Claude/claude-code-sessions/<org>/<user>/local_*.json   desktop index
//           `claude agents --json`                                                               live busy / idle
//   Codex   ~/.codex/state_5.sqlite           threads, thread_read_receipts
//           ~/.codex/thread_history_1.sqlite  thread_turns, thread_items
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { desktopIndexRoot, type SessionOpen } from "./claude/desktopIndex.js";
import { listClaudeAgents } from "./claude/sessions.js";
import { run } from "./util/run.js";
import { sqliteJson, sqlQuote } from "./util/sqlite.js";

export type SessionApp = "claude" | "codex";

export type SessionState =
  | "needs-you" // stopped on something only a person can settle
  | "error" // the last turn failed (quota, overload, …)
  | "stuck" // still marked running but nothing has moved for a long time
  | "review" // finished with something to look at (a PR, a result awaiting CI)
  | "unread" // finished, and the app says it has not been opened since
  | "running"
  | "interrupted"
  | "expired" // finished and left unopened for so long that nobody is going to look at it
  | "done";

/** Sort order: what needs a person first, then what is still moving, then what is merely waiting to be looked at,
 *  then the rest. Running comes before the waiting-to-be-looked-at states on purpose: a Codex thread stays "unread"
 *  until it is opened in the Codex app, so a dozen of them from days ago would otherwise bury the session that
 *  started a minute ago. */
export const SESSION_STATE_ORDER: SessionState[] = ["needs-you", "error", "stuck", "running", "review", "unread", "interrupted", "expired", "done"];

export interface SessionVerdict {
  state: SessionState;
  /** One line: what it needs, where it stands, or the error. Empty when the source says nothing. */
  detail: string;
  /** Which field decided the state. Shown as a tooltip so a wrong state can be traced to its source. */
  basis: string;
  /** Which turn the state describes: the same value for as long as the session has not moved on, a new one once it
   *  has. Empty while nothing has settled (still running, or finished but not yet summarised). Alerts use it to fire
   *  once per turn. */
  turn: string;
}

export interface SessionRow extends SessionVerdict {
  app: SessionApp;
  /** `local_…` for Claude Desktop, the thread id for Codex. */
  id: string;
  title: string;
  /** Last activity, ms since epoch. */
  at: number;
  cwd: string;
  projectKey: string;
  /** Where the conversation can be reopened in its own app. */
  open: SessionOpen | null;
}

export interface ProjectGroup {
  /** The git repository root both apps' sessions were folded into, or the directory itself outside git. */
  key: string;
  name: string;
  dir: string | null;
  apps: SessionApp[];
  sessions: number;
  counts: Record<SessionState, number>;
  lastAt: number;
}

export interface Overview {
  projects: ProjectGroup[];
  sessions: SessionRow[];
  readAt: number;
  /** One line per source that could not be read. */
  errors: string[];
}

/** Sessions whose directory no longer exists are folded into this one group. */
export const OTHER_PROJECT_KEY = "(other)";

/** A Codex turn still marked inProgress with no activity for this long is shown as stuck rather than running. A long
 *  command writes nothing while it runs, so this is deliberately generous. */
export const CODEX_STALE_MS = 30 * 60_000;

/** A Codex thread that finished and was not opened within this long is shown as expired rather than unread: Codex
 *  keeps the unread mark until the thread is opened in its app, so without this a dozen finished threads from last
 *  week would sit in "waiting to be looked at" forever. */
export const UNREAD_EXPIRE_MS = 86_400_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * One Claude Desktop index entry plus what `claude agents` says about its process.
 *
 * The index carries a model-written summary of the last turn (`postTurnSummary`): a category (`completed`,
 * `review_ready`, `blocked`), a line about where things stand, and, when blocked, what the person has to do. Claude
 * Desktop clears it when a new turn starts, and `postTurnSummaryFor` names the reply it describes, so a summary that
 * does not match the last reply is ignored.
 */
export function classifyClaude(entry: Record<string, unknown>, liveStatus: string | undefined): SessionVerdict {
  if (liveStatus === "busy") return { state: "running", detail: "", basis: "claude agents: busy", turn: "" };
  // An error is current only if nothing was sent after it.
  if (str(entry.error) && num(entry.errorAt) >= num(entry.latestUserFrameAt)) return { state: "error", detail: str(entry.error), basis: "index.error", turn: `error:${num(entry.errorAt)}` };
  const summary = isRecord(entry.postTurnSummary) ? entry.postTurnSummary : null;
  if (!summary) return { state: "done", detail: "", basis: "no summary", turn: "" };
  if (entry.postTurnSummaryFor !== entry.lastAssistantUuid) return { state: "done", detail: "", basis: "summary is for an earlier reply", turn: "" };
  const category = str(summary.status_category);
  const needs = str(summary.needs_action);
  const status = str(summary.status_detail);
  const basis = `postTurnSummary.${category || "?"}`;
  const turn = str(entry.lastAssistantUuid);
  if (category === "blocked" || needs) return { state: "needs-you", detail: needs || status, basis, turn };
  if (category === "review_ready") return { state: "review", detail: status, basis, turn };
  return { state: "done", detail: status, basis, turn };
}

export interface CodexThreadFacts {
  /** `thread_turns.status` of the newest turn: inProgress | completed | failed | interrupted. */
  turnStatus: string | null;
  /** The newest turn's position in the thread (`rollout_ordinal`); null when the thread has no turn on record. */
  turnOrdinal: number | null;
  errorJson: string | null;
  unread: boolean;
  /** Newest of the thread's last item and its own recency stamp, ms. */
  lastActivityAt: number;
}

/** `thread_turns.error_json` is `{"message": "...", …}`; anything else reads as no message. */
function codexErrorMessage(errorJson: string | null): string {
  try {
    const parsed: unknown = JSON.parse(errorJson ?? "{}");
    return isRecord(parsed) ? str(parsed.message) : "";
  } catch {
    return "";
  }
}

/**
 * Codex records a turn's status as it happens, and a read receipt per thread. It has nothing like Claude's
 * "blocked on a question": a finished turn that asked something and one that simply finished look the same, so the
 * most this can say is "finished and not opened since".
 */
export function classifyCodex(t: CodexThreadFacts, now: number): SessionVerdict {
  const basis = t.turnStatus ? `thread_turns.${t.turnStatus}` : "no turn";
  const turn = t.turnOrdinal === null ? "" : String(t.turnOrdinal);
  if (t.turnStatus === "inProgress") {
    const idle = now - t.lastActivityAt;
    if (idle > CODEX_STALE_MS) return { state: "stuck", detail: `${Math.round(idle / 60_000)} 分钟没有动静`, basis, turn };
    return { state: "running", detail: "", basis, turn: "" };
  }
  if (t.turnStatus === "failed") return { state: "error", detail: codexErrorMessage(t.errorJson), basis, turn };
  if (t.turnStatus === "interrupted") return { state: "interrupted", detail: "", basis, turn };
  if (t.turnStatus === "completed" && t.unread) {
    const idle = now - t.lastActivityAt;
    if (idle > UNREAD_EXPIRE_MS) return { state: "expired", detail: `完成后 ${Math.floor(idle / 86_400_000)} 天没打开`, basis: `${basis} + unread, expired`, turn };
    return { state: "unread", detail: "", basis: `${basis} + unread`, turn };
  }
  return { state: "done", detail: "", basis, turn };
}

const WORKTREE_SUFFIX = /\/\.(?:claude|chancery)\/worktrees\/[^/]+(?:\/.*)?$/;
/** `<repo>/.claude/worktrees/<slug>/…` → `<repo>`. For a worktree that was already removed, where git cannot be asked. */
export const stripWorktree = (dir: string): string => dir.replace(WORKTREE_SUFFIX, "");

const isDirectory = async (dir: string): Promise<boolean> => (await stat(dir).catch(() => null))?.isDirectory() ?? false;

const rootCache = new Map<string, Promise<string>>();

/** The main checkout a directory belongs to (a worktree resolves to its repository), or the directory itself when it
 *  is not in a git repository. Cached for the life of the process: a directory does not change repositories. */
function projectRootOf(dir: string): Promise<string> {
  let hit = rootCache.get(dir);
  if (!hit) {
    hit = run("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 5_000 })
      .then(({ stdout }) => {
        const gitDir = stdout.trim();
        if (!gitDir) return dir;
        return basename(gitDir) === ".git" ? dirname(gitDir) : gitDir;
      })
      .catch(() => dir);
    rootCache.set(dir, hit);
  }
  return hit;
}

/** Which project a session directory belongs to. */
export async function projectKeyFor(cwd: string): Promise<string> {
  if (!cwd) return OTHER_PROJECT_KEY;
  if (await isDirectory(cwd)) return projectRootOf(cwd);
  const parent = stripWorktree(cwd);
  if (parent !== cwd && (await isDirectory(parent))) return projectRootOf(parent);
  return OTHER_PROJECT_KEY;
}

type Unplaced = Omit<SessionRow, "projectKey">;

async function readClaude(home: string, claudeBin: string, since: number, errors: string[]): Promise<Unplaced[]> {
  const root = desktopIndexRoot(home);
  if (!(await isDirectory(root))) return [];
  const live = new Map<string, { status: string; startedAt: number }>();
  try {
    for (const a of await listClaudeAgents(claudeBin)) live.set(a.sessionId, { status: a.status, startedAt: num(a.startedAt) });
  } catch (err) {
    errors.push(`claude agents：${err instanceof Error ? err.message : String(err)}（Claude 的会话不会显示为运行中）`);
  }
  const out: Unplaced[] = [];
  for (const org of await readdir(root).catch(() => [] as string[])) {
    for (const user of await readdir(join(root, org)).catch(() => [] as string[])) {
      const dir = join(root, org, user);
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(await readFile(join(dir, f), "utf8"));
        } catch {
          continue; // half-written by the app; the next read gets it
        }
        if (!isRecord(entry) || entry.isArchived === true) continue;
        const agent = live.get(str(entry.cliSessionId));
        // A session whose process is alive counts as active from when that process started, even when the index
        // has seen no turn since: an idle session reopened today is in today's window, not last week's.
        const at = Math.max(num(entry.lastActivityAt), agent?.startedAt ?? 0);
        if (at < since) continue;
        const id = str(entry.sessionId) || f.slice(0, -5);
        out.push({
          app: "claude",
          id,
          title: str(entry.title),
          at,
          cwd: str(entry.originCwd) || str(entry.cwd),
          open: { kind: "desktop", desktopSessionId: id },
          ...classifyClaude(entry, agent?.status),
        });
      }
    }
  }
  return out;
}

interface CodexThreadRow {
  id: string;
  title: string | null;
  name: string | null;
  cwd: string | null;
  at: number | null;
  unread: number;
}

async function readCodex(home: string, since: number, includeExec: boolean, now: number, errors: string[]): Promise<Unplaced[]> {
  const stateDb = join(home, ".codex", "state_5.sqlite");
  const historyDb = join(home, ".codex", "thread_history_1.sqlite");
  if (!(await stat(stateDb).catch(() => null))) return [];
  const recency = "COALESCE(NULLIF(t.recency_at_ms, 0), t.updated_at_ms, t.updated_at * 1000)";
  let threads: CodexThreadRow[];
  try {
    threads = await sqliteJson<CodexThreadRow>(
      stateDb,
      `SELECT t.id, t.title, t.name, t.cwd, ${recency} AS at, (r.first_unread_turn IS NOT NULL) AS unread
         FROM threads t LEFT JOIN thread_read_receipts r ON r.thread_id = t.id
        WHERE t.archived = 0 AND ${recency} >= ${Math.floor(since)}${includeExec ? "" : " AND t.source != 'exec'"}`,
    );
  } catch (err) {
    errors.push(`Codex 的线程库：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  if (!threads.length) return [];
  const ids = threads.map((t) => sqlQuote(t.id)).join(",");
  const turns = new Map<string, { status: string; error_json: string | null; ordinal: number | null }>();
  const lastItem = new Map<string, number>();
  try {
    // One after the other: two readers opening this database at the same moment can collide while Codex writes to it.
    const turnRows = await sqliteJson<{ thread_id: string; status: string; error_json: string | null; ordinal: number | null }>(
      historyDb,
      `SELECT thread_id, status, error_json, rollout_ordinal AS ordinal FROM thread_turns
        WHERE (thread_id, rollout_ordinal) IN (SELECT thread_id, MAX(rollout_ordinal) FROM thread_turns WHERE thread_id IN (${ids}) GROUP BY thread_id)`,
    );
    const itemRows = await sqliteJson<{ thread_id: string; at: number | null }>(historyDb, `SELECT thread_id, MAX(created_at_ms) AS at FROM thread_items WHERE thread_id IN (${ids}) GROUP BY thread_id`);
    for (const r of turnRows) turns.set(r.thread_id, r);
    for (const r of itemRows) lastItem.set(r.thread_id, num(r.at));
  } catch (err) {
    errors.push(`Codex 的历史库：${err instanceof Error ? err.message : String(err)}（Codex 的状态可能不准）`);
  }
  return threads.map((t) => {
    const at = num(t.at);
    const turn = turns.get(t.id);
    return {
      app: "codex" as const,
      id: t.id,
      title: (str(t.name) || str(t.title)).split("\n")[0] ?? "",
      at,
      cwd: str(t.cwd),
      open: { kind: "codex-app" as const, threadId: t.id },
      ...classifyCodex({ turnStatus: turn?.status ?? null, turnOrdinal: turn?.ordinal ?? null, errorJson: turn?.error_json ?? null, unread: Boolean(t.unread), lastActivityAt: Math.max(at, lastItem.get(t.id) ?? 0) }, now),
    };
  });
}

const zeroCounts = (): Record<SessionState, number> => ({ "needs-you": 0, error: 0, stuck: 0, review: 0, unread: 0, running: 0, interrupted: 0, expired: 0, done: 0 });

/** How many sessions in a group are held up on a person. */
export const attentionOf = (counts: Record<SessionState, number>): number => counts["needs-you"] + counts.error + counts.stuck;

const compareSessions = (a: SessionRow, b: SessionRow): number =>
  SESSION_STATE_ORDER.indexOf(a.state) - SESSION_STATE_ORDER.indexOf(b.state) || b.at - a.at;

/** Sorts sessions (what needs a person first, newest first within a state) and folds them into project groups
 *  (most held-up first, then most running, then most recent). */
export function groupByProject(rows: SessionRow[]): Pick<Overview, "projects" | "sessions"> {
  const sessions = [...rows].sort(compareSessions);
  const byKey = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    let g = byKey.get(s.projectKey);
    if (!g) {
      const other = s.projectKey === OTHER_PROJECT_KEY;
      g = { key: s.projectKey, name: other ? "其他" : basename(s.projectKey) || s.projectKey, dir: other ? null : s.projectKey, apps: [], sessions: 0, counts: zeroCounts(), lastAt: 0 };
      byKey.set(s.projectKey, g);
    }
    g.sessions += 1;
    g.counts[s.state] += 1;
    g.lastAt = Math.max(g.lastAt, s.at);
    if (!g.apps.includes(s.app)) g.apps.push(s.app);
  }
  const projects = [...byKey.values()].sort((a, b) => attentionOf(b.counts) - attentionOf(a.counts) || b.counts.running - a.counts.running || b.lastAt - a.lastAt);
  return { projects, sessions };
}

export interface OverviewOptions {
  home?: string;
  claudeBin?: string;
  /** How far back to look, in days. */
  days?: number;
  /** Also list Codex threads started by `codex exec`. They are never opened in the app, so they stay unread forever. */
  includeExec?: boolean;
  /** Also list sessions whose directory no longer exists (the "other" group): temporary checkouts of test runs,
   *  folders since deleted. There is nothing to go back to in them, so they are left out by default. */
  includeGone?: boolean;
  now?: number;
}

export async function buildOverview(opts: OverviewOptions = {}): Promise<Overview> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const since = now - (opts.days ?? 14) * 86_400_000;
  const errors: string[] = [];
  const [claude, codex] = await Promise.all([
    readClaude(home, opts.claudeBin ?? "claude", since, errors).catch((err) => {
      errors.push(`Claude 桌面端的会话索引：${err instanceof Error ? err.message : String(err)}`);
      return [] as Unplaced[];
    }),
    readCodex(home, since, opts.includeExec ?? false, now, errors),
  ]);
  const placed = await Promise.all([...claude, ...codex].map(async (s): Promise<SessionRow> => ({ ...s, projectKey: await projectKeyFor(s.cwd) })));
  const rows = opts.includeGone ? placed : placed.filter((s) => s.projectKey !== OTHER_PROJECT_KEY);
  return { ...groupByProject(rows), readAt: now, errors };
}
