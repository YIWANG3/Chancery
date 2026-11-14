// Gemini CLI's reader against chat files written the way the CLI writes them.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide, type ReadContext } from "../overview.js";
import { geminiSource, readGemini } from "./gemini.js";

const root = mkdtempSync(join(tmpdir(), "chancery-gemini-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const now = Date.parse("2026-11-13T12:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function writeChat(home: string, project: string, dir: string | null, name: string, chat: Record<string, unknown>, mtime = now - HOUR): void {
  const chats = join(home, ".gemini", "tmp", project, "chats");
  mkdirSync(chats, { recursive: true });
  if (dir) writeFileSync(join(home, ".gemini", "tmp", project, ".project_root"), dir);
  const path = join(chats, name);
  writeFileSync(path, JSON.stringify(chat));
  utimesSync(path, mtime / 1000, mtime / 1000);
}

const ask = (text: string) => ({ type: "user", content: [{ text }] });
const reply = (text: string) => ({ type: "gemini", content: text });
const ctxFor = (home: string): ReadContext => ({ home, since: now - 14 * 24 * HOUR, now, lang: "zh", errors: [], claudeAgents: async () => [] });

describe("readGemini", () => {
  it("lists each project's chats with the project's directory, titled by the CLI's summary or else the first thing asked", async () => {
    const home = join(root, "home");
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    writeChat(home, "trade", "/work/trade", "session-2026-11-13T10-00-aaaa.json", { sessionId: id(1), kind: "main", lastUpdated: iso(now - HOUR), summary: "Backtest the strategy", messages: [ask("x"), reply("done")] });
    writeChat(home, "trade", "/work/trade", "session-2026-11-13T11-00-bbbb.json", { sessionId: id(2), kind: "main", lastUpdated: iso(now - 2 * HOUR), messages: [ask("  explain the fee model\nin detail"), reply("…"), ask("and the slippage?")] });
    writeChat(home, "trade", "/work/trade", "session-2026-11-13T11-30-cccc.json", { sessionId: id(3), kind: "subagent", lastUpdated: iso(now - HOUR), messages: [ask("x"), reply("y")] });
    writeChat(home, "trade", "/work/trade", "session-2026-10-01T00-00-dddd.json", { sessionId: id(4), kind: "main", lastUpdated: iso(now - 40 * 24 * HOUR), messages: [ask("x"), reply("y")] }, now - 40 * 24 * HOUR);
    writeChat(home, "trade", "/work/trade", "session-2026-11-13T11-40-eeee.json", { sessionId: id(5), kind: "main", lastUpdated: iso(now - HOUR), messages: [] });
    // An older layout: a directory per project hash with only a log in it, and no chats.
    mkdirSync(join(home, ".gemini", "tmp", "943747193786c5fb"), { recursive: true });
    writeFileSync(join(home, ".gemini", "tmp", "943747193786c5fb", "logs.json"), "[]");

    const ctx = ctxFor(home);
    const rows = await readGemini(ctx);
    expect(ctx.errors).toEqual([]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual([id(1), id(2)]);
    expect(byId.get(id(1))).toMatchObject({ app: "gemini", title: "Backtest the strategy", cwd: "/work/trade", at: now - HOUR, open: { kind: "terminal", bin: "gemini", sessionId: id(1), cwd: "/work/trade" } });
    expect(byId.get(id(2))).toMatchObject({ title: "explain the fee model" });
    // Ended on the model's reply: done. Ended on the person's message: nothing says what came of it, so no turn.
    expect(decide(byId.get(id(1))!.facts)).toMatchObject({ state: "done", turn: String(now - HOUR) });
    expect(decide(byId.get(id(2))!.facts)).toMatchObject({ state: "done", turn: "" });
    expect(await geminiSource.present(home)).toBe(true);
  });

  it("finds nothing, and nothing wrong, without the CLI", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    const ctx = ctxFor(bare);
    expect(await readGemini(ctx)).toEqual([]);
    expect(ctx.errors).toEqual([]);
    expect(await geminiSource.present(bare)).toBe(false);
  });
});
