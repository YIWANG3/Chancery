import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sqliteJson } from "./sqlite.js";

const dir = mkdtempSync(join(tmpdir(), "chancery-sqlite-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sqliteJson", () => {
  it("reads a WAL database whose owner has no connection open, without creating anything next to it", async () => {
    // What the Codex app leaves behind when idle: WAL mode in the header, no -wal and no -shm on disk. A plain
    // read-only open of this fails with "unable to open database file".
    const db = join(dir, "idle #1?.sqlite");
    execFileSync("sqlite3", [db, "PRAGMA journal_mode=WAL; CREATE TABLE t (id INTEGER, name TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b'); PRAGMA wal_checkpoint(TRUNCATE);"]);
    // The sqlite3 that macOS ships keeps the two side files after its last connection closes; the Codex app's
    // own SQLite removes them. Everything is checkpointed into the main file, so removing them loses nothing.
    for (const side of ["-wal", "-shm"]) rmSync(`${db}${side}`, { force: true });
    // Whether the plain read-only open refuses this depends on the sqlite3 build (it does on the macOS releases the
    // Codex app runs on; a newer build on CI opens it). Either way the read below must work and leave no side files,
    // so the probe only tells which path is being exercised; it is not asserted.
    let plainOpenFails = false;
    try {
      execFileSync("sqlite3", ["-readonly", db, "SELECT count(*) FROM t"], { stdio: "pipe" });
    } catch {
      plainOpenFails = true;
    }
    for (const side of ["-wal", "-shm"]) rmSync(`${db}${side}`, { force: true });
    console.log(`sqlite3 read-only open of an idle WAL database ${plainOpenFails ? "fails here: the immutable fallback is exercised" : "works here: the fallback is not exercised"}`);

    expect(await sqliteJson<{ id: number; name: string }>(db, "SELECT id, name FROM t ORDER BY id")).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    expect(existsSync(`${db}-shm`)).toBe(false);
    expect(existsSync(`${db}-wal`)).toBe(false);
  });

  it("still fails for a file that is not there", async () => {
    await expect(sqliteJson(join(dir, "missing.sqlite"), "SELECT 1")).rejects.toThrow();
  });

  it("returns no rows for an empty result", async () => {
    const db = join(dir, "empty.sqlite");
    execFileSync("sqlite3", [db, "CREATE TABLE t (id INTEGER);"]);
    expect(await sqliteJson(db, "SELECT id FROM t")).toEqual([]);
  });
});
