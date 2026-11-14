// The DeepSeek Harness reader against stand-ins for its files: a checkpoint per session, and a log written the way
// the host writes it, one zstd frame per append.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { decide, decideAll, type ReadContext } from "../overview.js";
import { zstdAvailable, zstdFramesText } from "../util/zstd.js";
import { DSH_LOG, DSH_STALE_MS, deepseekSource, dshCacheDir, dshFacts, dshSessionsDir, dshTail, dshWorkspaceFile, readDeepseek, type DshSession } from "./deepseek.js";

const root = mkdtempSync(join(tmpdir(), "chancery-deepseek-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const now = Date.now();
const MIN = 60_000;
const compress = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;

type Ev = [type: string, data?: Record<string, unknown>];
const lines = (events: Ev[], firstSeq = 0): string => events.map(([type, data], i) => JSON.stringify({ type, seq: firstSeq + i, time: now, data: data ?? {} })).join("\n") + "\n";
const parsed = (events: Ev[]) => events.map(([type, data]) => ({ type, data: data ?? {} }));

const turnDone: Ev[] = [["turn/start", { turn: 1 }], ["step/start", { turn: 1, step: 1 }], ["step/end", { turn: 1, step: 1 }], ["turn/end", { turn: 1, reason: { kind: "completed" } }]];
const ask = (callId: string, question: string): Ev => ["tool/call", { callId, name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q1", question }] }) }];

describe("dshTail", () => {
  it("reads how the last turn ended", () => {
    expect(dshTail(parsed(turnDone))).toMatchObject({ turn: "closed", endKind: "completed" });
    expect(dshTail(parsed([...turnDone, ["turn/start", { turn: 2 }], ["turn/end", { turn: 2, reason: { kind: "error", error: { message: "503: no channel", code: "SERVER" } } }]]))).toMatchObject({ turn: "closed", endKind: "error", endError: "503: no channel" });
    expect(dshTail(parsed([["turn/start"], ["turn/end", { reason: { kind: "aborted", reason: { kind: "user" } } }], ["session/end-seed"]]))).toMatchObject({ turn: "closed", endKind: "aborted" });
    expect(dshTail(parsed([...turnDone, ["turn/start", { turn: 2 }], ["step/start"]]))).toMatchObject({ turn: "open", endKind: "" });
  });

  it("keeps a permission request until it is answered, and a question until its result comes", () => {
    const asked: Ev[] = [["turn/start"], ["tool/call", { callId: "c1", name: "bash", arguments: "{}" }], ["approval/asked", { id: "a1", toolName: "bash", callId: "c1", reason: "write outside the workspace" }]];
    expect(dshTail(parsed(asked)).approval).toBe("write outside the workspace");
    expect(dshTail(parsed([...asked, ["approval/decided", { id: "a1", outcome: "allowed-once" }]])).approval).toBeNull();
    expect(dshTail(parsed([["turn/start"], ask("c2", "Which database?")])).question).toBe("Which database?");
    expect(dshTail(parsed([["turn/start"], ask("c2", "Which database?"), ["tool/result", { message: { toolCallId: "c2" } }]])).question).toBeNull();
  });

  it("says a turn is at work when the slice has its events but neither boundary", () => {
    expect(dshTail(parsed([["step/start"], ["tool/call", { callId: "c1", name: "bash" }], ["tool/result", { message: { toolCallId: "c1" } }]]))).toMatchObject({ turn: null, working: true });
    expect(dshTail(parsed([["session/title", { title: "x" }]]))).toMatchObject({ turn: null, working: false });
  });
});

const session = (over: Partial<DshSession> = {}): DshSession => ({ open: false, endKind: "completed", endError: "", approval: null, question: null, asked: null, at: now - MIN, ...over });
const verdict = (s: DshSession, alive = true) => decide(dshFacts(s, now, alive));

describe("dshFacts", () => {
  it("reads a closed turn by how it ended", () => {
    expect(verdict(session()).state).toBe("done");
    expect(verdict(session({ endKind: "error", endError: "该模型暂时没有可用服务。\nrequest req_1" }))).toMatchObject({ state: "error", detail: "该模型暂时没有可用服务。" });
    expect(verdict(session({ endKind: "aborted" })).state).toBe("interrupted");
    expect(verdict(session({ endKind: "interrupted" })).state).toBe("interrupted");
    // No ending read, or the ending of the session this one was forked from: nothing is claimed.
    expect(verdict(session({ endKind: "" })).state).toBe("done");
    expect(dshFacts(session({ endKind: "forked" }), now, true).outcome).toBe("unknown");
  });

  it("reads an open turn as running, or as waiting on the person for a permission or an answer", () => {
    expect(verdict(session({ open: true, endKind: "" })).state).toBe("running");
    expect(verdict(session({ open: true, approval: "bash" }))).toMatchObject({ state: "needs-you", detail: "等你批一个权限" });
    expect(verdict(session({ open: true, question: "Which database?\nPick one." }))).toMatchObject({ state: "needs-you", detail: "Which database?" });
    // Waiting has no time limit: a question can sit there all afternoon.
    expect(verdict(session({ open: true, approval: "bash", at: now - DSH_STALE_MS - MIN })).state).toBe("needs-you");
  });

  it("takes an open turn as cut off when no host is alive, or when the log has gone quiet for a long time", () => {
    expect(verdict(session({ open: true }), false).state).toBe("interrupted");
    expect(verdict(session({ open: true, approval: "bash" }), false).state).toBe("interrupted");
    expect(verdict(session({ open: true, at: now - DSH_STALE_MS - MIN })).state).toBe("interrupted");
  });

  it("keeps a question the host still lists after the turn is over", () => {
    expect(verdict(session({ asked: "Ship it on Friday?" }))).toMatchObject({ state: "needs-you", detail: "Ship it on Friday?" });
  });
});

describe.skipIf(!zstdAvailable)("zstdFramesText", () => {
  const frames = ["one\n", "two\n", "three\nfour\n"].map((s) => compress(Buffer.from(s)));
  const whole = Buffer.concat(frames);

  it("reads frame after frame, from the start or from the middle of a frame", () => {
    expect(zstdFramesText(whole, true)).toBe("one\ntwo\nthree\nfour\n");
    // Cut into the first frame: reading picks up at the second.
    expect(zstdFramesText(whole.subarray(3), false)).toBe("two\nthree\nfour\n");
    expect(zstdFramesText(Buffer.from("not zstd at all"), false)).toBe("");
  });

  it("gives what there is of a last frame that is cut short: whole frames first, then at most a part of a line", () => {
    expect(zstdFramesText(whole.subarray(0, whole.length - 4), true)).toMatch(/^one\ntwo\n(?!three\nfour\n)/);
    expect(zstdFramesText(whole.subarray(3, whole.length - 4), false)).toMatch(/^two\n(?!three\nfour\n)/);
  });
});

const ctxFor = (home: string): ReadContext => ({ home, since: now - 14 * 86_400_000, now, lang: "zh", errors: [], claudeAgents: async () => [] });

interface Fixture {
  title?: string | null;
  cwd?: string;
  blank?: boolean;
  /** The checkpoint's own idea of whether a turn is open. */
  checkpointOpen?: boolean;
  active?: string;
  prompt?: string;
  parent?: string;
  /** The log, as the appends it was written in; none for a session with no log. */
  appends?: Ev[][];
  at?: number;
}

function writeSession(home: string, id: string, f: Fixture): void {
  const cwd = f.cwd ?? "/work/api";
  const at = new Date(f.at ?? now - 5 * MIN);
  const row = (val: unknown) => ({ ver: 1, seq: 9, val });
  mkdirSync(dshCacheDir(home), { recursive: true });
  const cache = join(dshCacheDir(home), `${id}.json`);
  writeFileSync(
    cache,
    JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: now - 60 * MIN, cwd },
        rows: {
          title: row(f.title === undefined ? "Untitled" : f.title),
          workingDirectory: row(cwd),
          sessionListMetadata: row({ blank: Boolean(f.blank), lastPromptAt: f.blank ? null : now - 6 * MIN }),
          turnBoundary: row({ openTurnStartSeq: f.checkpointOpen ? 4 : null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 1 }),
          turnOutline: row({ turns: f.prompt ? [{ turn: 1, seq: 2, prompt: f.prompt, response: "" }] : [], draft: "" }),
          userQuestions: row({ inheritedEventCount: 0, timed: true, questions: { active: f.active ? [{ callId: "c9", questions: [{ id: "q1", question: f.active }], state: "continued" }] : [], settled: [] } }),
        },
      },
    }),
  );
  utimesSync(cache, at, at);
  if (!f.appends) return;
  const dir = join(dshSessionsDir(home), `-${cwd.replaceAll("/", "-")}--`, id);
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: "session", version: 4, id, createdAt: now - 60 * MIN, cwd, ...(f.parent ? { parentSession: f.parent } : {}) }) + "\n";
  let seq = 0;
  const frames = [compress(Buffer.from(header)), ...f.appends.map((events) => compress(Buffer.from(lines(events, (seq += events.length) - events.length))))];
  writeFileSync(join(dir, DSH_LOG), Buffer.concat(frames));
  utimesSync(join(dir, DSH_LOG), at, at);
}

