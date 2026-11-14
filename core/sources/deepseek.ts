// DeepSeek Harness's (dsh) sessions, from what its host keeps under ~/.dsh. The desktop app and the `dsh` command
// write the same files.
//
//   ~/.dsh/storages/workspace.json                        { global: { archivedSessionIds } }
//   ~/.dsh/storages/session_projcache/sessions/<id>.json  { record: { identity: { cwd }, rows: { <key>: { val } } } }
//       title, workingDirectory, sessionListMetadata { blank }, turnBoundary { openTurnStartSeq },
//       turnOutline { turns: [{ prompt }] }, userQuestions { questions: { active: [{ questions: [{ question }] }] } }
//   ~/.dsh/sessions/<folder>/<id>/session.v4.jsonl.zstd    the event log, one zstd frame per append
//       first line: { type: "session", id, cwd, parentSession? }
//       then:       { type, seq, time, data }
//         turn/start · turn/end { reason: { kind: completed | error | aborted | interrupted | …, error: { message } } }
//         approval/asked { id, toolName, reason } · approval/decided { id }
//         tool/call { callId, name, arguments } · tool/result { message: { toolCallId } }
//
// Read out of DeepSeek Harness 0.2.1 (2026-11): the files of sessions that were on this machine, and the tool's
// own code (it is open source) for what the fields mean. The cache file is the host's checkpoint of a session; it
// is rewritten when a turn ends and now and then during one, so it gives the title and the folder, and the log
// gives the state: how the last turn ended is only there. Seen on real data: turns that completed, failed and
// were stopped, and a permission request that was asked and answered. Read from the code and not seen: a turn in
// progress, a question put to the person (the `ask_user_question` tool), a sub-session's `parentSession`.
//
// A host that dies leaves the turn open in the log until the session is next loaded, so an open turn only means
// running while some host process is alive, and, since nothing says which session a host is busy with, only while
// the log is still being written. Nothing on disk says whether a session has been looked at. The app's `dsh://`
// scheme only brings its window up, so that is all the jump does.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Lang } from "../i18n/index.js";
import type { PreparedRow, ReadContext, SessionFacts, SessionSource } from "../overview.js";
import { t as say } from "../i18n/index.js";
import { run } from "../util/run.js";
import { firstLine, jsonLines, readBytes } from "../util/transcript.js";
import { zstdFramesText } from "../util/zstd.js";

export const dshCacheDir = (home: string): string => join(home, ".dsh", "storages", "session_projcache", "sessions");
export const dshWorkspaceFile = (home: string): string => join(home, ".dsh", "storages", "workspace.json");
export const dshSessionsDir = (home: string): string => join(home, ".dsh", "sessions");
export const DSH_LOG = "session.v4.jsonl.zstd";

