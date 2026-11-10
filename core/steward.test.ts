// The steward's tools called the way a Claude or Codex conversation calls them: an MCP client on one end of an
// in-memory transport, the server the app serves on the other.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createChanceryMcpServer } from "./mcp.js";
import type { Overview, SessionApp, SessionRow, SessionState } from "./overview.js";
import { SESSION_APPS } from "./sessionApps.js";
import type { SessionDigest } from "./sessionDigest.js";
import { searchSessions, type SessionIndex } from "./sessionIndex.js";
import type { StewardConfirm, StewardDeps } from "./steward.js";

const AF = "/work/AfterFrame";
const CH = "/work/chancery-claude";
const at = Date.parse("2026-11-09T22:30:00");
const row = (app: SessionApp, id: string, projectKey: string, state: SessionState, title: string, detail = ""): SessionRow => ({ app, id, title, at, detail, cwd: projectKey, projectKey, open: null, parent: null, state, basis: "test", turn: "" });
const sessions = [
  row("claude", "local_heic", AF, "needs-you", "HEIC 缩略图偶尔是黑的", "要退回到 ImageIO 解码，还是只对 10-bit 走慢路径？"),
  row("codex", "th-cover", AF, "running", "给合集页生成封面图"),
  row("claude", "local_glass", CH, "done", "液态玻璃样式透明度", "薄纱加深已提交"),
];
const digests: Record<string, SessionDigest> = {
  "claude:local_heic": { turns: Array.from({ length: 8 }, (_, i) => ({ at: at + i, prompt: `第 ${i + 1} 问`, reply: i === 7 ? "sips 对 10-bit HEIC 返回空缓冲，两条路你选。" : `第 ${i + 1} 答` })), files: ["/work/AfterFrame/src/thumbs.ts"], prs: ["https://github.com/acme/afterframe/pull/201"] },
  "claude:local_glass": { turns: [{ at, prompt: "浮窗的玻璃太透了", reply: "深色 50% 黑、浅色 60% 白。" }], files: [], prs: [] },
};

const SOURCES = { ...Object.fromEntries(SESSION_APPS.map((a) => [a, false])), claude: true, codex: true } as Overview["sources"];
const overviewOf = (rows: SessionRow[]): Overview => ({
  sessions: rows,
  projects: [AF, CH].map((key) => ({ key, name: key.split("/").pop()!, dir: key, apps: ["claude"], sessions: 1, counts: {} as Overview["projects"][number]["counts"], lastAt: at })),
  readAt: at,
  errors: [],
  sources: SOURCES,
});

type Item = Record<string, unknown>;
interface Answer extends Item {
  sessions: Item[];
  hits: Item[];
  turns: Item[];
}

async function connect(over: Partial<StewardDeps> = {}) {
  const calls: Array<{ what: string; args: unknown[] }> = [];
  const asked: StewardConfirm[] = [];
  const overview = overviewOf(sessions);
  const digest = (key: string) => digests[key] ?? null;
  const index: SessionIndex = { sync: async () => {}, digest, search: (q, rows, limit) => searchSessions(q, rows, digest, limit), flush: async () => {} };
  const deps: StewardDeps = {
    overview: async () => overview,
    index,
    reply: async (...args) => void calls.push({ what: "reply", args }),
    startProjects: async () => ({ projects: [{ key: AF, name: "AfterFrame", label: "media-resource-management" }] }),
    start: async (...args) => void calls.push({ what: "start", args }),
    open: async (...args) => void calls.push({ what: "open", args }),
    confirm: async (what) => {
      asked.push(what);
      return true;
    },
    ...over,
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createChanceryMcpServer({ steward: deps });
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const raw = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
    return res.content[0]!.text;
  };
  /** A tool's answer when it is a sentence for the model to pass on. */
  const call = raw;
  /** A tool's answer when it is data. */
  const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(await raw(name, args)) as Answer;
  return { client, call, json, calls, asked };
}

