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

  it("leaves out sessions whose directory is gone unless asked for them", async () => {
    writeSession("gone", { lastActivityAt: now - DAY, cwd: join(root, "deleted"), originCwd: join(root, "deleted") });
    const claudeBin = fakeClaude([]);

    const shown = await buildOverview({ home, claudeBin, days: 3, now });
    expect(shown.sessions.map((s) => s.title)).not.toContain("gone");
    expect(shown.projects.map((p) => p.key)).not.toContain(OTHER_PROJECT_KEY);

    const all = await buildOverview({ home, claudeBin, days: 3, now, includeGone: true });
    expect(all.sessions.find((s) => s.title === "gone")?.projectKey).toBe(OTHER_PROJECT_KEY);
  });
});
