// OpenCode's sessions, from the database the tool keeps.
//
//   ~/.local/share/opencode/opencode.db
//     session(id, parent_id, directory, title, time_updated, time_archived, …)
//     message(session_id, time_created, data)   data: { role, time: { created, completed }, finish, error: { name, data } }
//
// Read out of OpenCode 1.19 (2026-11), against sessions run for the purpose; not a documented format. What was
// seen: a reply being written is an assistant message with no `time.completed`; a finished turn ends on one with
// `finish: "stop"`; one with `finish: "tool-calls"` is a step of a turn that goes on. A run that is killed leaves
// its message exactly as it was while running, so "still being written" only means running while an opencode
// process is alive. Not seen, and so not read: a turn held on a permission prompt. A message's `error` is read by
// its name (an abort is the person's doing, anything else a failure), which is how the tool's own code names them
// but was not seen on real data. A session is taken up again with `opencode --session <id>` in its directory.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedRow, ReadContext, SessionFacts, SessionSource } from "../overview.js";
import { t as say } from "../i18n/index.js";
import { run } from "../util/run.js";
import { sqliteJson } from "../util/sqlite.js";

export const opencodeDb = (home: string): string => join(home, ".local", "share", "opencode", "opencode.db");

/** A turn still open with nothing written for this long is taken as cut off rather than running. */
export const OPENCODE_STALE_MS = 30 * 60_000;

/** The newest message of a session, reduced to what decides a state. */
export interface OpencodeLast {
  role: string;
  completed: number | null;
  finish: string | null;
  error: string | null;
  errorMessage: string | null;
}

export function opencodeFacts(last: OpencodeLast | null, updatedAt: number, now: number, processAlive: boolean): SessionFacts {
  const idleMs = Math.max(0, now - updatedAt);
  const turn = String(updatedAt);
  const base = { waitingOn: "", outcomeDetail: "", seen: true, childrenRunning: [], idleMs, unseenBasis: "" };
  if (!last) return { ...base, process: "idle", outcome: "unknown", basis: "no messages", turn: "" };
  if (last.error) {
    const aborted = /abort/i.test(last.error);
    return { ...base, process: "idle", outcome: aborted ? "interrupted" : "failed", outcomeDetail: aborted ? "" : (last.errorMessage ?? "").split("\n")[0] || last.error, basis: `message.error: ${last.error}`, turn };
  }
  if (last.role === "assistant" && last.completed && last.finish !== "tool-calls") return { ...base, process: "idle", outcome: "completed", basis: `message.finish: ${last.finish ?? "none"}`, turn };
  // The turn is open: the person's message is the newest, a reply is being written, or a step ended on tool calls.
  const open = last.role !== "assistant" ? "newest message is the person's" : last.completed ? "message.finish: tool-calls" : "message not completed";
  if (!processAlive) return { ...base, process: "idle", outcome: "interrupted", basis: `${open}, no opencode process`, turn };
  // Some opencode process is alive, but nothing says it is this session's: a turn that was cut off looks the same
  // as one being written for as long as any session is open somewhere. So an open turn only counts as running
  // while it is fresh, and one that has gone quiet is taken as cut off, never announced as stuck.
  if (idleMs > OPENCODE_STALE_MS) return { ...base, process: "idle", outcome: "interrupted", basis: `${open}, nothing written since`, turn };
  return { ...base, process: "running", outcome: "unknown", basis: open, turn: "" };
}

interface Row {
  id: string;
  title: string | null;
  directory: string | null;
  parent: string | null;
  updatedAt: number | null;
  last: string | null;
}

async function opencodeIsRunning(): Promise<boolean> {
  try {
    await run("pgrep", ["^opencode(\\.exe)?$"], { timeoutMs: 3_000 });
    return true;
  } catch {
    return false;
  }
}

export interface OpencodeReadOptions {
  /** Whether an opencode process is alive; asked of the system when not given (tests give it). */
  running?: () => Promise<boolean>;
}

const parseLast = (raw: string | null): OpencodeLast | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<OpencodeLast>;
    return { role: typeof v.role === "string" ? v.role : "", completed: typeof v.completed === "number" ? v.completed : null, finish: typeof v.finish === "string" ? v.finish : null, error: typeof v.error === "string" ? v.error : null, errorMessage: typeof v.errorMessage === "string" ? v.errorMessage : null };
  } catch {
    return null;
  }
};

export async function readOpencode(ctx: ReadContext, opts: OpencodeReadOptions = {}): Promise<PreparedRow[]> {
  const db = opencodeDb(ctx.home);
  if (!(await stat(db).catch(() => null))) return [];
  let rows: Row[];
  try {
    rows = await sqliteJson<Row>(
      db,
      `SELECT s.id, s.title, s.directory, s.parent_id AS parent, s.time_updated AS updatedAt,
              (SELECT json_object('role', json_extract(m.data,'$.role'), 'completed', json_extract(m.data,'$.time.completed'), 'finish', json_extract(m.data,'$.finish'),
                                  'error', json_extract(m.data,'$.error.name'), 'errorMessage', json_extract(m.data,'$.error.data.message'))
                 FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC, m.id DESC LIMIT 1) AS last
         FROM session s WHERE s.time_archived IS NULL AND s.time_updated >= ${Math.floor(ctx.since)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/no such (table|column)/.test(message)) ctx.errors.push(say(ctx.lang, "overview.err.source", { app: "OpenCode", error: message }));
    return [];
  }
  if (!rows.length) return [];
  const lasts = rows.map((r) => parseLast(r.last));
  const anyOpen = lasts.some((l) => l && !l.error && !(l.role === "assistant" && l.completed && l.finish !== "tool-calls"));
  const alive = anyOpen ? await (opts.running ?? opencodeIsRunning)() : false;
  return rows.map((r, i) => {
    const updatedAt = Number(r.updatedAt) || 0;
    const dir = r.directory ?? "";
    return {
      app: "opencode" as const,
      id: r.id,
      title: (r.title ?? "").split("\n")[0] ?? "",
      at: updatedAt,
      cwd: dir,
      open: dir ? { kind: "terminal" as const, bin: "opencode" as const, sessionId: r.id, cwd: dir } : null,
      // A sub-agent's session names the session that started it.
      parent: r.parent ? `opencode:${r.parent}` : null,
      facts: opencodeFacts(lasts[i] ?? null, updatedAt, ctx.now, alive),
    };
  });
}

export const opencodeSource: SessionSource = {
  app: "opencode",
  present: async (home) => Boolean(await stat(opencodeDb(home)).catch(() => null)),
  read: (ctx) => readOpencode(ctx),
};
