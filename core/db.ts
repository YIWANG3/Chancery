import pg from "pg";
import { migrations } from "./migrations/index.js";

const { Pool, Client } = pg;
// bigserial/bigint come back as strings by default; our ids fit in a double.
pg.types.setTypeParser(20, (v) => Number(v));
// timestamptz/timestamp come back as Date objects by default. The types say ISO strings, and the renderer
// receives rows over IPC and sorts them with localeCompare, so hand out strings everywhere.
for (const oid of [1184, 1114]) pg.types.setTypeParser(oid, (v) => new Date(v).toISOString());

export interface Db {
  pool: pg.Pool;
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
  /** Runs fn inside one transaction; rolls back on throw. */
  tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  /** Subscribes to the `chancery` channel the schema's triggers notify. Returns an unsubscribe. The connection is
   *  re-established with backoff when it drops; onReconnect fires after each successful re-subscribe so the caller
   *  can catch up on notifications it missed. */
  listen(onNotify: (payload: string) => void, onReconnect?: () => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export function createDb(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 8 });
  return {
    pool,
    query: (text, params) => pool.query(text, params as never),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async listen(onNotify, onReconnect) {
      let closed = false;
      let client: pg.Client | null = null;
      let reconnecting = false;
      const connect = async () => {
        const c = new Client({ connectionString });
        c.on("notification", (msg) => onNotify(msg.payload ?? ""));
        c.on("error", () => void reconnect());
        c.on("end", () => void reconnect());
        await c.connect();
        await c.query("LISTEN chancery");
        client = c;
      };
      const reconnect = async () => {
        if (closed || reconnecting) return;
        reconnecting = true;
        const old = client;
        client = null;
        old?.end().catch(() => {});
        let delay = 1_000;
        while (!closed) {
          await new Promise((r) => setTimeout(r, delay));
          try {
            await connect();
            onReconnect?.();
            break;
          } catch {
            delay = Math.min(delay * 2, 30_000);
          }
        }
        reconnecting = false;
      };
      await connect();
      return async () => {
        closed = true;
        await client?.end().catch(() => {});
      };
    },
    close: () => pool.end(),
  };
}

/** Applies every migration not yet recorded, in order, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migration (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM schema_migration`);
  const done = new Set(rows.map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await db.tx(async (c) => {
      await c.query(m.sql);
      await c.query(`INSERT INTO schema_migration (id) VALUES ($1)`, [m.id]);
    });
    applied.push(m.id);
  }
  return applied;
}
