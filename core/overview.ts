// The session overview: every Claude Desktop and Codex session on this machine, each with one state, grouped by
// project. Read-only: it looks at the two apps' own local state and writes nothing.
//
// Sources (none is a public format, so every read is defensive and a source that cannot be read lands in `errors`
// instead of taking the overview down):
//   Claude  ~/Library/Application Support/Claude/claude-code-sessions/<org>/<user>/local_*.json   desktop index
//             postTurnSummary (how the last turn ended), lastFocusedAt (seen), spawnedFrom (parent session)
//           `claude agents --json`                                                               live busy / waiting / idle
//   Codex   ~/.codex/state_5.sqlite           threads, thread_read_receipts (seen), thread_spawn_edges (parent)
//           ~/.codex/thread_history_1.sqlite  thread_turns (how the last turn ended), thread_items (activity)
//
// A state is decided in two steps, so that every source feeds the same small set of questions (`SessionFacts`) and
// one table (`decide`) turns the answers into a state. The questions are the four things the two apps actually
// record, each on its own axis: what the process is doing, how the last turn ended, whether the person has looked
// since, and whether sub-sessions it started are still at work. A new kind of situation is a new row in the table,
// never a new branch in a reader.
//
// Known gap: Codex keeps "waiting on an approval / on input" only in its app-server's memory, not in the databases,
// so a Codex thread held on an approval reads as whatever its last turn said.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { desktopIndexRoot, type SessionOpen } from "./claude/desktopIndex.js";
import { listClaudeAgents, type ClaudeAgent } from "./claude/sessions.js";
import { run } from "./util/run.js";
import { sqliteJson, sqlQuote } from "./util/sqlite.js";
import { t as say, type Lang } from "./i18n/index.js";

export type SessionApp = "claude" | "codex";

export type SessionState =
  | "needs-you" // stopped on something only a person can settle
  | "error" // the last turn failed (quota, overload, …)
  | "stuck" // still marked running but nothing has moved for a long time
  | "running"
  | "delegated" // idle itself, with sub-sessions it started still at work; it moves again when they report
  | "review" // finished with something to look at (a PR, a result awaiting CI)
  | "unread" // finished, and the app says it has not been opened since
  | "interrupted"
  | "expired" // finished and left unopened for so long that nobody is going to look at it
  | "done";

/** Sort order: what needs a person first, then what is still moving, then what is merely waiting to be looked at,
 *  then the rest. Running comes before the waiting-to-be-looked-at states on purpose: a Codex thread stays "unread"
 *  until it is opened in the Codex app, so a dozen of them from days ago would otherwise bury the session that
 *  started a minute ago. */
export const SESSION_STATE_ORDER: SessionState[] = ["needs-you", "error", "stuck", "running", "delegated", "review", "unread", "interrupted", "expired", "done"];

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
  /** The session this one was started from (`app:id`), when its app records that. */
  parent: string | null;
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

// ---------------------------------------------------------------------------------------------------------------
// The four axes, and the table that turns them into a state.

/** Axis 1: what the session's process is doing right now. */
export type ProcessFact =
  | "running" // a turn is going
  | "stalled" // marked as going, but silent for longer than any step should take
  | "waiting" // alive and stopped on the person: a permission prompt, a question in a dialog, a sandbox request
  | "idle"; // no turn going, or no process at all

/** Axis 2: how the last turn ended. */
export type OutcomeFact =
  | "asked" // on a question, or anything else only a person can settle
  | "failed" // with an error (quota, overload, a crash)
  | "interrupted" // stopped by the person before it was done
  | "review" // done, with something to look at (a PR, a result awaiting CI)
  | "completed" // done
  | "unknown"; // no record of how it ended

export const PROCESS_FACTS: readonly ProcessFact[] = ["running", "stalled", "waiting", "idle"];
export const OUTCOME_FACTS: readonly OutcomeFact[] = ["asked", "failed", "interrupted", "review", "completed", "unknown"];

