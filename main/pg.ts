// The app's own Postgres: an embedded cluster under userData, localhost only. Settings can point at an
// external server instead, in which case nothing here is started.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as embeddedPostgresModule from "embedded-postgres";

// The package is ESM with a default export; bundled to CJS the namespace lands one level deeper.
type EmbeddedPostgresCtor = typeof import("embedded-postgres").default;
const EmbeddedPostgres = ((embeddedPostgresModule as unknown as { default?: { default?: EmbeddedPostgresCtor } & EmbeddedPostgresCtor }).default?.default ??
  (embeddedPostgresModule as unknown as { default?: EmbeddedPostgresCtor }).default ??
  embeddedPostgresModule) as EmbeddedPostgresCtor;

export interface PgHandle {
  connectionString: string;
  embedded: boolean;
  stop(): Promise<void>;
}

const USER = "chancery";
const PASSWORD = "chancery";
const DBNAME = "chancery";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A postmaster.pid left behind by a crash (dead pid) is removed; a live one from an earlier run of this app is
 *  stopped, since the cluster under our userData belongs to nobody else. */
async function clearPreviousServer(dataDir: string, log: (m: string) => void): Promise<void> {
  const pidFile = join(dataDir, "postmaster.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (Number.isFinite(pid) && alive()) {
    log(`stopping postgres ${pid} left by a previous run`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 40 && alive(); i++) await sleep(250);
    if (alive()) throw new Error(`postgres ${pid} from a previous run did not stop`);
  } else {
    log("removing stale postmaster.pid");
  }
  rmSync(pidFile, { force: true });
}

export async function startPg(opts: { dataDir: string; port: number; external?: string; log?: (m: string) => void }): Promise<PgHandle> {
  const log = opts.log ?? (() => {});
  if (opts.external) return { connectionString: opts.external, embedded: false, stop: async () => {} };

  await clearPreviousServer(opts.dataDir, log);
  const pg = new EmbeddedPostgres({
    databaseDir: opts.dataDir,
    user: USER,
    password: PASSWORD,
    port: opts.port,
    persistent: true,
    autoRehydrateSymlinks: true,
    onLog: () => {},
    onError: (m: unknown) => log(`pg: ${String(m).trim()}`),
  });
  if (!existsSync(join(opts.dataDir, "PG_VERSION"))) {
    log(`initialising cluster at ${opts.dataDir}`);
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase(DBNAME);
  } catch (err) {
    if (!/already exists/.test(String(err))) throw err;
  }
  return {
    connectionString: `postgres://${USER}:${PASSWORD}@127.0.0.1:${opts.port}/${DBNAME}`,
    embedded: true,
    stop: () => pg.stop(),
  };
}
