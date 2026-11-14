// GitHub Copilot's chat and agent sessions in VS Code, read from the editor's per-workspace storage.
//
//   ~/Library/Application Support/Code/User/workspaceStorage/<hash>/workspace.json   { folder: "file:///…" }
//   ~/Library/Application Support/Code/User/workspaceStorage/<hash>/state.vscdb
//     ItemTable['chat.ChatSessionStore.index'] = { entries: { <id>: { title, lastMessageDate, isEmpty, isExternal,
//       hasPendingEdits, lastResponseState, timing: { created, lastRequestStarted, lastRequestEnded } } } }
//
// `lastResponseState` is 0 pending, 1 complete, 2 cancelled, 3 failed, 4 needs input: the numbers VS Code's own
// session list is drawn from (read out of VS Code 1.139, 2026-11; not a documented format). VS Code writes this
// index when it is idle or closing, so it can be a little behind, and when it loads a session left at 0 or 4 it
// rewrites it as complete: those two therefore only mean something while VS Code is running. Whether a session has
// been read is kept elsewhere in a shape that could not be checked against real data, so it is not used. VS Code
// has no link to one local chat; a session is reopened by opening its folder.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreparedRow, ReadContext, SessionFacts, SessionSource } from "../overview.js";
import { t as say, type Lang } from "../i18n/index.js";
import { run } from "../util/run.js";
import { sqliteJson } from "../util/sqlite.js";

export const vscodeWorkspaceStorage = (home: string): string => join(home, "Library", "Application Support", "Code", "User", "workspaceStorage");

/** A request still marked pending with nothing new for this long is shown as stuck rather than running. */
export const COPILOT_STALE_MS = 30 * 60_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One entry of the index, reduced to what decides a state. */
export interface CopilotSession {
  /** `lastResponseState`; null when the entry has none. */
  responseState: number | null;
  hasPendingEdits: boolean;
  updatedAt: number;
}

export function copilotFacts(s: CopilotSession, now: number, vscodeRunning: boolean, lang: Lang = "zh"): SessionFacts {
  const idleMs = Math.max(0, now - s.updatedAt);
  const turn = String(s.updatedAt);
  const base = { waitingOn: "", outcomeDetail: "", seen: true, childrenRunning: [], idleMs, unseenBasis: "" };
  const live = s.responseState === 0 || s.responseState === 4;
  if (live && !vscodeRunning) return { ...base, process: "idle", outcome: "interrupted", basis: `lastResponseState: ${s.responseState}, VS Code not running`, turn };
  if (s.responseState === 4) return { ...base, process: "waiting", waitingOn: say(lang, "overview.waitingFor.input"), outcome: "unknown", basis: "lastResponseState: 4 (needs input)", turn };
  if (s.responseState === 0) return { ...base, process: idleMs > COPILOT_STALE_MS ? "stalled" : "running", outcome: "unknown", basis: "lastResponseState: 0 (pending)", turn: "" };
  if (s.responseState === 3) return { ...base, process: "idle", outcome: "failed", basis: "lastResponseState: 3 (failed)", turn };
  if (s.responseState === 2) return { ...base, process: "idle", outcome: "interrupted", basis: "lastResponseState: 2 (cancelled)", turn };
  if (s.hasPendingEdits) return { ...base, process: "idle", outcome: "review", outcomeDetail: say(lang, "overview.editsPending"), basis: "hasPendingEdits", turn };
  if (s.responseState === 1) return { ...base, process: "idle", outcome: "completed", basis: "lastResponseState: 1 (complete)", turn };
  return { ...base, process: "idle", outcome: "unknown", basis: "lastResponseState: none", turn: "" };
}

