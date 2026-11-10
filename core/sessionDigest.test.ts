import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PROMPT_MAX, cleanClaudePrompt, digestCodexItems, emptyDigest, feedClaudeLine, findClaudeTranscript, readClaudeDigest, readCodexDigest, codexStamps } from "./sessionDigest.js";

const root = mkdtempSync(join(tmpdir(), "chancery-digest-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Lines in the shapes the CLI writes them (2026-11): conversation lines lead with parentUuid, its own bookkeeping
// with the type.
const user = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content }, timestamp: "2026-11-09T10:00:00.000Z", ...extra });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ parentUuid: "p", isSidechain: false, message: { role: "assistant", content }, type: "assistant", ...extra });
const say = (text: string) => assistant([{ type: "text", text }]);
const use = (name: string, input: Record<string, unknown>) => assistant([{ type: "tool_use", id: "toolu_1", name, input }]);
const toolResult = (text: string) => user([{ tool_use_id: "toolu_1", type: "tool_result", content: text }]);

function digestOf(lines: string[]) {
  const d = emptyDigest();
  for (const l of lines) feedClaudeLine(d, l);
  return d;
}

describe("cleanClaudePrompt", () => {
  it("keeps what was typed and drops what the app wrapped around it", () => {
    expect(cleanClaudePrompt("<system-reminder>\nthe date is…\n</system-reminder>\n书记功能有做了吗？")).toBe("书记功能有做了吗？");
    expect(cleanClaudePrompt("<command-message>code-review</command-message>\n<command-name>/code-review</command-name>\n<command-args>high</command-args>")).toBe("/code-review high");
  });

  it("is empty for messages nobody typed", () => {
    for (const s of ["<local-command-stdout>ok</local-command-stdout>", "<task-notification>done</task-notification>", "[Request interrupted by user]", "<system-reminder>only this</system-reminder>"]) expect(cleanClaudePrompt(s)).toBe("");
  });
});

describe("feedClaudeLine", () => {
  it("makes a turn of each message the person sent, ending on the last thing said in it", () => {
    const d = digestOf([
      user("先看一下书记是怎么接的"),
      say("我先读一下代码。"),
      use("Read", { file_path: "/repo/core/clerk.ts" }),
      toolResult("…file contents…"),
      say("接在守护进程和「记一条」上。"),
      user([{ type: "image", source: { type: "base64", data: "AAAA" } }, { type: "text", text: "那这张图里的设置呢" }]),
      say("那四项都在起作用。"),
    ]);
    expect(d.turns).toEqual([
      { at: Date.parse("2026-11-09T10:00:00.000Z"), prompt: "先看一下书记是怎么接的", reply: "接在守护进程和「记一条」上。" },
      { at: Date.parse("2026-11-09T10:00:00.000Z"), prompt: "那这张图里的设置呢", reply: "那四项都在起作用。" },
    ]);
  });

  it("leaves out tool output, the app's own notes, a sub-agent's side chain and the CLI's request log", () => {
    const d = digestOf([
      user("做一下"),
      toolResult("a line that mentions 做一下 again"),
      user([{ type: "text", text: "[Image: source: /tmp/1.png]" }], { isMeta: true }),
      user("This session is being continued…", { isCompactSummary: true }),
      user("sub-agent prompt", { isSidechain: true }),
      assistant([{ type: "text", text: "sub-agent talking" }], { isSidechain: true }),
      JSON.stringify({ type: "api-request-blob", message: { role: "user", content: [{ type: "text", text: "做一下" }] } }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "做一下" }),
      "not json at all",
    ]);
    expect(d.turns).toEqual([{ at: expect.any(Number), prompt: "做一下", reply: "" }]);
  });

  it("records the files the session wrote, each once and the latest last, and the pull requests it mentions", () => {
    const d = digestOf([
      user("改吧"),
      use("Edit", { file_path: "/repo/a.ts", old_string: "x", new_string: "y" }),
      use("Write", { file_path: "/repo/b.ts", content: "…" }),
      use("Bash", { command: "rm -rf build" }),
      use("Edit", { file_path: "/repo/a.ts", old_string: "y", new_string: "z" }),
      toolResult("https://github.com/acme/app/pull/12"),
      say("开了 https://github.com/acme/app/pull/12 。"),
    ]);
    expect(d.files).toEqual(["/repo/b.ts", "/repo/a.ts"]);
    expect(d.prs).toEqual(["https://github.com/acme/app/pull/12"]);
  });

  it("cuts a very long message and says so with an ellipsis", () => {
    const d = digestOf([user("长".repeat(PROMPT_MAX + 50))]);
    expect(d.turns[0]!.prompt).toHaveLength(PROMPT_MAX + 1);
    expect(d.turns[0]!.prompt.endsWith("…")).toBe(true);
  });
});

