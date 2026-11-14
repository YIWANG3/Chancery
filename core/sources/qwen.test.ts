// The Qwen Code reader against transcripts written the way the CLI writes them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide, type ReadContext } from "../overview.js";
import { qwenProjectsRoot, qwenSource, readQwen } from "./qwen.js";

const root = mkdtempSync(join(tmpdir(), "chancery-qwen-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const now = Date.now();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const line = (type: string, uuid: string, at: number, parts: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ uuid, sessionId: "s", timestamp: iso(at), type, cwd: "/work/shop", message: { role: type === "assistant" ? "model" : "user", parts }, ...extra });
const telemetry = (uuid: string, at: number) => JSON.stringify({ uuid, sessionId: "s", timestamp: iso(at), type: "system", subtype: "ui_telemetry", cwd: "/work/shop", systemPayload: {} });

function writeChat(home: string, id: string, lines: string[], title?: string): void {
  const chats = join(qwenProjectsRoot(home), "-work-shop", "chats");
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(chats, `${id}.jsonl`), lines.join("\n") + "\n");
  if (title) writeFileSync(join(chats, `${id}.title.json`), JSON.stringify({ version: 1, displayName: title, source: "prompt" }));
}

const ctxFor = (home: string): ReadContext => ({ home, since: now - 14 * 86_400_000, now, lang: "zh", errors: [], claudeAgents: async () => [] });

describe("readQwen", () => {
  it("lists each chat with its directory and name, and says only how the transcript ends", async () => {
    const home = join(root, "home");
    const a = "00000000-0000-4000-8000-00000000000a";
    const b = "00000000-0000-4000-8000-00000000000b";
    const c = "00000000-0000-4000-8000-00000000000c";
    writeChat(home, a, [line("user", "u1", now - 10 * MIN, [{ text: "tidy the cart reducer" }]), telemetry("t1", now - 10 * MIN), line("assistant", "a1", now - 9 * MIN, [{ text: "done" }]), telemetry("t2", now - 9 * MIN)], "Tidy the cart reducer");
    // No title file: the first thing asked names it. It stopped on a tool call, which says nothing of what came next.
    writeChat(home, b, [line("user", "u1", now - 5 * MIN, [{ text: "run the migration\nand report" }]), line("assistant", "a1", now - 4 * MIN, [{ functionCall: { name: "run_shell_command", args: {} } }])]);
    writeChat(home, c, [telemetry("t1", now - MIN)]);

    const ctx = ctxFor(home);
    const rows = await readQwen(ctx);
    expect(ctx.errors).toEqual([]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual([a, b, c]);
    expect(byId.get(a)).toMatchObject({ app: "qwen", title: "Tidy the cart reducer", cwd: "/work/shop", open: { kind: "terminal", bin: "qwen", sessionId: a, cwd: "/work/shop" } });
    expect(Math.abs(byId.get(a)!.at - (now - 9 * MIN))).toBeLessThan(1000);
    expect(decide(byId.get(a)!.facts)).toMatchObject({ state: "done", turn: "a1" });
    expect(byId.get(b)).toMatchObject({ title: "run the migration" });
    expect(decide(byId.get(b)!.facts)).toMatchObject({ state: "done", turn: "" });
    expect(await qwenSource.present(home)).toBe(true);
  });

  it("finds nothing, and nothing wrong, without Qwen Code", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    const ctx = ctxFor(bare);
    expect(await readQwen(ctx)).toEqual([]);
    expect(ctx.errors).toEqual([]);
    expect(await qwenSource.present(bare)).toBe(false);
  });
});
