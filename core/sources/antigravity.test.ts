// The Antigravity reader against lists built the way its bytes are laid out: protobuf, with the summary base64
// inside the editor's state database and bare in the earlier app's own file.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide, type ReadContext } from "../overview.js";
import { protoFields, protoNumber, protoText } from "../util/protobuf.js";
import { ANTIGRAVITY_RUNNING_MS, antigravityHubFile, antigravitySource, antigravityStateDbs, readAntigravity } from "./antigravity.js";

const root = mkdtempSync(join(tmpdir(), "chancery-antigravity-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A protobuf writer just big enough for the test's messages.
const varint = (n: number): Buffer => {
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.push((v % 128) | (v >= 128 ? 0x80 : 0));
    v = Math.floor(v / 128);
  } while (v > 0);
  return Buffer.from(bytes);
};
const num = (field: number, value: number) => Buffer.concat([varint(field * 8), varint(value)]);
const bytes = (field: number, value: Buffer | string) => {
  const b = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([varint(field * 8 + 2), varint(b.length), b]);
};

const now = Date.now();
const MIN = 60_000;
const summary = (s: { title: string; at: number; status?: number; dir?: string }) =>
  Buffer.concat([bytes(1, s.title), num(2, 12), bytes(3, num(1, Math.floor(s.at / 1000))), num(5, s.status ?? 1), ...(s.dir ? [bytes(9, bytes(1, `file://${s.dir}`))] : []), num(22, 4)]);
const stateList = (entries: Array<{ id: string; summary: Buffer }>) => Buffer.concat(entries.map((e) => bytes(1, Buffer.concat([bytes(1, e.id), bytes(2, bytes(1, e.summary.toString("base64")))])))).toString("base64");
const hubList = (entries: Array<{ id: string; summary: Buffer }>) => Buffer.concat(entries.map((e) => bytes(1, Buffer.concat([bytes(1, e.id), bytes(2, e.summary)]))));

describe("protoFields", () => {
  it("reads numbers, text and nested messages by field number, and refuses bytes that are not a message", () => {
    const fields = protoFields(Buffer.concat([bytes(1, "标题"), num(5, 300), bytes(9, bytes(1, "inner"))]));
    expect(protoText(fields, 1)).toBe("标题");
    expect(protoNumber(fields, 5)).toBe(300);
    expect(protoText(protoFields(fields.find((f) => f.field === 9)!.bytes!), 1)).toBe("inner");
    expect(() => protoFields(Buffer.from([0x0a, 0x7f, 0x01]))).toThrow();
  });
});

const ctxFor = (home: string): ReadContext => ({ home, since: now - 14 * 86_400_000, now, lang: "zh", errors: [], claudeAgents: async () => [] });

describe("readAntigravity", () => {
  it("lists the conversations in every index it keeps, once each, with the folder each ran in", async () => {
    const home = join(root, "home");
    const [ide] = antigravityStateDbs(home);
    mkdirSync(dirname(ide!), { recursive: true });
    const value = stateList([
      { id: "c-plan", summary: summary({ title: "Plan the migration\nsecond line", at: now - 20 * MIN, dir: "/work/shop" }) },
      { id: "c-live", summary: summary({ title: "Fix the checkout", at: now - 2 * MIN, status: 2, dir: "/work/shop" }) },
      { id: "c-stale", summary: summary({ title: "Left running", at: now - ANTIGRAVITY_RUNNING_MS - 5 * MIN, status: 2, dir: "/work/shop" }) },
      { id: "c-old", summary: summary({ title: "Last month", at: now - 30 * 86_400_000, dir: "/work/shop" }) },
      { id: "c-both", summary: summary({ title: "Newer copy", at: now - 5 * MIN, dir: "/work/blog" }) },
    ]);
    execFileSync("sqlite3", [ide!, `CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT); INSERT INTO ItemTable VALUES ('antigravityUnifiedStateSync.trajectorySummaries', '${value}');`], { stdio: "pipe" });
    mkdirSync(dirname(antigravityHubFile(home)), { recursive: true });
    writeFileSync(antigravityHubFile(home), hubList([{ id: "c-both", summary: summary({ title: "Older copy", at: now - 50 * MIN, dir: "/work/blog" }) }, { id: "c-hub", summary: summary({ title: "Only in the earlier app", at: now - 60 * MIN }) }]));

    const ctx = ctxFor(home);
    const rows = await readAntigravity(ctx);
    expect(ctx.errors).toEqual([]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual(["c-both", "c-hub", "c-live", "c-plan", "c-stale"]);
    expect(byId.get("c-plan")).toMatchObject({ app: "antigravity", title: "Plan the migration", cwd: "/work/shop", open: null });
    expect(Math.abs(byId.get("c-plan")!.at - (now - 20 * MIN))).toBeLessThan(1000);
    expect(byId.get("c-both")).toMatchObject({ title: "Newer copy" });
    expect(byId.get("c-hub")).toMatchObject({ cwd: "" });
    // Status 2 is taken as running only while the conversation has moved recently; everything else is at rest.
    expect(decide(byId.get("c-live")!.facts).state).toBe("running");
    expect(decide(byId.get("c-stale")!.facts).state).toBe("done");
    expect(decide(byId.get("c-plan")!.facts).state).toBe("done");
    expect(await antigravitySource.present(home)).toBe(true);
  });

  it("finds nothing, and nothing wrong, without Antigravity", async () => {
    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    const ctx = ctxFor(bare);
    expect(await readAntigravity(ctx)).toEqual([]);
    expect(ctx.errors).toEqual([]);
    expect(await antigravitySource.present(bare)).toBe(false);
  });
});