describe("readClaudeDigest", () => {
  it("reads on from where it stopped, and leaves a line still being written for the next read", async () => {
    const path = join(root, "grow.jsonl");
    writeFileSync(path, `${user("第一句")}\n${say("第一答")}\n`);
    const first = await readClaudeDigest(path);
    expect(first.digest.turns).toEqual([{ at: expect.any(Number), prompt: "第一句", reply: "第一答" }]);

    const half = user("第二句");
    appendFileSync(path, `${say("第一答，改口了")}\n${half.slice(0, 20)}`);
    const second = await readClaudeDigest(path, first);
    expect(second.digest.turns).toEqual([{ at: expect.any(Number), prompt: "第一句", reply: "第一答，改口了" }]);
    expect(first.digest.turns[0]!.reply).toBe("第一答"); // the state handed in is not written to

    appendFileSync(path, `${half.slice(20)}\n`);
    const third = await readClaudeDigest(path, second);
    expect(third.digest.turns.map((t) => t.prompt)).toEqual(["第一句", "第二句"]);
    expect(third.offset).toBe(Buffer.byteLength(`${user("第一句")}\n${say("第一答")}\n${say("第一答，改口了")}\n${half}\n`));
  });

  it("starts over when the file is shorter than what was read", async () => {
    const path = join(root, "rewritten.jsonl");
    writeFileSync(path, `${user("旧的一句，很长很长很长")}\n${say("旧答")}\n`);
    const first = await readClaudeDigest(path);
    writeFileSync(path, `${user("新的")}\n`);
    const second = await readClaudeDigest(path, first);
    expect(second.digest.turns.map((t) => t.prompt)).toEqual(["新的"]);
  });
});

describe("findClaudeTranscript", () => {
  it("looks under the directories the app records first, then under every project folder", async () => {
    const home = join(root, "home");
    const filed = join(home, ".claude", "projects", "-work-repo--claude-worktrees-x");
    mkdirSync(filed, { recursive: true });
    writeFileSync(join(filed, "cli-1.jsonl"), "");
    expect(await findClaudeTranscript("cli-1", ["/work/repo/.claude/worktrees/x", "/work/repo"], home)).toBe(join(filed, "cli-1.jsonl"));
    expect(await findClaudeTranscript("cli-1", ["/work/repo", null], home)).toBe(join(filed, "cli-1.jsonl"));
    expect(await findClaudeTranscript("cli-gone", ["/work/repo"], home)).toBeNull();
  });
});

describe("Codex", () => {
  it("folds a thread's items into turns", () => {
    const d = digestCodexItems([
      { turn_id: "t1", at: 100, type: "userMessage", body: "把这三张图建成一个文件夹" },
      { turn_id: "t1", at: 110, type: "fileChange", body: JSON.stringify(["/repo/README.md"]) },
      { turn_id: "t1", at: 120, type: "agentMessage", body: "已建好，见 https://github.com/acme/app/pull/7" },
      { turn_id: "t2", at: 200, type: "userMessage", body: "再加一张" },
      { turn_id: "t2", at: 205, type: "userMessage", body: "就是 38713" },
      { turn_id: "t2", at: 210, type: "agentMessage", body: null },
    ]);
    expect(d).toEqual({
      turns: [
        { at: 100, prompt: "把这三张图建成一个文件夹", reply: "已建好，见 https://github.com/acme/app/pull/7" },
        { at: 200, prompt: "再加一张\n就是 38713", reply: "" },
      ],
      files: ["/repo/README.md"],
      prs: ["https://github.com/acme/app/pull/7"],
    });
  });

  it("reads the text out of the history database and leaves images, diffs and commentary there", async () => {
    const home = join(root, "codex-home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const item = (thread: string, turn: string, ord: number, type: string, json: unknown) => `INSERT INTO thread_items VALUES ('${thread}', '${turn}', 'i${ord}', ${ord}, ${ord * 1000}, '${JSON.stringify(json).replace(/'/g, "''")}', '${type}', ${ord});`;
    execFileSync("sqlite3", [
      join(home, ".codex", "thread_history_1.sqlite"),
      [
        "CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, item_type TEXT, updated_at_ordinal INTEGER);",
        item("th1", "t1", 1, "userMessage", { type: "userMessage", content: [{ type: "localImage", path: "/tmp/a.png" }, { type: "text", text: "看看这张图" }] }),
        item("th1", "t1", 2, "agentMessage", { type: "agentMessage", text: "我先看一下。", phase: "commentary" }),
        item("th1", "t1", 3, "fileChange", { type: "fileChange", changes: [{ path: "/repo/x.ts", diff: "@@ a very long diff" }] }),
        item("th1", "t1", 4, "agentMessage", { type: "agentMessage", text: "图里是设置页。", phase: "final_answer" }),
        item("th2", "t9", 1, "userMessage", { type: "userMessage", content: [{ type: "text", text: "另一个线程" }] }),
      ].join("\n"),
    ]);
    expect(await readCodexDigest("th1", home)).toEqual({ turns: [{ at: 1000, prompt: "看看这张图", reply: "图里是设置页。" }], files: ["/repo/x.ts"], prs: [] });
    const stamps = await codexStamps(["th1", "th2", "th-none"], home);
    expect([...stamps.keys()].sort()).toEqual(["th1", "th2"]);
    expect(stamps.get("th1")).not.toBe(stamps.get("th2"));
  });
});
