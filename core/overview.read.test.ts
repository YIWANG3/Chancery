// buildOverview against a scratch home: a Claude Desktop index on disk and a stand-in `claude` that answers
// `agents --json`. No Codex directory, so only the Claude reader runs.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OTHER_PROJECT_KEY, buildOverview } from "./overview.js";

const root = mkdtempSync(join(tmpdir(), "chancery-overview-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home");
const project = join(root, "repo");
const indexDir = join(home, "Library", "Application Support", "Claude", "claude-code-sessions", "org", "user");
mkdirSync(indexDir, { recursive: true });
mkdirSync(project, { recursive: true });

const DAY = 86_400_000;
const now = 1_800_000_000_000;

function writeSession(id: string, entry: Record<string, unknown>): void {
  writeFileSync(join(indexDir, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: `cli-${id}`, title: id, cwd: project, originCwd: project, isArchived: false, ...entry }));
}

/** A `claude` whose `agents --json` lists the given processes; anything else is an error. */
function fakeClaude(agents: Array<Record<string, unknown>>): string {
  const bin = join(root, "claude");
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = "agents" ] || exit 2\ncat <<'JSON'\n${JSON.stringify(agents)}\nJSON\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("buildOverview", () => {
  it("counts a session with a live process as active from when that process started", async () => {
    writeSession("stale", { lastActivityAt: now - 10 * DAY });
    writeSession("reopened", { lastActivityAt: now - 10 * DAY });
    writeSession("fresh", { lastActivityAt: now - DAY });
    const claudeBin = fakeClaude([{ pid: 1, cwd: project, kind: "interactive", startedAt: now - 60_000, sessionId: "cli-reopened", name: "reopened", status: "idle" }]);

    const overview = await buildOverview({ home, claudeBin, days: 3, now });
    expect(overview.errors).toEqual([]);
    expect(overview.sessions.map((s) => [s.title, s.at]).sort()).toEqual([
      ["fresh", now - DAY],
      ["reopened", now - 60_000],
    ]);
  });

  it("shows a session as waiting on the sub-sessions it started while one is still at work, then as itself", async () => {
    writeSession("parent", { lastActivityAt: now - 60_000, lastAssistantUuid: "p1", postTurnSummaryFor: "p1", postTurnSummary: { status_category: "blocked", needs_action: "确认子会话的计划" } });
    writeSession("child", { lastActivityAt: now - 30_000, spawnedFrom: { sessionId: "local_parent", sideSession: true, sharedFolder: true } });
    const childBusy = fakeClaude([{ pid: 2, cwd: project, kind: "interactive", startedAt: now - 30_000, sessionId: "cli-child", name: "child", status: "busy" }]);

    const while_ = await buildOverview({ home, claudeBin: childBusy, days: 3, now });
    expect(while_.sessions.find((s) => s.title === "parent")).toMatchObject({ state: "delegated", detail: "等 1 个子会话：child", parent: null });
    expect(while_.sessions.find((s) => s.title === "child")).toMatchObject({ state: "running", parent: "claude:local_parent" });

    writeSession("child", { lastActivityAt: now - 10_000, spawnedFrom: { sessionId: "local_parent" }, lastAssistantUuid: "c1", postTurnSummaryFor: "c1", postTurnSummary: { status_category: "completed", status_detail: "做完了" } });
    const after = await buildOverview({ home, claudeBin: fakeClaude([]), days: 3, now });
    expect(after.sessions.find((s) => s.title === "parent")).toMatchObject({ state: "needs-you", detail: "确认子会话的计划" });
    expect(after.sessions.find((s) => s.title === "child")).toMatchObject({ state: "done", detail: "做完了" });
  });

  it("leaves out sessions whose directory is gone unless asked for them", async () => {
    writeSession("gone", { lastActivityAt: now - DAY, cwd: join(root, "deleted"), originCwd: join(root, "deleted") });
    const claudeBin = fakeClaude([]);

    const shown = await buildOverview({ home, claudeBin, days: 3, now });
    expect(shown.sessions.map((s) => s.title)).not.toContain("gone");
    expect(shown.projects.map((p) => p.key)).not.toContain(OTHER_PROJECT_KEY);

    const all = await buildOverview({ home, claudeBin, days: 3, now, includeGone: true });
    expect(all.sessions.find((s) => s.title === "gone")?.projectKey).toBe(OTHER_PROJECT_KEY);
  });

  it("says which app's record of its sessions is on the machine at all, and finds nothing wrong where one is not", async () => {
    const here = await buildOverview({ home, claudeBin: fakeClaude([]), days: 3, now });
    expect(here.sources).toEqual({ claude: true, codex: false });

    // A machine with neither app: nothing to read, and that is not an error.
    const bare = join(root, "bare-home");
    mkdirSync(bare, { recursive: true });
    const none = await buildOverview({ home: bare, claudeBin: join(root, "no-such-claude"), days: 3, now });
    expect(none.sources).toEqual({ claude: false, codex: false });
    expect(none.sessions).toEqual([]);
    expect(none.errors).toEqual([]);
  });
});
