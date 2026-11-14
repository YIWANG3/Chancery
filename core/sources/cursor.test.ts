// Cursor's reader against a stand-in for its global state database: only the columns and JSON fields the reader
// asks for exist.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide, type ReadContext } from "../overview.js";
import { CURSOR_STALE_MS, cursorFacts, cursorSource, cursorStateDb, readCursor, type CursorComposer } from "./cursor.js";

const root = mkdtempSync(join(tmpdir(), "chancery-cursor-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const now = 1_800_000_000_000;
const MIN = 60_000;
const composer = (over: Partial<CursorComposer> = {}): CursorComposer => ({ status: "completed", abortReason: null, blocking: false, pendingPlan: false, unread: false, updatedAt: now - 5 * MIN, ...over });
const stateOf = (c: CursorComposer, running = true) => decide(cursorFacts(c, now, running)).state;

describe("cursorFacts", () => {
  it("follows the order Cursor's own sidebar uses: a blocked step, then generating, then a pending plan, else how it ended", () => {
    expect(stateOf(composer({ blocking: true, status: "generating" }))).toBe("needs-you");
    expect(stateOf(composer({ status: "generating" }))).toBe("running");
    expect(stateOf(composer({ pendingPlan: true }))).toBe("needs-you");
    expect(stateOf(composer())).toBe("done");
    expect(stateOf(composer({ unread: true }))).toBe("unread");
    expect(stateOf(composer({ status: "aborted", abortReason: "error" }))).toBe("error");
    expect(stateOf(composer({ status: "aborted", abortReason: "user" }))).toBe("interrupted");
    expect(stateOf(composer({ status: "none" }))).toBe("done");
  });

  it("calls a composer that has generated nothing for a long time stuck", () => {
    expect(stateOf(composer({ status: "generating", updatedAt: now - CURSOR_STALE_MS - MIN }))).toBe("stuck");
  });

  it("reads 'generating' with Cursor closed as a turn that was cut off, since only a running Cursor clears that word", () => {
    expect(stateOf(composer({ status: "generating" }), false)).toBe("interrupted");
  });

  it("gives a settled turn a mark that changes when the composer moves on, and a running one none", () => {
    expect(cursorFacts(composer(), now, true).turn).toBe(String(now - 5 * MIN));
    expect(cursorFacts(composer({ status: "generating" }), now, true).turn).toBe("");
  });
});

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;

function makeDb(home: string, rows: Array<{ id: string; name?: string; dir?: string; updatedAt: number | null; archived?: boolean; subagent?: boolean; draft?: boolean; header?: Record<string, unknown>; data?: Record<string, unknown> | null }>): void {
  const db = cursorStateDb(home);
  mkdirSync(dirname(db), { recursive: true });
  const statements = [
    "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, value TEXT);",
    "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);",
    ...rows.flatMap((r) => {
      const header = { name: r.name ?? "", isDraft: Boolean(r.draft), ...(r.dir ? { workspaceIdentifier: { id: "w", uri: { fsPath: r.dir } } } : {}), ...r.header };
      return [
        `INSERT INTO composerHeaders VALUES (${sqlText(r.id)}, 'w', 0, ${r.updatedAt ?? "NULL"}, ${r.archived ? 1 : 0}, ${r.subagent ? 1 : 0}, ${sqlText(JSON.stringify(header))});`,
        ...(r.data === null ? [] : [`INSERT INTO cursorDiskKV VALUES (${sqlText(`composerData:${r.id}`)}, ${sqlText(JSON.stringify(r.data ?? { status: "completed" }))});`]),
      ];
    }),
  ];
  execFileSync("sqlite3", [db, statements.join("\n")], { stdio: "pipe" });
}

const ctxFor = (home: string): ReadContext => ({ home, since: now - 14 * 86_400_000, now, lang: "zh", errors: [], claudeAgents: async () => [] });

describe("readCursor", () => {
  it("lists the composers that are sessions, each with its folder, and leaves out drafts, archived ones, sub-agents and old ones", async () => {
    const home = join(root, "home");
    makeDb(home, [
      { id: "c-done", name: "Gitignore generation\nsecond line", dir: "/work/ads", updatedAt: now - 10 * MIN },
      { id: "c-blocked", name: "Run the migration", dir: "/work/ads", updatedAt: now - 2 * MIN, header: { hasBlockingPendingActions: true }, data: { status: "generating" } },
      { id: "c-unread", name: "Compare engines", dir: "/work/duck", updatedAt: now - 30 * MIN, header: { hasUnreadMessages: true } },
      { id: "c-nofolder", name: "Loose chat", updatedAt: now - MIN, data: null },
      { id: "c-draft", name: "", dir: "/work/ads", updatedAt: now - MIN, draft: true },
      { id: "c-empty", name: "", dir: "/work/ads", updatedAt: null },
      { id: "c-archived", name: "Old", dir: "/work/ads", updatedAt: now - MIN, archived: true },
      { id: "c-sub", name: "Helper", dir: "/work/ads", updatedAt: now - MIN, subagent: true },
      { id: "c-old", name: "Last month", dir: "/work/ads", updatedAt: now - 30 * 86_400_000 },
    ]);
    const ctx = ctxFor(home);
    const rows = await readCursor(ctx, { running: async () => true });
    expect(ctx.errors).toEqual([]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual(["c-blocked", "c-done", "c-nofolder", "c-unread"]);
    expect(byId.get("c-done")).toMatchObject({ app: "cursor", title: "Gitignore generation", cwd: "/work/ads", at: now - 10 * MIN, open: { kind: "folder", app: "cursor", dir: "/work/ads" } });
    expect(decide(byId.get("c-done")!.facts).state).toBe("done");
    expect(decide(byId.get("c-blocked")!.facts).state).toBe("needs-you");
    expect(decide(byId.get("c-unread")!.facts).state).toBe("unread");
    // No folder: nothing to open, and no record of how it went.
    expect(byId.get("c-nofolder")).toMatchObject({ cwd: "", open: null });
    expect(await cursorSource.present(home)).toBe(true);
  });

  it("finds nothing, and nothing wrong, where Cursor is not installed or keeps its list the way an older version did", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    const none = ctxFor(bare);
    expect(await readCursor(none)).toEqual([]);
    expect(await cursorSource.present(bare)).toBe(false);

    const old = join(root, "old");
    mkdirSync(dirname(cursorStateDb(old)), { recursive: true });
    execFileSync("sqlite3", [cursorStateDb(old), "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);"], { stdio: "pipe" });
    const ctx = ctxFor(old);
    expect(await readCursor(ctx)).toEqual([]);
    expect(ctx.errors).toEqual([]);
  });
});