/** What a source could say about a session, on the four axes. Every reader fills one of these; `decide` reads it. */
export interface SessionFacts {
  process: ProcessFact;
  /** With process "waiting": what it is held on, already in the person's language. */
  waitingOn: string;
  outcome: OutcomeFact;
  /** The last turn's own line: what it needs, where it stands, or the error. */
  outcomeDetail: string;
  /** Axis 3: the person has looked at the session since the last turn ended. True when the source cannot tell. */
  seen: boolean;
  /** Axis 4: sub-sessions this one started that are still at work, by title. Empty when there are none. */
  childrenRunning: string[];
  /** Since the last activity, ms. Decides when a stalled turn is announced as such and when "unread" gives up. */
  idleMs: number;
  /** Which field decided the outcome (or the process, when that is what decides); the tooltip's text. */
  basis: string;
  /** The turn the outcome describes (see SessionVerdict.turn); empty when nothing has settled. */
  turn: string;
  /** The app's word for "not seen" in `basis`: Claude has only a focus stamp ("unopened"), Codex a read receipt. */
  unseenBasis: string;
}

const delegatedDetail = (titles: string[], lang: Lang): string => {
  const named = titles.filter(Boolean);
  if (!named.length) return say(lang, "overview.delegatedDetail", { n: titles.length });
  const shown = named.slice(0, 3).join(lang === "zh" ? "、" : ", ") + (named.length > 3 ? "…" : "");
  return say(lang, "overview.delegatedDetailTitled", { n: titles.length, titles: shown });
};

/**
 * The table. Rows are tried in order and the first that applies decides; the order is the priority between the
 * axes:
 *
 *   1. a live process outranks whatever the last turn said (running, stalled, waiting on the person);
 *   2. a failed turn is the session's own problem, children or not;
 *   3. sub-sessions still at work mean the session is waiting on them, whatever it said when it stopped;
 *   4. then the turn's own outcome: asked, review, interrupted;
 *   5. a finished turn the person has not looked at is unread, until that has gone on so long it is expired;
 *   6. else done.
 *
 * `overview.test.ts` walks every combination of the axes through this and keeps the resulting table as a snapshot,
 * so a change here shows as a diff of that table.
 */
export function decide(f: SessionFacts, lang: Lang = "zh"): SessionVerdict {
  if (f.process === "running") return { state: "running", detail: "", basis: f.basis, turn: "" };
  if (f.process === "stalled") return { state: "stuck", detail: say(lang, "overview.stuckDetail", { n: Math.round(f.idleMs / 60_000) }), basis: f.basis, turn: f.turn };
  if (f.process === "waiting") return { state: "needs-you", detail: f.waitingOn, basis: f.basis, turn: f.turn };
  if (f.outcome === "failed") return { state: "error", detail: f.outcomeDetail, basis: f.basis, turn: f.turn };
  if (f.childrenRunning.length) return { state: "delegated", detail: delegatedDetail(f.childrenRunning, lang), basis: `${f.basis} + sub-sessions at work`, turn: f.turn };
  if (f.outcome === "asked") return { state: "needs-you", detail: f.outcomeDetail, basis: f.basis, turn: f.turn };
  if (f.outcome === "review") return { state: "review", detail: f.outcomeDetail, basis: f.basis, turn: f.turn };
  if (f.outcome === "interrupted") return { state: "interrupted", detail: f.outcomeDetail, basis: f.basis, turn: f.turn };
  if (!f.seen) {
    if (f.idleMs > UNREAD_EXPIRE_MS) return { state: "expired", detail: say(lang, "overview.expiredDetail", { n: Math.floor(f.idleMs / 86_400_000) }), basis: `${f.basis} + ${f.unseenBasis}, expired`, turn: f.turn };
    return { state: "unread", detail: f.outcomeDetail, basis: `${f.basis} + ${f.unseenBasis}`, turn: f.turn };
  }
  return { state: "done", detail: f.outcomeDetail, basis: f.basis, turn: f.turn };
}