describe.skipIf(!zstdAvailable)("readDeepseek", () => {
  it("lists the sessions with their folder and title, each by the end of its log", async () => {
    const home = join(root, "home");
    writeSession(home, "session-done", { title: "Count the files\nsecond line", appends: [turnDone] });
    writeSession(home, "session-failed", { title: null, prompt: "Summarise the changelog", appends: [turnDone, [["turn/start", { turn: 2 }], ["turn/end", { turn: 2, reason: { kind: "error", error: { message: "max_tokens 超过模型输出上限" } } }]]] });
    writeSession(home, "session-stopped", { appends: [[["turn/start", { turn: 1 }], ["turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } }]], [["session/end-seed"]]] });
    // The checkpoint was written before the turn began; the log knows better.
    writeSession(home, "session-running", { appends: [turnDone, [["turn/start", { turn: 2 }], ["step/start", { turn: 2, step: 1 }]]], at: now - MIN });
    writeSession(home, "session-approve", { checkpointOpen: true, appends: [[["turn/start", { turn: 1 }], ["tool/call", { callId: "c1", name: "bash", arguments: "{}" }]], [["approval/asked", { id: "a1", toolName: "bash", callId: "c1", reason: "escalate sandbox" }]]] });
    writeSession(home, "session-question", { checkpointOpen: true, appends: [[["turn/start", { turn: 1 }], ask("c2", "Postgres or SQLite?")]] });
    writeSession(home, "session-asked", { active: "Ship it on Friday?", appends: [turnDone] });
    writeSession(home, "session-child", { title: "Look up the API", parent: "session-running", appends: [[["turn/start", { turn: 1 }], ["step/start", { turn: 1, step: 1 }]]], at: now - MIN });
    writeSession(home, "session-blank", { blank: true, title: null, appends: [] });
    writeSession(home, "session-archived", { appends: [turnDone] });
    writeSession(home, "session-old", { appends: [turnDone], at: now - 30 * 86_400_000 });
    // No log at all: the checkpoint still places the session, and nothing is said about how it ended.
    writeSession(home, "session-nolog", { title: "Only a checkpoint" });
    writeFileSync(dshWorkspaceFile(home), JSON.stringify({ global: { archivedSessionIds: ["session-archived"] }, tables: { workspaces: {} } }));

    const ctx = ctxFor(home);
    const rows = await readDeepseek(ctx, { running: async () => true });
    expect(ctx.errors).toEqual([]);
    const decided = new Map(decideAll(rows).map((r) => [r.id, r]));
    expect([...decided.keys()].sort()).toEqual(["session-approve", "session-asked", "session-child", "session-done", "session-failed", "session-nolog", "session-question", "session-running", "session-stopped"]);
    expect(decided.get("session-done")).toMatchObject({ app: "deepseek", title: "Count the files", cwd: "/work/api", state: "done", open: { kind: "app", app: "deepseek" }, parent: null });
    expect(decided.get("session-failed")).toMatchObject({ title: "Summarise the changelog", state: "error", detail: "max_tokens 超过模型输出上限" });
    expect(decided.get("session-stopped")?.state).toBe("interrupted");
    expect(decided.get("session-approve")).toMatchObject({ state: "needs-you", detail: "等你批一个权限" });
    expect(decided.get("session-question")).toMatchObject({ state: "needs-you", detail: "Postgres or SQLite?" });
    expect(decided.get("session-asked")).toMatchObject({ state: "needs-you", detail: "Ship it on Friday?" });
    expect(decided.get("session-nolog")).toMatchObject({ title: "Only a checkpoint", state: "done", basis: "turn closed, ending not read" });
    // A sub-session at work: its parent is waiting on it.
    expect(decided.get("session-child")).toMatchObject({ state: "running", parent: "deepseek:session-running" });
    expect(decided.get("session-running")?.state).toBe("running");

    // With no host alive, every open turn was cut off.
    const dead = new Map(decideAll(await readDeepseek(ctxFor(home), { running: async () => false })).map((r) => [r.id, r.state]));
    expect([dead.get("session-running"), dead.get("session-approve"), dead.get("session-question"), dead.get("session-done")]).toEqual(["interrupted", "interrupted", "interrupted", "done"]);
    expect(await deepseekSource.present(home)).toBe(true);
  });

  it("reads only the end of a long log, and falls back on the checkpoint when the end has no turn boundary", async () => {
    const home = join(root, "long");
    const noise = (n: number): Ev[][] => Array.from({ length: n }, (_, i): Ev[] => [["tool/call", { callId: `c${i}`, name: "bash", arguments: JSON.stringify({ command: `echo ${Math.random()}`.repeat(8) }) }], ["tool/result", { message: { toolCallId: `c${i}` } }]]);
    writeSession(home, "session-long-done", { appends: [[["turn/start", { turn: 1 }]], ...noise(60), [["turn/end", { turn: 1, reason: { kind: "completed" } }]]] });
    writeSession(home, "session-long-open", { checkpointOpen: true, appends: [[["turn/start", { turn: 1 }]], ...noise(60)], at: now - MIN });
    const rows = decideAll(await readDeepseek(ctxFor(home), { running: async () => true, tailBytes: 2_000 }));
    expect(new Map(rows.map((r) => [r.id, r.state]))).toEqual(new Map([["session-long-done", "done"], ["session-long-open", "running"]]));
  });

  it("finds nothing, and nothing wrong, without DeepSeek Harness", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    const ctx = ctxFor(bare);
    expect(await readDeepseek(ctx)).toEqual([]);
    expect(ctx.errors).toEqual([]);
    expect(await deepseekSource.present(bare)).toBe(false);
  });
});
