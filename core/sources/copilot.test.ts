// The VS Code Copilot reader against stand-ins for a workspace's storage: a workspace.json and a state database
// holding the chat session index.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { decide, type ReadContext } from "../overview.js";
import { COPILOT_STALE_MS, copilotFacts, copilotSource, readCopilot, vscodeWorkspaceStorage, type CopilotSession } from "./copilot.js";

const root = mkdtempSync(join(tmpdir(), "chancery-copilot-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const now = Date.now();
const MIN = 60_000;
const session = (over: Partial<CopilotSession> = {}): CopilotSession => ({ responseState: 1, hasPendingEdits: false, updatedAt: now - 5 * MIN, ...over });
const stateOf = (s: CopilotSession, running = true) => decide(copilotFacts(s, now, running)).state;

describe("copilotFacts", () => {
  it("reads VS Code's own numbers for how the last response went", () => {
    expect(stateOf(session({ responseState: 0 }))).toBe("running");
    expect(stateOf(session({ responseState: 0, updatedAt: now - COPILOT_STALE_MS - MIN }))).toBe("stuck");
    expect(stateOf(session({ responseState: 4 }))).toBe("needs-you");
    expect(stateOf(session({ responseState: 3 }))).toBe("error");
    expect(stateOf(session({ responseState: 2 }))).toBe("interrupted");
    expect(stateOf(session({ responseState: 1 }))).toBe("done");
    expect(stateOf(session({ responseState: 1, hasPendingEdits: true }))).toBe("review");
    expect(stateOf(session({ responseState: null }))).toBe("done");
  });

  it("takes pending and needs-input as cut off when VS Code is closed, since only a running VS Code holds a session there", () => {
    expect(stateOf(session({ responseState: 0 }), false)).toBe("interrupted");
    expect(stateOf(session({ responseState: 4 }), false)).toBe("interrupted");
  });
});

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;

function makeWorkspace(home: string, hash: string, folder: string | null, entries: Record<string, unknown> | null): void {
  const dir = join(vscodeWorkspaceStorage(home), hash);
  mkdirSync(dir, { recursive: true });
  if (folder) writeFileSync(join(dir, "workspace.json"), JSON.stringify({ folder: pathToFileURL(folder).href }));
  const statements = ["CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);", "INSERT INTO ItemTable VALUES ('workbench.view.unrelated', '{}');"];
  if (entries) statements.push(`INSERT INTO ItemTable VALUES ('chat.ChatSessionStore.index', ${sqlText(JSON.stringify({ version: 1, entries }))});`);
  execFileSync("sqlite3", [join(dir, "state.vscdb"), statements.join("\n")], { stdio: "pipe" });
}

const ctxFor = (home: string): ReadContext => ({ home, since: now - 14 * 86_400_000, now, lang: "zh", errors: [], claudeAgents: async () => [] });

describe("readCopilot", () => {
  it("lists the chats that were used, each under its workspace's folder, and leaves out the empty and external ones", async () => {
    const home = join(root, "home");
    makeWorkspace(home, "aaa", "/work/site with space", {
      "s-done": { title: "Refactor the router", lastMessageDate: now - 10 * MIN, lastResponseState: 1, isEmpty: false, timing: { created: now - 60 * MIN, lastRequestEnded: now - 10 * MIN } },
      "s-asking": { title: "Run the tests", lastMessageDate: now - 2 * MIN, lastResponseState: 4, isEmpty: false },
      "s-empty": { title: "New Chat", lastMessageDate: now - MIN, lastResponseState: 1, isEmpty: true },
      "s-external": { title: "Cloud task", lastMessageDate: now - MIN, lastResponseState: 1, isEmpty: false, isExternal: true },
      "s-old": { title: "Last month", lastMessageDate: now - 30 * 86_400_000, lastResponseState: 1, isEmpty: false },
    });
    makeWorkspace(home, "bbb", null, { "s-nofolder": { title: "Loose", lastMessageDate: now - 3 * MIN, lastResponseState: 3, isEmpty: false } });
    makeWorkspace(home, "ccc", "/work/untouched", null);

    const ctx = ctxFor(home);
    const rows = await readCopilot(ctx, { running: async () => true });
    expect(ctx.errors).toEqual([]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual(["s-asking", "s-done", "s-nofolder"]);
    expect(byId.get("s-done")).toMatchObject({ app: "copilot", title: "Refactor the router", cwd: "/work/site with space", at: now - 10 * MIN, open: { kind: "folder", app: "copilot", dir: "/work/site with space" } });
    expect(decide(byId.get("s-done")!.facts).state).toBe("done");
    expect(decide(byId.get("s-asking")!.facts).state).toBe("needs-you");
    expect(byId.get("s-nofolder")).toMatchObject({ cwd: "", open: null });
    expect(decide(byId.get("s-nofolder")!.facts).state).toBe("error");
    expect(await copilotSource.present(home)).toBe(true);
  });

  it("finds nothing, and nothing wrong, without VS Code", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    const ctx = ctxFor(bare);
    expect(await readCopilot(ctx)).toEqual([]);
    expect(ctx.errors).toEqual([]);
    expect(await copilotSource.present(bare)).toBe(false);
  });
});