describe("the steward's tools", () => {
  it("offers the session tools and none of the shelved ticket ones", async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["list_sessions", "open_session", "read_session", "reply_to_session", "search_sessions", "start_session"]);
    expect(client.getInstructions()).toContain("管理会话");
  });

  it("lists sessions, narrowed by what the person is asking about", async () => {
    const { call, json } = await connect();
    const all = await json("list_sessions");
    expect(all.total).toBe(3);
    expect(all.sessions[0]).toEqual({ id: "claude:local_heic", title: "HEIC 缩略图偶尔是黑的", app: "claude", project: "AfterFrame", state: "needs-you", group: "needs", detail: "要退回到 ImageIO 解码，还是只对 10-bit 走慢路径？", last_active: "2026-11-09 22:30", total_turns: 8 });
    expect((await json("list_sessions", { group: "running" })).sessions.map((s) => s.id)).toEqual(["codex:th-cover"]);
    expect((await json("list_sessions", { project: "chancery-claude" })).sessions.map((s) => s.id)).toEqual(["claude:local_glass"]);
    expect(await call("list_sessions", { project: "nope" })).toBe("没有叫「nope」的项目。有：AfterFrame、chancery-claude");
    // The snapshot the app keeps covers 14 days; asking for fewer narrows it.
    const old = await connect({ overview: async () => ({ sessions: [sessions[0]!, { ...sessions[2]!, at: at - 5 * 86_400_000 }], projects: [], readAt: at, errors: [], sources: SOURCES }) });
    expect((await old.json("list_sessions", { days: 3 })).sessions.map((s) => s.id)).toEqual(["claude:local_heic"]);
    expect((await old.json("list_sessions", { days: 7 })).sessions).toHaveLength(2);
  });

  it("finds a session by what was said in it and reads the turns back", async () => {
    const { call, json } = await connect();
    const found = await json("search_sessions", { query: "空缓冲" });
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]).toMatchObject({ id: "claude:local_heic", matches: [{ where: "reply", turn: 8 }] });

    const read = await json("read_session", { id: "claude:local_heic" });
    expect(read.total_turns).toBe(8);
    expect(read.turns.map((t) => t.turn)).toEqual([4, 5, 6, 7, 8]);
    expect(read.turns[4]).toMatchObject({ user: "第 8 问", reply: "sips 对 10-bit HEIC 返回空缓冲，两条路你选。" });
    expect(read.files_changed).toEqual(["/work/AfterFrame/src/thumbs.ts"]);
    expect(read.pull_requests).toEqual(["https://github.com/acme/afterframe/pull/201"]);

    const early = await json("read_session", { id: "claude:local_heic", from_turn: 1, turns: 2 });
    expect(early.turns.map((t) => t.user)).toEqual(["第 1 问", "第 2 问"]);

    const bare = await json("read_session", { id: "codex:th-cover" });
    expect(bare).toMatchObject({ total_turns: 0, turns: [] });
    expect(bare.note).toContain("读不到");
    expect(await call("read_session", { id: "claude:local_nope" })).toContain("没有 id 是 claude:local_nope 的会话");
  });

  it("sends a reply only after the person agreed, through the session's own app", async () => {
    const { call, calls, asked } = await connect();
    expect(await call("reply_to_session", { id: "claude:local_heic", text: "只对 10-bit 走慢路径" })).toContain("已发到「HEIC 缩略图偶尔是黑的」");
    expect(asked).toEqual([{ kind: "reply", target: "HEIC 缩略图偶尔是黑的", app: "claude", text: "只对 10-bit 走慢路径" }]);
    expect(calls).toEqual([{ what: "reply", args: [{ app: "claude", id: "local_heic", title: "HEIC 缩略图偶尔是黑的" }, "只对 10-bit 走慢路径"] }]);
  });

  it("lists, finds and opens another app's session by its title and state, and does not offer to reply into it", async () => {
    const cursor = row("cursor", "c-dark", AF, "needs-you", "给落地页加暗色模式", "等你批一个权限");
    const { call, json, calls, asked } = await connect({ overview: async () => overviewOf([cursor, ...sessions]) });
    expect((await json("list_sessions", { app: "cursor" })).sessions).toEqual([expect.objectContaining({ id: "cursor:c-dark", app: "cursor", state: "needs-you", group: "needs", detail: "等你批一个权限" })]);
    expect((await json("search_sessions", { query: "暗色模式" })).hits.map((h) => h.id)).toEqual(["cursor:c-dark"]);
    // Its conversation is not something this side can read, and the note says so rather than blaming a lost file.
    expect((await json("read_session", { id: "cursor:c-dark" })).note).toBe("Cursor 的会话正文读不了，只有上面的状态。");
    expect(await call("reply_to_session", { id: "cursor:c-dark", text: "批" })).toContain("是 Cursor 的会话，不能从这里回复");
    expect(asked).toEqual([]);
    expect(await call("open_session", { id: "cursor:c-dark" })).toBe("已打开「给落地页加暗色模式」。");
    expect(calls).toEqual([{ what: "open", args: [cursor] }]);
  });

  it("sends nothing when the person says no, and does not even ask about a session that is mid-turn", async () => {
    const declined = await connect({ confirm: async () => false });
    expect(await declined.call("reply_to_session", { id: "claude:local_heic", text: "好" })).toContain("没有同意");
    expect(declined.calls).toEqual([]);

    const running = await connect();
    expect(await running.call("reply_to_session", { id: "codex:th-cover", text: "好" })).toContain("还在跑");
    expect(running.asked).toEqual([]);
    expect(running.calls).toEqual([]);
  });

  it("says why when the app would not take the reply", async () => {
    const { call } = await connect({ reply: async () => Promise.reject(new Error("Claude 桌面端没有开着，先打开它。")) });
    expect(await call("reply_to_session", { id: "claude:local_heic", text: "好" })).toBe("没有发出去：Claude 桌面端没有开着，先打开它。");
  });

  it("starts a new session under the name the app's sidebar has for the project", async () => {
    const { call, calls, asked } = await connect();
    expect(await call("start_session", { app: "codex", project: "afterframe", prompt: "调研 libheif" })).toContain("已在 codex 的「AfterFrame」里开了新会话");
    expect(asked).toEqual([{ kind: "start", target: "AfterFrame", app: "codex", text: "调研 libheif" }]);
    expect(calls).toEqual([{ what: "start", args: [{ app: "codex", project: "media-resource-management", worktree: undefined }, "调研 libheif"] }]);
    expect(await call("start_session", { app: "codex", project: "notes", prompt: "x" })).toContain("能开的：AfterFrame");
  });
});
