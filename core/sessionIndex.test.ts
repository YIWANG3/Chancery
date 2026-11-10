import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionRow } from "./overview.js";
import type { SessionDigest } from "./sessionDigest.js";
import { createSessionIndex, searchSessions } from "./sessionIndex.js";

const root = mkdtempSync(join(tmpdir(), "chancery-index-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const row = (app: SessionRow["app"], id: string, title: string, at: number, detail = "", cwd = "/repo"): SessionRow => ({ app, id, title, at, detail, cwd, projectKey: "/repo", open: null, parent: null, state: "done", basis: "test", turn: "" });

describe("searchSessions", () => {
  const rows = [row("claude", "a", "液态玻璃样式透明度", 300), row("claude", "b", "新会话启动问题", 200, "薄纱已经调浓"), row("codex", "c", "调研 HEIC 解码", 100)];
  const digests: Record<string, SessionDigest> = {
    "claude:a": { turns: [{ at: 1, prompt: "浮窗的玻璃太透了", reply: "把薄纱加深到 50% 黑。" }], files: ["/repo/renderer/styles.css"], prs: [] },
    "claude:b": { turns: [{ at: 1, prompt: "新建会话点了没反应", reply: "是辅助功能权限没给。" }, { at: 2, prompt: "顺便看下液态玻璃", reply: "另一个会话在改 renderer/styles.css 里的薄纱。" }], files: [], prs: [] },
    "codex:c": { turns: [{ at: 1, prompt: "HEIC 有几种解码路径", reply: "sips、ImageIO、libheif 三种。" }], files: [], prs: [] },
  };
  const search = (q: string) => searchSessions(q, rows, (key) => digests[key] ?? null);

  it("puts a match in the title ahead of one in what was said, and that ahead of one in a reply", () => {
    expect(search("液态玻璃").map((h) => h.key)).toEqual(["claude:a", "claude:b"]);
    expect(search("薄纱").map((h) => [h.key, h.matches[0]!.where])).toEqual([
      ["claude:b", "detail"],
      ["claude:a", "reply"],
    ]);
  });

  it("wants every word, wherever each one is, and says where it found them", () => {
    const [hit, ...rest] = search("玻璃 STYLES.css");
    expect(rest.map((h) => h.key)).toEqual(["claude:b"]);
    expect(hit).toMatchObject({ key: "claude:a", matches: [{ where: "title", turn: null }, { where: "file", turn: null, snippet: "/repo/renderer/styles.css" }] });
    expect(search("玻璃 libheif")).toEqual([]);
  });

  it("gives the turn and the words around a match inside the conversation", () => {
    expect(search("imageio")[0]).toMatchObject({ key: "codex:c", matches: [{ where: "reply", turn: 1, snippet: "sips、ImageIO、libheif 三种。" }] });
    expect(search("顺便")[0]!.matches[0]).toMatchObject({ where: "prompt", turn: 2 });
  });

  it("finds a session by its title alone when its conversation could not be read", () => {
    expect(searchSessions("heic", rows, () => null).map((h) => h.key)).toEqual(["codex:c"]);
    expect(search("   ")).toEqual([]);
  });
});

describe("createSessionIndex", () => {
  const home = join(root, "home");
  const project = join(root, "repo");
  const indexDir = join(home, "Library", "Application Support", "Claude", "claude-code-sessions", "org", "user");
  const transcripts = join(home, ".claude", "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(transcripts, { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });

  const line = (type: "user" | "assistant", text: string) => `${JSON.stringify({ parentUuid: null, isSidechain: false, type, message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } })}\n`;
  const transcript = join(transcripts, "cli-one.jsonl");
  writeFileSync(join(indexDir, "local_one.json"), JSON.stringify({ sessionId: "local_one", cliSessionId: "cli-one", cwd: project, originCwd: project }));
  writeFileSync(join(indexDir, "local_lost.json"), JSON.stringify({ sessionId: "local_lost", cliSessionId: "cli-lost", cwd: project }));
  writeFileSync(transcript, line("user", "书记功能有做了吗") + line("assistant", "做了，而且是接通的。"));
  execFileSync("sqlite3", [
    join(home, ".codex", "thread_history_1.sqlite"),
    `CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, item_type TEXT, updated_at_ordinal INTEGER);
     INSERT INTO thread_items VALUES ('th1', 't1', 'i1', 1, 1000, '${JSON.stringify({ content: [{ type: "text", text: "对照 LobeHub 的任务模型" }] })}', 'userMessage', 1);`,
  ]);

  const rows = [row("claude", "local_one", "书记功能", Date.now()), row("claude", "local_lost", "记录已经没了的会话", Date.now()), row("codex", "th1", "LobeHub", Date.now()), row("codex", "th-empty", "还没说话的线程", Date.now())];
  const cachePath = join(root, "cache", "session-index.json");

  it("reads each session's conversation from its own app's files, and has none for one whose record is gone", async () => {
    const index = createSessionIndex({ home, cachePath });
    await index.sync(rows);
    expect(index.digest("claude:local_one")?.turns).toEqual([{ at: 0, prompt: "书记功能有做了吗", reply: "做了，而且是接通的。" }]);
    expect(index.digest("codex:th1")?.turns.map((t) => t.prompt)).toEqual(["对照 LobeHub 的任务模型"]);
    expect(index.digest("claude:local_lost")).toBeNull();
    expect(index.digest("codex:th-empty")).toBeNull();
    expect(index.search("接通", rows).map((h) => h.key)).toEqual(["claude:local_one"]);
    expect(index.search("没了", rows).map((h) => h.key)).toEqual(["claude:local_lost"]);
  });

  it("reads a session started in a terminal straight from its transcript, and leaves the other apps to their titles", async () => {
    writeFileSync(join(transcripts, "cli-term.jsonl"), line("user", "把上传的重试改成指数退避") + line("assistant", "改好了，上限 30 秒。"));
    const others = [row("claude-cli", "cli-term", "重试", Date.now(), "", project), row("cursor", "c-dark", "给落地页加暗色模式", Date.now())];
    const index = createSessionIndex({ home, cachePath: join(root, "cache", "others.json") });
    await index.sync(others);
    expect(index.digest("claude-cli:cli-term")?.turns).toEqual([{ at: 0, prompt: "把上传的重试改成指数退避", reply: "改好了，上限 30 秒。" }]);
    expect(index.digest("cursor:c-dark")).toBeNull();
    expect(index.search("指数退避", others).map((h) => h.key)).toEqual(["claude-cli:cli-term"]);
    expect(index.search("暗色模式", others).map((h) => h.key)).toEqual(["cursor:c-dark"]);
  });

  it("picks up what was said since the last sync", async () => {
    const index = createSessionIndex({ home, cachePath });
    await index.sync(rows);
    appendFileSync(transcript, line("user", "那目前是怎么用的") + line("assistant", "两个入口：记一条和自动分类。"));
    execFileSync("sqlite3", [join(home, ".codex", "thread_history_1.sqlite"), `INSERT INTO thread_items VALUES ('th1', 't1', 'i2', 2, 2000, '${JSON.stringify({ text: "它以工作项加多次运行为单位。", phase: "final_answer" })}', 'agentMessage', 2);`]);
    await index.sync(rows);
    expect(index.digest("claude:local_one")?.turns.map((t) => t.prompt)).toEqual(["书记功能有做了吗", "那目前是怎么用的"]);
    expect(index.digest("codex:th1")?.turns[0]!.reply).toBe("它以工作项加多次运行为单位。");
  });

  it("keeps what it read across a restart, even when the transcript has since been cleaned up", async () => {
    expect(Object.keys((JSON.parse(readFileSync(cachePath, "utf8")) as { sessions: Record<string, unknown> }).sessions).sort()).toEqual(["claude:local_lost", "claude:local_one", "codex:th-empty", "codex:th1"]);
    rmSync(transcript);
    const index = createSessionIndex({ home, cachePath });
    await index.sync(rows);
    expect(index.digest("claude:local_one")?.turns).toHaveLength(2);
  });
});
