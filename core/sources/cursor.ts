// Cursor's agent sessions ("composers"), read from the editor's own global state database.
//
//   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//     composerHeaders            one row per composer: ids, times, archived / sub-agent flags, and a JSON `value` with
//                                the name, the workspace folder and the three flags its own sidebar is drawn from
//     cursorDiskKV               `composerData:<id>` holds the composer itself; `status` and `abortReason` say how
//                                the last turn went
//
// Read out of Cursor 3.12 (2026-11); none of it is a documented format. An older Cursor keeps its list elsewhere and
// has no `composerHeaders` table: that reads as no sessions, not as an error. Cursor has no link that opens one
// composer, so a session is reopened by opening its folder.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedRow, ReadContext, SessionFacts, SessionSource } from "../overview.js";
import { t as say, type Lang } from "../i18n/index.js";
import { run } from "../util/run.js";
import { sqliteJson } from "../util/sqlite.js";

export const cursorStateDb = (home: string): string => join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");

/** A composer still marked as generating with nothing written for this long is shown as stuck rather than running. */
export const CURSOR_STALE_MS = 30 * 60_000;

/** What the database says about one composer, as the reader's query returns it. */
export interface CursorComposer {
  /** `composerData.status`: none / generating / completed / aborted. */
  status: string | null;
  /** `composerData.abortReason`: "user" or "error", when aborted. */
  abortReason: string | null;
  /** The header's `hasBlockingPendingActions`: a step is waiting for the person's approval. */
  blocking: boolean;
  /** The header's `hasPendingPlan`: a plan is waiting to be accepted. */
  pendingPlan: boolean;
  /** The header's `hasUnreadMessages`: a reply finished while another composer was on screen. */
  unread: boolean;
  updatedAt: number;
}

/**
 * Cursor's own sidebar reads these in this order: blocking actions, then generating, then a pending plan, else done.
 * `cursorRunning` matters for one case: Cursor rewrites a composer left at "generating" only when it next loads it,
 * so with the app closed that word means a turn that was cut off, not one that is going.
 */
export function cursorFacts(c: CursorComposer, now: number, cursorRunning: boolean, lang: Lang = "zh"): SessionFacts {
  const idleMs = Math.max(0, now - c.updatedAt);
  const turn = String(c.updatedAt);
  const base = { waitingOn: "", outcomeDetail: "", seen: !c.unread, childrenRunning: [], idleMs, unseenBasis: "hasUnreadMessages" };
  if (c.blocking) return { ...base, process: "waiting", waitingOn: say(lang, "overview.waitingFor.permission"), outcome: "unknown", basis: "composer: hasBlockingPendingActions", turn };
  if (c.status === "generating") {
    if (!cursorRunning) return { ...base, process: "idle", outcome: "interrupted", basis: "composer: generating, Cursor not running", turn };
    return { ...base, process: idleMs > CURSOR_STALE_MS ? "stalled" : "running", outcome: "unknown", basis: "composer.status: generating", turn: "" };
  }
  if (c.pendingPlan) return { ...base, process: "idle", outcome: "asked", outcomeDetail: say(lang, "overview.planPending"), basis: "composer: hasPendingPlan", turn };
  if (c.status === "aborted") return { ...base, process: "idle", outcome: c.abortReason === "error" ? "failed" : "interrupted", basis: `composer.status: aborted (${c.abortReason || "no reason"})`, turn };
  if (c.status === "completed") return { ...base, process: "idle", outcome: "completed", basis: "composer.status: completed", turn };
  return { ...base, process: "idle", outcome: "unknown", basis: `composer.status: ${c.status || "none"}`, turn: "" };
}

interface ComposerRow {
  id: string;
  name: string | null;
  dir: string | null;
  updatedAt: number | null;
  status: string | null;
  abortReason: string | null;
  blocking: number | null;
  pendingPlan: number | null;
  unread: number | null;
}

async function cursorIsRunning(): Promise<boolean> {
  try {
    await run("pgrep", ["-x", "Cursor"], { timeoutMs: 3_000 });
    return true;
  } catch {
    return false;
  }
}

export interface CursorReadOptions {
  /** Whether the Cursor app is running; asked of the system when not given (tests give it). */
  running?: () => Promise<boolean>;
}

export async function readCursor(ctx: ReadContext, opts: CursorReadOptions = {}): Promise<PreparedRow[]> {
  const db = cursorStateDb(ctx.home);
  if (!(await stat(db).catch(() => null))) return [];
  let rows: ComposerRow[];
  try {
    // Fields are pulled out one by one: a composer's whole record runs to hundreds of kilobytes.
    rows = await sqliteJson<ComposerRow>(
      db,
      `SELECT h.composerId AS id, json_extract(h.value,'$.name') AS name, json_extract(h.value,'$.workspaceIdentifier.uri.fsPath') AS dir,
              h.lastUpdatedAt AS updatedAt, json_extract(d.value,'$.status') AS status, json_extract(d.value,'$.abortReason') AS abortReason,
              json_extract(h.value,'$.hasBlockingPendingActions') AS blocking, json_extract(h.value,'$.hasPendingPlan') AS pendingPlan,
              json_extract(h.value,'$.hasUnreadMessages') AS unread
         FROM composerHeaders h LEFT JOIN cursorDiskKV d ON d.key = 'composerData:' || h.composerId
        WHERE h.lastUpdatedAt >= ${Math.floor(ctx.since)} AND COALESCE(h.isArchived, 0) = 0 AND COALESCE(h.isSubagent, 0) = 0
          AND COALESCE(json_extract(h.value,'$.isDraft'), 0) = 0`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table/.test(message)) return [];
    ctx.errors.push(say(ctx.lang, "overview.err.source", { app: "Cursor", error: message }));
    return [];
  }
  if (!rows.length) return [];
  const running = rows.some((r) => r.status === "generating") ? await (opts.running ?? cursorIsRunning)() : false;
  return rows.map((r) => {
    const dir = r.dir ?? "";
    const updatedAt = Number(r.updatedAt) || 0;
    return {
      app: "cursor" as const,
      id: r.id,
      title: (r.name ?? "").split("\n")[0] ?? "",
      at: updatedAt,
      cwd: dir,
      open: dir ? { kind: "folder" as const, app: "cursor" as const, dir } : null,
      parent: null,
      facts: cursorFacts({ status: r.status, abortReason: r.abortReason, blocking: Boolean(r.blocking), pendingPlan: Boolean(r.pendingPlan), unread: Boolean(r.unread), updatedAt }, ctx.now, running, ctx.lang),
    };
  });
}

export const cursorSource: SessionSource = {
  app: "cursor",
  present: async (home) => Boolean(await stat(cursorStateDb(home)).catch(() => null)),
  read: (ctx) => readCursor(ctx),
};
