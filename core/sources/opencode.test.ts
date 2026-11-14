// The OpenCode reader against a stand-in for its database: only the columns the reader asks for exist.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide, decideAll, type ReadContext } from "../overview.js";
import { OPENCODE_STALE_MS, opencodeDb, opencodeFacts, opencodeSource, readOpencode, type OpencodeLast } from "./opencode.js";

const root = mkdtempSync(join(tmpdir(), "chancery-opencode-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const now = Date.now();
const MIN = 60_000;
const last = (over: Partial<OpencodeLast> = {}): OpencodeLast => ({ role: "assistant", completed: now - MIN, finish: "stop", error: null, errorMessage: null, ...over });
const stateOf = (l: OpencodeLast | null, alive = true, idle = MIN) => decide(opencodeFacts(l, now - idle, now, alive)).state;

describe("opencodeFacts", () => {
  it("reads the newest message: finished on a stop, still open otherwise", () => {
    expect(stateOf(last())).toBe("done");
    expect(stateOf(last({ completed: null, finish: null }))).toBe("running");
    expect(stateOf(last({ finish: "tool-calls" }))).toBe("running");
    expect(stateOf(last({ role: "user", completed: null, finish: null }))).toBe("running");
    expect(stateOf(null)).toBe("done");
  });

  it("takes an open turn as cut off when no opencode process is alive, or when it has gone quiet for a long time", () => {
    expect(stateOf(last({ completed: null, finish: null }), false)).toBe("interrupted");
    expect(stateOf(last({ completed: null, finish: null }), true, OPENCODE_STALE_MS + MIN)).toBe("interrupted");
  });

  it("reads an error by its name: an abort is the person's doing, anything else a failure with its message", () => {
    expect(stateOf(last({ completed: null, error: "MessageAbortedError" }))).toBe("interrupted");
    expect(decide(opencodeFacts(last({ completed: null, error: "APIError", errorMessage: "429 rate limited\nretry later" }), now, now, true))).toMatchObject({ state: "error", detail: "429 rate limited" });
  });
});

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ctxFor = (home: string): ReadContext => ({ home, since: now - 14 * 86_400_000, now, lang: "zh", errors: [], claudeAgents: async () => [] });

describe("readOpencode", () => {
  it("lists the sessions with their directory, each by its newest message, and ties a sub-agent's session to the one that started it", async () => {
    const home = join(root, "home");
    mkdirSync(dirname(opencodeDb(home)), { recursive: true });
    const session = (id: string, o: { title: string; parent?: string; at?: number; archived?: boolean }) =>
      `INSERT INTO session VALUES (${sqlText(id)}, ${o.parent ? sqlText(o.parent) : "NULL"}, '/work/api', ${sqlText(o.title)}, ${o.at ?? now - 5 * MIN}, ${o.archived ? now : "NULL"});`;
    const message = (id: string, sessionId: string, at: number, data: Record<string, unknown>) => `INSERT INTO message VALUES (${sqlText(id)}, ${sqlText(sessionId)}, ${at}, ${sqlText(JSON.stringify(data))});`;
    execFileSync(
      "sqlite3",
      [
        opencodeDb(home),
        [
          "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_updated INTEGER, time_archived INTEGER);",
          "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);",
          session("ses_done0001", { title: "Add retries to the client\nsecond line" }),
          message("m1", "ses_done0001", now - 9 * MIN, { role: "user", time: { created: now - 9 * MIN } }),
          message("m2", "ses_done0001", now - 8 * MIN, { role: "assistant", time: { created: now - 8 * MIN, completed: now - 7 * MIN }, finish: "tool-calls" }),
          message("m3", "ses_done0001", now - 6 * MIN, { role: "assistant", time: { created: now - 6 * MIN, completed: now - 5 * MIN }, finish: "stop" }),
          session("ses_parent01", { title: "Refactor the queue", at: now - 2 * MIN }),
          message("m4", "ses_parent01", now - 3 * MIN, { role: "assistant", time: { created: now - 3 * MIN, completed: now - 2 * MIN }, finish: "stop" }),
          session("ses_child001", { title: "Explore the worker", parent: "ses_parent01", at: now - MIN }),
          message("m5", "ses_child001", now - MIN, { role: "assistant", time: { created: now - MIN } }),
          session("ses_archived", { title: "Put away", archived: true }),
          session("ses_old00001", { title: "Last month", at: now - 30 * 86_400_000 }),
        ].join("\n"),
      ],
      { stdio: "pipe" },
    );
    const ctx = ctxFor(home);
    const rows = await readOpencode(ctx, { running: async () => true });
    expect(ctx.errors).toEqual([]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual(["ses_child001", "ses_done0001", "ses_parent01"]);
    expect(byId.get("ses_done0001")).toMatchObject({ app: "opencode", title: "Add retries to the client", cwd: "/work/api", at: now - 5 * MIN, parent: null, open: { kind: "terminal", bin: "opencode", sessionId: "ses_done0001", cwd: "/work/api" } });
    expect(byId.get("ses_child001")).toMatchObject({ parent: "opencode:ses_parent01" });
    // The parent finished its own turn, but the session it started is still at work.
    const states = new Map(decideAll(rows).map((r) => [r.id, r.state]));
    expect(states.get("ses_done0001")).toBe("done");
    expect(states.get("ses_child001")).toBe("running");
    expect(states.get("ses_parent01")).toBe("delegated");
    expect(await opencodeSource.present(home)).toBe(true);
  });

  it("finds nothing, and nothing wrong, without OpenCode", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    const ctx = ctxFor(bare);
    expect(await readOpencode(ctx)).toEqual([]);
    expect(ctx.errors).toEqual([]);
    expect(await opencodeSource.present(bare)).toBe(false);
  });
});
