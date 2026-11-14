// WorkBuddy's (Tencent) sessions, from the app's own database.
//
//   ~/.workbuddy/workbuddy.db
//     sessions(id, cwd, title, custom_title, status, last_activity_at, updated_at, unread, deleted_at,
//              is_playground, is_background_automation, transport, …)
//
// A session started without picking a project (`is_playground`) runs in a folder of its own that the app makes
// under ~/WorkBuddy, named by the time; those are all placed in that one parent folder, so they are one group here
// instead of a group per session.
//
// Read out of WorkBuddy 5.8 (2026-11); not a documented format. The table says where a session ran, what it is
// called, when it last moved and whether it has been read. Its `status` is a word of the app's own: "completed" is
// the only one seen on real data ("Pending" is the column's default), and the app's code did not give up the
// rest, so a turn in progress, a failure or a question cannot be told apart yet: anything that is not "completed"
// reads as no record of how it ended. The app registers a `workbuddy://` scheme but nothing was found that opens a
// session by id, so the jump only brings the app up.
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PreparedRow, ReadContext, SessionFacts, SessionSource } from "../overview.js";
import { t as say } from "../i18n/index.js";
import { sqliteJson } from "../util/sqlite.js";

export const workbuddyDb = (home: string): string => join(home, ".workbuddy", "workbuddy.db");

export function workbuddyFacts(s: { status: string; unread: boolean; at: number }, now: number): SessionFacts {
  const completed = s.status.toLowerCase() === "completed";
  return {
    process: "idle",
    waitingOn: "",
    outcome: completed ? "completed" : "unknown",
    outcomeDetail: "",
    seen: !s.unread,
    childrenRunning: [],
    idleMs: Math.max(0, now - s.at),
    basis: `sessions.status: ${s.status || "none"}`,
    turn: completed ? String(s.at) : "",
    unseenBasis: "unread",
  };
}

interface Row {
  id: string;
  cwd: string | null;
  title: string | null;
  status: string | null;
  at: number | null;
  unread: number | null;
  playground: number | null;
}

export async function readWorkbuddy(ctx: ReadContext): Promise<PreparedRow[]> {
  const db = workbuddyDb(ctx.home);
  if (!(await stat(db).catch(() => null))) return [];
  let rows: Row[];
  try {
    rows = await sqliteJson<Row>(
      db,
      `SELECT id, cwd, COALESCE(NULLIF(custom_title, ''), title) AS title, status, COALESCE(last_activity_at, updated_at) AS at, unread, is_playground AS playground
         FROM sessions
        WHERE (deleted_at IS NULL OR deleted_at = -1) AND COALESCE(is_background_automation, 0) = 0
          AND COALESCE(transport, 'local') = 'local' AND COALESCE(last_activity_at, updated_at) >= ${Math.floor(ctx.since)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/no such (table|column)/.test(message)) ctx.errors.push(say(ctx.lang, "overview.err.source", { app: "WorkBuddy", error: message }));
    return [];
  }
  return rows.map((r) => {
    const at = Number(r.at) || 0;
    return {
      app: "workbuddy" as const,
      id: r.id,
      title: (r.title ?? "").split("\n")[0] ?? "",
      at,
      cwd: r.cwd && r.playground ? dirname(r.cwd) : (r.cwd ?? ""),
      open: { kind: "app" as const, app: "workbuddy" as const },
      parent: null,
      facts: workbuddyFacts({ status: r.status ?? "", unread: Boolean(r.unread), at }, ctx.now),
    };
  });
}

export const workbuddySource: SessionSource = {
  app: "workbuddy",
  present: async (home) => Boolean(await stat(workbuddyDb(home)).catch(() => null)),
  read: readWorkbuddy,
};