/** A turn still open with nothing written for this long is taken as cut off rather than running. */
export const DSH_STALE_MS = 30 * 60_000;
/** How much of the end of a log is read. A turn's ending is its last few events; a request waiting on the person is
 *  never far behind the end either. */
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 16 * 1024;

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const rec = (v: unknown): Rec => (isRecord(v) ? v : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What the end of a session's log says. */
export interface DshTail {
  /** Whether the last turn boundary in the slice opened a turn or closed one; null when the slice has neither. */
  turn: "open" | "closed" | null;
  /** How the turn closed: the log's own word, and the error's message when it was one. */
  endKind: string;
  endError: string;
  /** A permission request that has been asked and not answered: what it is for. */
  approval: string | null;
  /** A question put to the person that has no answer yet: its text. */
  question: string | null;
  /** The slice has a turn's own events (a step, a tool call), so with no boundary in it a turn is in progress. */
  working: boolean;
}

const questionOf = (args: string): string => {
  try {
    const first: unknown = (rec(JSON.parse(args)).questions as unknown[] | undefined)?.[0];
    return str(rec(first).question);
  } catch {
    return "";
  }
};

export function dshTail(events: Rec[]): DshTail {
  let turn: DshTail["turn"] = null;
  let endKind = "";
  let endError = "";
  let working = false;
  const approvals = new Map<string, string>();
  const questions = new Map<string, string>();
  for (const e of events) {
    const data = rec(e.data);
    switch (e.type) {
      case "turn/start":
        turn = "open";
        endKind = endError = "";
        approvals.clear();
        questions.clear();
        break;
      case "turn/end": {
        const reason = rec(data.reason);
        turn = "closed";
        endKind = str(reason.kind);
        endError = str(rec(reason.error).message);
        approvals.clear();
        questions.clear();
        break;
      }
      case "approval/asked":
        approvals.set(str(data.id), str(data.reason) || str(data.toolName));
        break;
      case "approval/decided":
        approvals.delete(str(data.id));
        break;
      case "tool/call":
        working = true;
        if (data.name === "ask_user_question") questions.set(str(data.callId), questionOf(str(data.arguments)));
        break;
      case "tool/result":
        questions.delete(str(rec(data.message).toolCallId));
        break;
      case "step/start":
      case "step/end":
        working = true;
        break;
      default:
        break;
    }
  }
  const last = <T>(m: Map<string, T>): T | null => (m.size ? ([...m.values()].at(-1) ?? null) : null);
  return { turn, endKind, endError, approval: last(approvals), question: last(questions), working };
}

/** One session, reduced to what decides a state. */
export interface DshSession {
  /** A turn is open: the log's last boundary says so, or, where the slice has none, the host's checkpoint does. */
  open: boolean;
  endKind: string;
  endError: string;
  approval: string | null;
  question: string | null;
  /** A question the host still lists as waiting for an answer after its turn was over. */
  asked: string | null;
  at: number;
}

export function dshFacts(s: DshSession, now: number, hostAlive: boolean, lang: Lang = "zh"): SessionFacts {
  const idleMs = Math.max(0, now - s.at);
  const turn = String(s.at);
  const base = { waitingOn: "", outcomeDetail: "", seen: true, childrenRunning: [], idleMs, unseenBasis: "" };
  if (s.open) {
    if (!hostAlive) return { ...base, process: "idle", outcome: "interrupted", basis: "turn open, no dsh host running", turn };
    if (s.approval !== null) return { ...base, process: "waiting", waitingOn: say(lang, "overview.waitingFor.permission"), outcome: "unknown", basis: "approval/asked, not decided", turn };
    if (s.question !== null) return { ...base, process: "waiting", waitingOn: firstLine(s.question) || say(lang, "overview.waitingFor.input"), outcome: "unknown", basis: "ask_user_question, no answer", turn };
    if (idleMs > DSH_STALE_MS) return { ...base, process: "idle", outcome: "interrupted", basis: "turn open, nothing written since", turn };
    return { ...base, process: "running", outcome: "unknown", basis: "turn/start, no turn/end", turn: "" };
  }
  if (s.endKind === "error") return { ...base, process: "idle", outcome: "failed", outcomeDetail: firstLine(s.endError), basis: "turn/end: error", turn };
  if (s.endKind === "completed") {
    if (s.asked !== null) return { ...base, process: "idle", outcome: "asked", outcomeDetail: firstLine(s.asked), basis: "turn/end: completed, userQuestions.active", turn };
    return { ...base, process: "idle", outcome: "completed", basis: "turn/end: completed", turn };
  }
  // "forked" closes a turn that was open in the session this one was copied from: it is not this session's ending.
  if (!s.endKind || s.endKind === "forked") return { ...base, process: "idle", outcome: "unknown", basis: s.endKind ? "turn/end: forked" : "turn closed, ending not read", turn: "" };
  return { ...base, process: "idle", outcome: "interrupted", basis: `turn/end: ${s.endKind}`, turn };
}

async function dshIsRunning(): Promise<boolean> {
  try {
    await run("pgrep", ["-f", "DeepSeek Harness\\.app/Contents/MacOS/|/@deepseek-ai/dsh/|/bin/dsh( |$)"], { timeoutMs: 3_000 });
    return true;
  } catch {
    return false;
  }
}

export interface DshReadOptions {
  /** Whether a dsh host is alive; asked of the system when not given (tests give it). */
  running?: () => Promise<boolean>;
  /** How much of the end of a log to read (tests make it small). */
  tailBytes?: number;
}

// A log is read again only when it has changed; its first line never changes.
const tails = new Map<string, { stamp: string; tail: DshTail }>();
const parents = new Map<string, string>();
const MEMO_MAX = 2_000;

async function tailOf(path: string, size: number, mtimeMs: number, tailBytes: number): Promise<DshTail> {
  const stamp = `${size}:${mtimeMs}:${tailBytes}`;
  const known = tails.get(path);
  if (known?.stamp === stamp) return known.tail;
  const start = Math.max(0, size - tailBytes);
  const tail = dshTail(jsonLines(zstdFramesText(await readBytes(path, start, size - start), start === 0)));
  if (tails.size >= MEMO_MAX) tails.clear();
  tails.set(path, { stamp, tail });
  return tail;
}

async function parentOf(path: string): Promise<string> {
  const known = parents.get(path);
  if (known !== undefined) return known;
  const header = jsonLines(zstdFramesText(await readBytes(path, 0, HEAD_BYTES), true)).find((e) => e.type === "session");
  // No header read (a frame longer than the slice): asked again next time rather than remembered as "no parent".
  if (!header) return "";
  const parent = str(header.parentSession);
  if (parents.size >= MEMO_MAX) parents.clear();
  parents.set(path, parent);
  return parent;
}

/** Where each session's log is: the folders under `sessions` are named after the working directory by a rule of the
 *  host's own, so they are listed rather than computed. */
async function logIndex(home: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const root = dshSessionsDir(home);
  for (const folder of await readdir(root).catch(() => [] as string[])) {
    for (const id of await readdir(join(root, folder)).catch(() => [] as string[])) index.set(id, join(root, folder, id, DSH_LOG));
  }
  return index;
}

async function archivedIds(home: string): Promise<Set<string>> {
  try {
    const ids: unknown = rec(rec(JSON.parse(await readFile(dshWorkspaceFile(home), "utf8"))).global).archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export async function readDeepseek(ctx: ReadContext, opts: DshReadOptions = {}): Promise<PreparedRow[]> {
  const dir = dshCacheDir(ctx.home);
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  if (!files.length) return [];
  const [archived, logs] = await Promise.all([archivedIds(ctx.home), logIndex(ctx.home)]);
  const found: Array<{ id: string; title: string; cwd: string; parent: string; session: DshSession }> = [];
  for (const file of files) {
    const id = file.slice(0, -".json".length);
    if (archived.has(id)) continue;
    const path = join(dir, file);
    try {
      const cacheStat = await stat(path);
      const logPath = logs.get(id);
      const logStat = logPath ? await stat(logPath).catch(() => null) : null;
      const at = Math.max(cacheStat.mtimeMs, logStat?.mtimeMs ?? 0);
      if (at < ctx.since) continue;
      const record = rec(rec(JSON.parse(await readFile(path, "utf8"))).record);
      const rows = rec(record.rows);
      const val = (key: string): unknown => rec(rows[key]).val;
      // A session that was opened and never written to.
      if (rec(val("sessionListMetadata")).blank === true) continue;
      const tail = logPath && logStat ? await tailOf(logPath, logStat.size, logStat.mtimeMs, opts.tailBytes ?? TAIL_BYTES) : null;
      const checkpointOpen = typeof rec(val("turnBoundary")).openTurnStartSeq === "number";
      const active: unknown = (rec(rec(val("userQuestions")).questions).active as unknown[] | undefined)?.[0];
      const asked: unknown = (rec(active).questions as unknown[] | undefined)?.[0];
      const prompts = rec(val("turnOutline")).turns;
      found.push({
        id,
        title: firstLine(str(val("title")) || str(rec(Array.isArray(prompts) ? prompts[0] : null).prompt)),
        cwd: str(val("workingDirectory")) || str(rec(record.identity).cwd),
        parent: logPath && logStat ? await parentOf(logPath) : "",
        session: {
          open: tail?.turn ? tail.turn === "open" : checkpointOpen || Boolean(tail?.working),
          endKind: tail?.turn === "closed" ? tail.endKind : "",
          endError: tail?.endError ?? "",
          approval: tail?.approval ?? null,
          question: tail?.question ?? null,
          asked: isRecord(active) ? str(rec(asked).question) : null,
          at: Math.floor(at),
        },
      });
    } catch (err) {
      ctx.errors.push(say(ctx.lang, "overview.err.source", { app: "DeepSeek Harness", error: `${file}: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }
  const alive = found.some((f) => f.session.open) ? await (opts.running ?? dshIsRunning)() : false;
  return found.map((f) => ({
    app: "deepseek" as const,
    id: f.id,
    title: f.title,
    at: f.session.at,
    cwd: f.cwd,
    open: { kind: "app" as const, app: "deepseek" as const },
    // A sub-agent's session names the session that started it.
    parent: f.parent ? `deepseek:${f.parent}` : null,
    facts: dshFacts(f.session, ctx.now, alive, ctx.lang),
  }));
}

export const deepseekSource: SessionSource = {
  app: "deepseek",
  present: async (home) => Boolean(await stat(dshCacheDir(home)).catch(() => null)),
  read: (ctx) => readDeepseek(ctx),
};