/** Which states of a sub-session mean its parent is still waiting on it. A failed child is a problem of its own,
 *  shown on its own row; the parent then shows what it last said. */
const CHILD_AT_WORK: ReadonlySet<SessionState> = new Set<SessionState>(["running", "stuck", "needs-you", "delegated"]);

const familyKey = (s: { app: SessionApp; id: string }): string => `${s.app}:${s.id}`;

/** A row as a reader hands it over: everything but the verdict, plus the facts the verdict is made from. */
export interface PreparedRow extends Omit<SessionRow, keyof SessionVerdict | "projectKey"> {
  facts: SessionFacts;
}

/**
 * Decides every row, sub-sessions before the sessions that started them: a parent's fourth axis is which of its
 * children are still at work, and a child that is itself waiting on grandchildren counts as at work. A parent
 * outside the list (archived, out of the window) simply has no effect; links that form a loop are dropped.
 */
export function decideAll(rows: PreparedRow[], lang: Lang = "zh"): Array<Omit<SessionRow, "projectKey">> {
  const byKey = new Map(rows.map((r) => [familyKey(r), r]));
  const parentOf = new Map<string, string>();
  for (const r of rows) if (r.parent && byKey.has(r.parent)) parentOf.set(familyKey(r), r.parent);
  // A link that leads back to where it started is bogus; every link on such a loop is dropped, so the rows on it
  // speak for themselves.
  const onLoop = (key: string): boolean => {
    let k = parentOf.get(key);
    for (let steps = 0; k && steps <= rows.length; steps++) {
      if (k === key) return true;
      k = parentOf.get(k);
    }
    return false;
  };
  const children = new Map<string, PreparedRow[]>();
  for (const r of rows) {
    const key = familyKey(r);
    const parent = parentOf.get(key);
    if (parent && !onLoop(key)) children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const verdicts = new Map<string, SessionVerdict>();
  const verdictOf = (r: PreparedRow): SessionVerdict => {
    const key = familyKey(r);
    const known = verdicts.get(key);
    if (known) return known;
    const childrenRunning = [...r.facts.childrenRunning, ...(children.get(key) ?? []).filter((c) => CHILD_AT_WORK.has(verdictOf(c).state)).map((c) => c.title)];
    const v = decide({ ...r.facts, childrenRunning }, lang);
    verdicts.set(key, v);
    return v;
  };
  return rows.map((r) => ({ app: r.app, id: r.id, title: r.title, at: r.at, cwd: r.cwd, open: r.open, parent: r.parent, ...verdictOf(r) }));
}

// ---------------------------------------------------------------------------------------------------------------
// Claude: one Desktop index entry plus what `claude agents` says about its process.

/**
 * The index carries a model-written summary of the last turn (`postTurnSummary`): a category (`completed`,
 * `review_ready`, `blocked`), a line about where things stand, and, when blocked, what the person has to do. Claude
 * Desktop clears it when a new turn starts, and `postTurnSummaryFor` names the reply it describes, so a summary that
 * does not match the last reply is ignored.
 */
export interface ClaudeClassifyContext {
  now?: number;
  /** The session is the one in front in Claude Desktop right now: whatever lands in it is being seen. */
  watched?: boolean;
  /** The language `detail` is written in. Chinese, the language these strings were first written in, unless said. */
  lang?: Lang;
  /** Sub-sessions started from this one that are still at work, by title (normally filled in by `decideAll`). */
  childrenRunning?: string[];
}

/** `claude agents` names what a waiting process is held on in a few fixed phrases; the person's language for each. */
function waitingOn(waitingFor: string, lang: Lang): string {
  const w = waitingFor.toLowerCase();
  if (w.includes("permission")) return say(lang, "overview.waitingFor.permission");
  if (w.includes("sandbox")) return say(lang, "overview.waitingFor.sandbox");
  if (w.includes("worker")) return say(lang, "overview.waitingFor.worker");
  if (w.includes("dialog")) return say(lang, "overview.waitingFor.dialog");
  if (w.includes("input") || !w) return say(lang, "overview.waitingFor.input");
  return say(lang, "overview.waitingFor.other", { what: waitingFor });
}

export function claudeFacts(entry: Record<string, unknown>, agent: Pick<ClaudeAgent, "status" | "waitingFor"> | undefined, ctx: ClaudeClassifyContext = {}): SessionFacts {
  const now = ctx.now ?? Date.now();
  const lang = ctx.lang ?? "zh";
  const activity = num(entry.lastActivityAt);
  const focused = num(entry.lastFocusedAt);
  const facts: SessionFacts = {
    process: "idle",
    waitingOn: "",
    outcome: "unknown",
    outcomeDetail: "",
    // Claude Desktop stamps `lastFocusedAt` when a session is brought up, not while it stays up, so a reply that
    // landed after that stamp has not been seen, unless the session is the one in front right now. Codex keeps a
    // read receipt instead; this is the nearest Claude's index gets to one.
    seen: !(focused && activity > focused && !ctx.watched),
    childrenRunning: ctx.childrenRunning ?? [],
    idleMs: Math.max(0, now - activity),
    basis: "no summary",
    turn: "",
    unseenBasis: "unopened",
  };
  if (agent?.status === "busy") return { ...facts, process: "running", basis: "claude agents: busy" };
  if (agent?.status === "waiting") {
    const what = str(agent.waitingFor);
    return { ...facts, process: "waiting", waitingOn: waitingOn(what, lang), basis: `claude agents: waiting${what ? ` (${what})` : ""}`, turn: `waiting:${activity}` };
  }
  // An error is current only if nothing was sent after it.
  if (str(entry.error) && num(entry.errorAt) >= num(entry.latestUserFrameAt)) return { ...facts, outcome: "failed", outcomeDetail: str(entry.error), basis: "index.error", turn: `error:${num(entry.errorAt)}` };
  const summary = isRecord(entry.postTurnSummary) ? entry.postTurnSummary : null;
  if (!summary) return facts;
  if (entry.postTurnSummaryFor !== entry.lastAssistantUuid) return { ...facts, basis: "summary is for an earlier reply" };
  const category = str(summary.status_category);
  const needs = str(summary.needs_action);
  const status = str(summary.status_detail);
  const settled = { ...facts, basis: `postTurnSummary.${category || "?"}`, turn: str(entry.lastAssistantUuid), outcomeDetail: status };
  if (category === "blocked" || needs) return { ...settled, outcome: "asked", outcomeDetail: needs || status };
  if (category === "review_ready") return { ...settled, outcome: "review" };
  return { ...settled, outcome: "completed" };
}

export function classifyClaude(entry: Record<string, unknown>, liveStatus: string | undefined, ctx: ClaudeClassifyContext = {}): SessionVerdict {
  return decide(claudeFacts(entry, liveStatus === undefined ? undefined : { status: liveStatus }, ctx), ctx.lang ?? "zh");
}

// ---------------------------------------------------------------------------------------------------------------
// Codex: the newest turn of a thread, its read receipt, and the thread's last activity.

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
 * "blocked on a question" in its databases: a finished turn that asked something and one that simply finished
 * look the same, so the most this can say is "finished and not opened since".
 */
export function codexFacts(t: CodexThreadFacts, now: number): SessionFacts {
  const idleMs = Math.max(0, now - t.lastActivityAt);
  const facts: SessionFacts = {
    process: "idle",
    waitingOn: "",
    outcome: "unknown",
    outcomeDetail: "",
    seen: !t.unread,
    childrenRunning: [],
    idleMs,
    basis: t.turnStatus ? `thread_turns.${t.turnStatus}` : "no turn",
    turn: t.turnOrdinal === null ? "" : String(t.turnOrdinal),
    unseenBasis: "unread",
  };
  switch (t.turnStatus) {
    case "inProgress":
      return { ...facts, process: idleMs > CODEX_STALE_MS ? "stalled" : "running" };
    case "failed":
      return { ...facts, outcome: "failed", outcomeDetail: codexErrorMessage(t.errorJson) };
    case "interrupted":
      return { ...facts, outcome: "interrupted" };
    case "completed":
      return { ...facts, outcome: "completed" };
    default:
      return facts;
  }
}

export function classifyCodex(t: CodexThreadFacts, now: number, lang: Lang = "zh"): SessionVerdict {
  return decide(codexFacts(t, now), lang);
}

// ---------------------------------------------------------------------------------------------------------------
// Projects.

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

// ---------------------------------------------------------------------------------------------------------------
// Readers.

async function readClaude(home: string, claudeBin: string, since: number, now: number, claudeInFront: boolean, lang: Lang, errors: string[]): Promise<PreparedRow[]> {
  const root = desktopIndexRoot(home);
  if (!(await isDirectory(root))) return [];
  const live = new Map<string, ClaudeAgent>();
  try {
    for (const a of await listClaudeAgents(claudeBin)) live.set(a.sessionId, a);
  } catch (err) {
    errors.push(say(lang, "overview.err.claudeAgents", { error: err instanceof Error ? err.message : String(err) }));
  }
  const found: Array<{ entry: Record<string, unknown>; agent: ClaudeAgent | undefined; id: string; at: number }> = [];
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
        const at = Math.max(num(entry.lastActivityAt), num(agent?.startedAt));
        if (at < since) continue;
        found.push({ entry, agent, id: str(entry.sessionId) || f.slice(0, -5), at });
      }
    }
  }
  // While Claude Desktop is the app in front, the session it brought up last is the one on screen.
  const watched = claudeInFront ? found.reduce<(typeof found)[number] | null>((best, f) => (num(f.entry.lastFocusedAt) > num(best?.entry.lastFocusedAt) ? f : best), null) : null;
  return found.map(({ entry, agent, id, at }) => {
    // A side session the desktop app started from another one records that one as `spawnedFrom`.
    const spawnedFrom = isRecord(entry.spawnedFrom) ? str(entry.spawnedFrom.sessionId) : "";
    return {
      app: "claude" as const,
      id,
      title: str(entry.title),
      at,
      cwd: str(entry.originCwd) || str(entry.cwd),
      open: { kind: "desktop" as const, desktopSessionId: id },
      parent: spawnedFrom ? `claude:${spawnedFrom}` : null,
      facts: claudeFacts(entry, agent, { now, watched: watched?.id === id, lang }),
    };
  });
}

