// The WorkBuddy reader against a stand-in for its database: only the columns the reader asks for exist.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide, type ReadContext } from "../overview.js";
import { readWorkbuddy, workbuddyDb, workbuddySource } from "./workbuddy.js";

const root = mkdtempSync(join(tmpdir(), "chancery-workbuddy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const now = Date.now();
const MIN = 60_000;
const ctxFor = (home: string): ReadContext => ({ home, since: now - 14 * 86_400_000, now, lang: "zh", errors: [], claudeAgents: async () => [] });

describe("readWorkbuddy", () => {
  it("lists the local sessions that are still there, by their own title, and reads finished and unread from the table", async () => {
    const home = join(root, "home");
    mkdirSync(dirname(workbuddyDb(home)), { recursive: true });
    const row = (id: string, o: { title?: string; custom?: string; status?: string; at?: number; unread?: number; deleted?: number | null; playground?: number; transport?: string }) =>
      `INSERT INTO sessions (id, cwd, title, custom_title, status, updated_at, last_activity_at, deleted_at, is_playground, transport, unread) VALUES ('${id}', '${o.playground ? "/home/WorkBuddy/2026-11-13-10-00-00" : "/work/site"}', '${o.title ?? "Test"}', ${o.custom ? `'${o.custom}'` : "NULL"}, '${o.status ?? "completed"}', ${o.at ?? now - 5 * MIN}, ${o.at ?? now - 5 * MIN}, ${o.deleted === undefined ? "NULL" : o.deleted}, ${o.playground ?? 0}, '${o.transport ?? "local"}', ${o.unread ?? 0});`;
    execFileSync(
      "sqlite3",
      [
        workbuddyDb(home),
        [
          "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT, status TEXT, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER, is_playground INTEGER, is_background_automation INTEGER, transport TEXT, unread INTEGER);",
          row("s-done", { title: "Build the landing page" }),
          row("s-named", { title: "Untitled", custom: "Pricing table", unread: 1 }),
          row("s-other", { status: "Pending", deleted: -1 }),
          row("s-deleted", { deleted: now - MIN }),
          row("s-playground", { playground: 1 }),
          row("s-cloud", { transport: "cloud" }),
          row("s-old", { at: now - 30 * 86_400_000 }),
        ].join("\n"),
      ],
      { stdio: "pipe" },
    );
    const ctx = ctxFor(home);
    const rows = await readWorkbuddy(ctx);
    expect(ctx.errors).toEqual([]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual(["s-done", "s-named", "s-other", "s-playground"]);
    // Started without a project: it ran in a folder of its own, and is placed in the folder those all sit in.
    expect(byId.get("s-playground")).toMatchObject({ cwd: "/home/WorkBuddy" });
    expect(byId.get("s-done")).toMatchObject({ app: "workbuddy", title: "Build the landing page", cwd: "/work/site", at: now - 5 * MIN, open: { kind: "app", app: "workbuddy" } });
    expect(decide(byId.get("s-done")!.facts).state).toBe("done");
    expect(byId.get("s-named")).toMatchObject({ title: "Pricing table" });
    expect(decide(byId.get("s-named")!.facts).state).toBe("unread");
    // A status that is not "completed" is one whose meaning is not known: no claim is made about it.
    expect(decide(byId.get("s-other")!.facts)).toMatchObject({ state: "done", turn: "", basis: "sessions.status: Pending" });
    expect(await workbuddySource.present(home)).toBe(true);
  });

  it("finds nothing, and nothing wrong, without WorkBuddy", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    const ctx = ctxFor(bare);
    expect(await readWorkbuddy(ctx)).toEqual([]);
    expect(ctx.errors).toEqual([]);
    expect(await workbuddySource.present(bare)).toBe(false);
  });
});
