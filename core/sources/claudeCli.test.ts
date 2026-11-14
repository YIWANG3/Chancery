// The terminal Claude Code reader against transcripts written the way the CLI writes them.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ClaudeAgent } from "../claude/sessions.js";
import { decide, type ReadContext } from "../overview.js";
import { claudeCliSource, claudeProjectsRoot, headOf, readClaudeCli, tailOf } from "./claudeCli.js";

const root = mkdtempSync(join(tmpdir(), "chancery-claude-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const now = Date.now();
const MIN = 60_000;
const line = (o: Record<string, unknown>) => JSON.stringify(o);
const ask = (text: string, extra: Record<string, unknown> = {}) => line({ type: "user", uuid: `u-${text}`, entrypoint: "cli", cwd: "/work/api", isSidechain: false, message: { role: "user", content: text }, ...extra });
const say = (text: string, stop: string | null, extra: Record<string, unknown> = {}) => line({ type: "assistant", uuid: `a-${text}`, entrypoint: "cli", cwd: "/work/api", isSidechain: false, message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text }] }, ...extra });
const ended = (uuid: string) => line({ type: "system", subtype: "turn_duration", uuid, entrypoint: "cli", cwd: "/work/api", isSidechain: false });

describe("headOf / tailOf", () => {
  it("reads which kind of session it is, where it runs and the first thing a person asked, past the machine-written lines", () => {
    const head = headOf([line({ type: "mode", mode: "default" }), ask("<command-name>/clear</command-name>"), ask("x", { isMeta: true }), ask("fix the flaky upload test\nplease"), say("on it", "tool_use")].join("\n"));
    expect(head).toEqual({ entrypoint: "cli", cwd: "/work/api", firstAsk: "fix the flaky upload test" });
  });

  it("reads how the last turn went from the last conversation line", () => {
    expect(tailOf([ask("a"), say("done", "end_turn"), ended("t1")].join("\n"))).toMatchObject({ outcome: "completed", turn: "t1" });
    expect(tailOf([ask("a"), say("done", "end_turn")].join("\n"))).toMatchObject({ outcome: "completed", turn: "a-done" });
    expect(tailOf([ask("a"), say("working", "tool_use")].join("\n"))).toMatchObject({ outcome: "unknown", turn: "" });
    expect(tailOf([ask("a"), say("API Error: 529 overloaded", null, { isApiErrorMessage: true })].join("\n"))).toMatchObject({ outcome: "failed", outcomeDetail: "API Error: 529 overloaded" });
    expect(tailOf([ask("a"), say("working", "tool_use"), ask("[Request interrupted by user]")].join("\n"))).toMatchObject({ outcome: "interrupted" });
    // A sub-agent's lines are not the session's own, and a line cut by the edge of the slice is skipped.
    expect(tailOf(['{"type":"assistant","uuid":"cut', ask("a"), say("done", "end_turn"), say("side", "tool_use", { isSidechain: true })].join("\n"))).toMatchObject({ outcome: "completed" });
  });

  it("takes the name the session was given, the latest one, over anything else", () => {
    expect(tailOf([line({ type: "agent-name", agentName: "upload-fix" }), line({ type: "custom-title", customTitle: "Upload test" }), line({ type: "custom-title", customTitle: "Flaky upload test" }), ask("a")].join("\n")).title).toBe("Flaky upload test");
    expect(tailOf([line({ type: "agent-name", agentName: "upload-fix" }), ask("a")].join("\n")).title).toBe("upload-fix");
  });
});

function writeTranscript(home: string, id: string, lines: string[], mtime = now - 5 * MIN): void {
  const dir = join(claudeProjectsRoot(home), "-work-api");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  utimesSync(path, mtime / 1000, mtime / 1000);
}

const ctxFor = (home: string, agents: ClaudeAgent[] = []): ReadContext => ({ home, since: now - 14 * 86_400_000, now, lang: "zh", errors: [], claudeAgents: async () => agents });
const agent = (sessionId: string, status: string, extra: Partial<ClaudeAgent> = {}): ClaudeAgent => ({ pid: 1, cwd: "/work/api", kind: "interactive", startedAt: now - 60 * MIN, sessionId, name: "", status, ...extra });

describe("readClaudeCli", () => {
  it("lists the sessions started in a terminal, and only those: live ones by what their process is doing, ended ones by how the transcript ends", async () => {
    const home = join(root, "home");
    writeTranscript(home, "s-done", [ask("fix the flaky upload test"), say("fixed", "end_turn"), ended("t-done")]);
    writeTranscript(home, "s-busy", [ask("add retries to the client"), say("working", "tool_use")], now - MIN);
    writeTranscript(home, "s-waiting", [ask("delete the old buckets"), say("may I?", "tool_use")], now - 2 * MIN);
    writeTranscript(home, "s-desktop", [ask("from the desktop app", { entrypoint: "claude-desktop" }), say("ok", "end_turn", { entrypoint: "claude-desktop" })]);
    writeTranscript(home, "s-program", [ask("driven by a program", { entrypoint: "sdk-cli" }), say("ok", "end_turn", { entrypoint: "sdk-cli" })]);
    writeTranscript(home, "s-old", [ask("last month"), say("ok", "end_turn")], now - 30 * 86_400_000);
    // A sub-agent's transcript sits a level down and is not a session of its own.
    mkdirSync(join(claudeProjectsRoot(home), "-work-api", "s-done", "subagents"), { recursive: true });
    writeFileSync(join(claudeProjectsRoot(home), "-work-api", "s-done", "subagents", "agent-1.jsonl"), ask("side work") + "\n");

    const ctx = ctxFor(home, [agent("s-busy", "busy"), agent("s-waiting", "waiting", { waitingFor: "permission prompt" })]);
    const rows = await readClaudeCli(ctx);
    expect(ctx.errors).toEqual([]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual(["s-busy", "s-done", "s-waiting"]);
    expect(byId.get("s-done")).toMatchObject({ app: "claude-cli", title: "fix the flaky upload test", cwd: "/work/api", open: { kind: "terminal", bin: "claude", sessionId: "s-done", cwd: "/work/api" } });
    expect(decide(byId.get("s-done")!.facts)).toMatchObject({ state: "done", turn: "t-done" });
    // Alive in some terminal: nothing to reopen, and the process says what it is doing.
    expect(byId.get("s-busy")).toMatchObject({ open: null });
    expect(decide(byId.get("s-busy")!.facts).state).toBe("running");
    expect(decide(byId.get("s-waiting")!.facts)).toMatchObject({ state: "needs-you", detail: "等你批一个权限" });
    expect(await claudeCliSource.present(home)).toBe(true);
  });

  it("still lists them when the live list cannot be had, each as its transcript last said", async () => {
    const home = join(root, "nolive");
    writeTranscript(home, "s-mid", [ask("add retries"), say("working", "tool_use")]);
    const ctx: ReadContext = { ...ctxFor(home), claudeAgents: async () => Promise.reject(new Error("spawn claude ENOENT")) };
    const rows = await readClaudeCli(ctx);
    expect(rows.map((r) => r.id)).toEqual(["s-mid"]);
    expect(decide(rows[0]!.facts).state).toBe("done");
    expect(ctx.errors).toEqual([]);
  });

  it("finds nothing, and nothing wrong, without Claude Code", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    expect(await readClaudeCli(ctxFor(bare))).toEqual([]);
    expect(await claudeCliSource.present(bare)).toBe(false);
  });
});