interface CodexThreadRow {
  id: string;
  title: string | null;
  name: string | null;
  cwd: string | null;
  at: number | null;
  unread: number;
}

async function readCodex(home: string, since: number, includeExec: boolean, now: number, lang: Lang, errors: string[]): Promise<PreparedRow[]> {
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
    errors.push(say(lang, "overview.err.codexThreads", { error: err instanceof Error ? err.message : String(err) }));
    return [];
  }
  if (!threads.length) return [];
  const ids = threads.map((t) => sqlQuote(t.id)).join(",");
  // Which listed thread was started by which other one (a subagent's thread by its parent). The table arrived with
  // a 2026 Codex; an older database without it just has no families.
  const parentOf = new Map<string, string>();
  try {
    for (const e of await sqliteJson<{ parent_thread_id: string; child_thread_id: string }>(stateDb, `SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges WHERE child_thread_id IN (${ids})`)) parentOf.set(e.child_thread_id, e.parent_thread_id);
  } catch {
    // no spawn edges in this database
  }
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
    errors.push(say(lang, "overview.err.codexHistory", { error: err instanceof Error ? err.message : String(err) }));
  }
  return threads.map((t) => {
    const at = num(t.at);
    const turn = turns.get(t.id);
    const parent = parentOf.get(t.id);
    return {
      app: "codex" as const,
      id: t.id,
      title: (str(t.name) || str(t.title)).split("\n")[0] ?? "",
      at,
      cwd: str(t.cwd),
      open: { kind: "codex-app" as const, threadId: t.id },
      parent: parent ? `codex:${parent}` : null,
      facts: codexFacts({ turnStatus: turn?.status ?? null, turnOrdinal: turn?.ordinal ?? null, errorJson: turn?.error_json ?? null, unread: Boolean(t.unread), lastActivityAt: Math.max(at, lastItem.get(t.id) ?? 0) }, now),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Grouping.

const zeroCounts = (): Record<SessionState, number> => ({ "needs-you": 0, error: 0, stuck: 0, running: 0, delegated: 0, review: 0, unread: 0, interrupted: 0, expired: 0, done: 0 });

/** How many sessions in a group are held up on a person. */
export const attentionOf = (counts: Record<SessionState, number>): number => counts["needs-you"] + counts.error + counts.stuck;

const compareSessions = (a: SessionRow, b: SessionRow): number =>
  SESSION_STATE_ORDER.indexOf(a.state) - SESSION_STATE_ORDER.indexOf(b.state) || b.at - a.at;

/** Sorts sessions (what needs a person first, newest first within a state) and folds them into project groups
 *  (most held-up first, then most running, then most recent). */
export function groupByProject(rows: SessionRow[], lang: Lang = "zh"): Pick<Overview, "projects" | "sessions"> {
  const sessions = [...rows].sort(compareSessions);
  const byKey = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    let g = byKey.get(s.projectKey);
    if (!g) {
      const other = s.projectKey === OTHER_PROJECT_KEY;
      g = { key: s.projectKey, name: other ? say(lang, "common.other") : basename(s.projectKey) || s.projectKey, dir: other ? null : s.projectKey, apps: [], sessions: 0, counts: zeroCounts(), lastAt: 0 };
      byKey.set(s.projectKey, g);
    }
    g.sessions += 1;
    g.counts[s.state] += 1;
    g.lastAt = Math.max(g.lastAt, s.at);
    if (!g.apps.includes(s.app)) g.apps.push(s.app);
  }
  const projects = [...byKey.values()].sort((a, b) => attentionOf(b.counts) - attentionOf(a.counts) || b.counts.running + b.counts.delegated - (a.counts.running + a.counts.delegated) || b.lastAt - a.lastAt);
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
  /** Claude Desktop is the app in front: the session it shows is being watched, so a reply landing there is seen,
   *  not "finished and unopened". */
  claudeInFront?: boolean;
  /** The language of `detail`, the catch-all group's name and the errors. Chinese unless said. */
  lang?: Lang;
}

export async function buildOverview(opts: OverviewOptions = {}): Promise<Overview> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const lang = opts.lang ?? "zh";
  const since = now - (opts.days ?? 14) * 86_400_000;
  const errors: string[] = [];
  const [claude, codex] = await Promise.all([
    readClaude(home, opts.claudeBin ?? "claude", since, now, opts.claudeInFront ?? false, lang, errors).catch((err) => {
      errors.push(say(lang, "overview.err.claudeIndex", { error: err instanceof Error ? err.message : String(err) }));
      return [] as PreparedRow[];
    }),
    readCodex(home, since, opts.includeExec ?? false, now, lang, errors),
  ]);
  // Families are resolved over both apps' rows before anything is left out, so a parent whose child is in a
  // directory that no longer exists still knows about it.
  const decided = decideAll([...claude, ...codex], lang);
  const placed = await Promise.all(decided.map(async (s): Promise<SessionRow> => ({ ...s, projectKey: await projectKeyFor(s.cwd) })));
  const rows = opts.includeGone ? placed : placed.filter((s) => s.projectKey !== OTHER_PROJECT_KEY);
  return { ...groupByProject(rows, lang), readAt: now, errors };
}
