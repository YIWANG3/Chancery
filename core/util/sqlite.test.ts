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
    // What a plain read-only open does with this depends on the sqlite3 build: Apple's refuses it, others create the
    // two side files. The reader must not depend on either, so the probe is only reported, and whatever it left
    // behind is removed before the real read.
    let plainOpen = "works";
    try {
      execFileSync("sqlite3", ["-readonly", db, "SELECT count(*) FROM t"], { stdio: "pipe" });
      if (existsSync(`${db}-shm`)) plainOpen = "works and creates -shm";
    } catch {
      plainOpen = "fails";
    }
    for (const side of ["-wal", "-shm"]) rmSync(`${db}${side}`, { force: true });
    console.log(`sqlite3 -readonly on an idle WAL database ${plainOpen} on this build`);

    expect(await sqliteJson<{ id: number; name: string }>(db, "SELECT id, name FROM t ORDER BY id")).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    expect(existsSync(`${db}-shm`)).toBe(false);
    expect(existsSync(`${db}-wal`)).toBe(false);
  });

  it("reads through the write-ahead log while the owner's side files are present", async () => {
    const db = join(dir, "live.sqlite");
    execFileSync("sqlite3", [db, "PRAGMA journal_mode=WAL; CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);"]);
    // Apple's sqlite3 leaves -wal and -shm behind after the last connection closes; the row from the second insert
    // sits in the -wal until a checkpoint, so reading it proves the plain open was used.
    execFileSync("sqlite3", [db, "PRAGMA wal_autocheckpoint=0; INSERT INTO t VALUES (2);"]);
    if (!existsSync(`${db}-shm`)) return; // this sqlite3 build cleans up after itself; nothing to prove here
    expect(await sqliteJson<{ id: number }>(db, "SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
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