/** The rows in one workspace's index. `dir` is the workspace's folder, empty when it has none on this machine. */
export function copilotRows(index: unknown, dir: string, now: number, vscodeRunning: boolean, lang: Lang = "zh"): PreparedRow[] {
  const entries = isRecord(index) && isRecord(index.entries) ? index.entries : {};
  const rows: PreparedRow[] = [];
  for (const [id, e] of Object.entries(entries)) {
    // An empty entry is a chat view that was opened and never used; an external one belongs to another provider.
    if (!isRecord(e) || e.isEmpty === true || e.isExternal === true) continue;
    const timing = isRecord(e.timing) ? e.timing : {};
    const updatedAt = Math.max(num(e.lastMessageDate), num(timing.lastRequestEnded), num(timing.lastRequestStarted), num(timing.created));
    if (!updatedAt) continue;
    rows.push({
      app: "copilot",
      id,
      title: str(e.title).split("\n")[0] ?? "",
      at: updatedAt,
      cwd: dir,
      open: dir ? { kind: "folder", app: "copilot", dir } : null,
      parent: null,
      facts: copilotFacts({ responseState: typeof e.lastResponseState === "number" ? e.lastResponseState : null, hasPendingEdits: e.hasPendingEdits === true, updatedAt }, now, vscodeRunning, lang),
    });
  }
  return rows;
}

async function vscodeIsRunning(): Promise<boolean> {
  try {
    await run("pgrep", ["-f", "Visual Studio Code.app/Contents/MacOS/"], { timeoutMs: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function folderOf(workspace: string): Promise<string> {
  try {
    const w: unknown = JSON.parse(await readFile(join(workspace, "workspace.json"), "utf8"));
    const uri = isRecord(w) ? str(w.folder) : "";
    return uri.startsWith("file://") ? fileURLToPath(uri) : "";
  } catch {
    return "";
  }
}

// One query per workspace is one sqlite3 process; a workspace's index is read again only when its database (or its
// write-ahead log) has changed.
const read = new Map<string, { stamp: number; index: unknown; dir: string }>();

export interface CopilotReadOptions {
  /** Whether VS Code is running; asked of the system when not given (tests give it). */
  running?: () => Promise<boolean>;
}

export async function readCopilot(ctx: ReadContext, opts: CopilotReadOptions = {}): Promise<PreparedRow[]> {
  const root = vscodeWorkspaceStorage(ctx.home);
  const found: Array<{ index: unknown; dir: string }> = [];
  for (const hash of await readdir(root).catch(() => [] as string[])) {
    const workspace = join(root, hash);
    const db = join(workspace, "state.vscdb");
    const [main, wal] = await Promise.all([stat(db).catch(() => null), stat(`${db}-wal`).catch(() => null)]);
    if (!main) continue;
    const stamp = Math.max(main.mtimeMs, wal?.mtimeMs ?? 0);
    // Nothing written since the window began: no session in it can be inside the window.
    if (stamp < ctx.since) continue;
    let entry = read.get(db);
    if (!entry || entry.stamp !== stamp) {
      try {
        const rows = await sqliteJson<{ value: string }>(db, "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'");
        entry = { stamp, index: rows[0] ? (JSON.parse(rows[0].value) as unknown) : null, dir: await folderOf(workspace) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/no such table/.test(message)) ctx.errors.push(say(ctx.lang, "overview.err.source", { app: "Copilot", error: message }));
        continue;
      }
      read.set(db, entry);
    }
    if (entry.index) found.push(entry);
  }
  if (!found.length) return [];
  const pending = (index: unknown) => isRecord(index) && isRecord(index.entries) && Object.values(index.entries).some((e) => isRecord(e) && (e.lastResponseState === 0 || e.lastResponseState === 4));
  const running = found.some((f) => pending(f.index)) ? await (opts.running ?? vscodeIsRunning)() : false;
  return found.flatMap((f) => copilotRows(f.index, f.dir, ctx.now, running, ctx.lang)).filter((r) => r.at >= ctx.since);
}

export const copilotSource: SessionSource = {
  app: "copilot",
  present: async (home) => Boolean(await stat(vscodeWorkspaceStorage(home)).catch(() => null)),
  read: (ctx) => readCopilot(ctx),
};
