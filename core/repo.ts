import type { Db } from "./db.js";
import type { Assignment, Event, EventKind, Project, Ticket, TicketStatus } from "./types.js";
import { TICKET_STATUSES } from "./types.js";
import { readProjectFromDir } from "./project.js";

export interface Repo {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  registerProject(dir: string, worktreeRoot: string): Promise<Project>;
  updateProject(id: string, patch: Partial<Pick<Project, "name" | "default_executor" | "default_model" | "parallel" | "github_sync">>): Promise<Project>;

  listTickets(filter?: { projectId?: string; status?: TicketStatus[] }): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket | null>;
  createTicket(input: { projectId: string; title: string; body?: string; kind?: Ticket["kind"]; priority?: number; status?: TicketStatus; source?: string; externalRef?: string | null; actor?: string }): Promise<Ticket>;
  updateTicket(id: string, patch: Partial<Pick<Ticket, "title" | "body" | "kind" | "priority" | "area" | "spec_path" | "executor" | "model" | "auto_merge">>): Promise<Ticket>;
  setStatus(id: string, status: TicketStatus, actor: string, note?: string, extra?: Record<string, unknown>): Promise<Ticket>;

  addEvent(input: { ticketId: string; assignmentId?: string | null; actor: string; kind: EventKind; payload?: Record<string, unknown>; externalId?: string | null }): Promise<Event>;
  listEvents(ticketId: string): Promise<Event[]>;

  /** Claims one ready ticket, atomically marking it in-progress. Null when nothing is claimable. `executors` is the
   *  set not in backoff: a ticket pinned to another backend waits; an unpinned one is claimed if any is available. */
  claimReady(opts: { projectId?: string; executors?: string[] }): Promise<{ ticket: Ticket; project: Project } | null>;
  /** Tickets in a status, oldest first, with their projects. */
  ticketsIn(status: TicketStatus, limit?: number): Promise<Array<{ ticket: Ticket; project: Project }>>;

  /** Backends that may not be launched before the given time (the ledger's backoff rows). */
  backoffs(): Promise<Map<string, string>>;
  setBackoff(backend: string, until: string): Promise<void>;
  createAssignment(input: { ticketId: string; executor: Assignment["executor"]; role?: string; agentId?: string }): Promise<Assignment>;
  updateAssignment(id: string, patch: Partial<Pick<Assignment, "session_ref" | "worktree" | "branch" | "pr_number" | "pr_url" | "status" | "lease_until" | "ended_at" | "last_report">>): Promise<Assignment>;
  openAssignments(): Promise<Assignment[]>;
  assignmentsFor(ticketId: string): Promise<Assignment[]>;
  /** The newest assignment of every ticket that has one, for list views. */
  latestAssignments(): Promise<Assignment[]>;
}

const assertStatus = (s: string): TicketStatus => {
  if (!(TICKET_STATUSES as readonly string[]).includes(s)) throw new Error(`unknown ticket status: ${s}`);
  return s as TicketStatus;
};

export function createRepo(db: Db): Repo {
  const one = async <T>(text: string, params: unknown[]): Promise<T> => {
    const { rows } = await db.query<Record<string, unknown>>(text, params);
    const row = rows[0];
    if (!row) throw new Error("expected one row");
    return row as T;
  };

  const addEvent: Repo["addEvent"] = ({ ticketId, assignmentId = null, actor, kind, payload = {}, externalId = null }) =>
    one<Event>(
      `INSERT INTO event (ticket_id, assignment_id, actor, kind, payload, external_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [ticketId, assignmentId, actor, kind, JSON.stringify(payload), externalId],
    );

  return {
    async listProjects() {
      return (await db.query<Project>(`SELECT * FROM project ORDER BY name`)).rows;
    },
    async getProject(id) {
      return (await db.query<Project>(`SELECT * FROM project WHERE id = $1`, [id])).rows[0] ?? null;
    },
    async registerProject(dir, worktreeRoot) {
      const info = await readProjectFromDir(dir);
      return one<Project>(
        `INSERT INTO project (name, repo, default_branch, dir, worktree_root, platform, default_executor, parallel)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (dir) DO UPDATE SET repo = EXCLUDED.repo, default_branch = EXCLUDED.default_branch, platform = EXCLUDED.platform
         RETURNING *`,
        [info.name, info.repo, info.defaultBranch, info.dir, worktreeRoot, JSON.stringify(info.platform), info.defaultExecutor, info.parallel],
      );
    },
    async updateProject(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${k} = $${params.length}`);
      }
      if (!sets.length) return (await this.getProject(id))!;
      return one<Project>(`UPDATE project SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
    },

    async listTickets(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.projectId) {
        params.push(filter.projectId);
        where.push(`project_id = $${params.length}`);
      }
      if (filter.status?.length) {
        params.push(filter.status);
        where.push(`status = ANY($${params.length})`);
      }
      const sql = `SELECT * FROM ticket ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY priority, created_at`;
      return (await db.query<Ticket>(sql, params)).rows;
    },
    async getTicket(id) {
      return (await db.query<Ticket>(`SELECT * FROM ticket WHERE id = $1`, [id])).rows[0] ?? null;
    },
    async createTicket({ projectId, title, body = "", kind = "chore", priority = 3, status = "inbox", source = "local", externalRef = null, actor = "human" }) {
      return db.tx(async (c) => {
        const { rows } = await c.query<Ticket>(
          `INSERT INTO ticket (project_id, title, body, kind, priority, status, source, external_ref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [projectId, title.trim(), body, kind, priority, assertStatus(status), source, externalRef],
        );
        const t = rows[0]!;
        await c.query(`INSERT INTO event (ticket_id, actor, kind, payload) VALUES ($1, $2, 'status', $3)`, [t.id, actor, JSON.stringify({ to: t.status, note: "created" })]);
        return t;
      });
    },
    async updateTicket(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${k} = $${params.length}`);
      }
      if (!sets.length) return (await this.getTicket(id))!;
      return one<Ticket>(`UPDATE ticket SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
    },
    async setStatus(id, status, actor, note, extra = {}) {
      assertStatus(status);
      return db.tx(async (c) => {
        const before = (await c.query<Ticket>(`SELECT * FROM ticket WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!before) throw new Error("ticket not found");
        const { rows } = await c.query<Ticket>(`UPDATE ticket SET status = $2 WHERE id = $1 RETURNING *`, [id, status]);
        await c.query(`INSERT INTO event (ticket_id, actor, kind, payload) VALUES ($1, $2, 'status', $3)`, [
          id,
          actor,
          JSON.stringify({ from: before.status, to: status, note: note ?? null, ...extra }),
        ]);
        return rows[0]!;
      });
    },

    addEvent,
    async listEvents(ticketId) {
      return (await db.query<Event>(`SELECT * FROM event WHERE ticket_id = $1 ORDER BY at`, [ticketId])).rows;
    },

    async claimReady({ projectId, executors }) {
      return db.tx(async (c) => {
        // One ready ticket whose blockers are all done, whose area does not collide with a running one,
        // and whose project still has a free slot. SKIP LOCKED keeps two daemons from taking the same row.
        const params: unknown[] = [];
        let projectFilter = "";
        if (projectId) {
          params.push(projectId);
          projectFilter = `AND t.project_id = $${params.length}`;
        }
        let executorFilter = "";
        if (executors) {
          params.push(executors);
          // Pinned to a backend: that backend must be available. Unpinned: anything available will do (the daemon
          // falls back from the project default when that one is in backoff).
          executorFilter = `AND (t.executor = ANY($${params.length}) OR (t.executor IS NULL AND cardinality($${params.length}::text[]) > 0))`;
        }
        const { rows } = await c.query<Ticket>(
          `SELECT t.* FROM ticket t
           JOIN project p ON p.id = t.project_id
           WHERE t.status = 'ready' ${projectFilter} ${executorFilter}
             AND NOT EXISTS (SELECT 1 FROM ticket b WHERE b.id = ANY(t.blocked_by) AND b.status <> 'done')
             AND NOT EXISTS (
               SELECT 1 FROM ticket r WHERE r.project_id = t.project_id AND r.status = 'in-progress' AND r.area && t.area AND cardinality(t.area) > 0)
             AND (SELECT count(*) FROM ticket r WHERE r.project_id = t.project_id AND r.status = 'in-progress') < p.parallel
           ORDER BY t.priority, t.created_at
           FOR UPDATE OF t SKIP LOCKED
           LIMIT 1`,
          params,
        );
        const ticket = rows[0];
        if (!ticket) return null;
        const updated = (await c.query<Ticket>(`UPDATE ticket SET status = 'in-progress' WHERE id = $1 RETURNING *`, [ticket.id])).rows[0]!;
        await c.query(`INSERT INTO event (ticket_id, actor, kind, payload) VALUES ($1, 'daemon', 'status', $2)`, [
          ticket.id,
          JSON.stringify({ from: "ready", to: "in-progress", note: "claimed" }),
        ]);
        const project = (await c.query<Project>(`SELECT * FROM project WHERE id = $1`, [ticket.project_id])).rows[0]!;
        return { ticket: updated, project };
      });
    },
    async ticketsIn(status, limit = 20) {
      const { rows } = await db.query<Ticket & { project: Project }>(
        `SELECT t.*, row_to_json(p.*) AS project FROM ticket t JOIN project p ON p.id = t.project_id WHERE t.status = $1 ORDER BY t.created_at LIMIT $2`,
        [status, limit],
      );
      return rows.map(({ project, ...ticket }) => ({ ticket: ticket as Ticket, project }));
    },

    async backoffs() {
      const { rows } = await db.query<{ backend: string; backoff_until: string }>(`SELECT backend, backoff_until FROM ledger WHERE usage_window = 'backoff' AND backoff_until > now()`);
      return new Map(rows.map((r) => [r.backend, r.backoff_until]));
    },
    async setBackoff(backend, until) {
      await db.query(
        `INSERT INTO ledger (backend, usage_window, backoff_until, read_at) VALUES ($1, 'backoff', $2, now())
         ON CONFLICT (backend, usage_window) DO UPDATE SET backoff_until = EXCLUDED.backoff_until, read_at = now()`,
        [backend, until],
      );
    },

    async createAssignment({ ticketId, executor, role = "execute", agentId }) {
      return one<Assignment>(
        `INSERT INTO assignment (ticket_id, executor, role, agent_id, status) VALUES ($1, $2, $3, $4, 'queued') RETURNING *`,
        [ticketId, executor, role, agentId ?? executor],
      );
    },
    async updateAssignment(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        params.push(k === "last_report" && v !== null ? JSON.stringify(v) : v);
        sets.push(`${k} = $${params.length}`);
      }
      return one<Assignment>(`UPDATE assignment SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
    },
    async openAssignments() {
      return (await db.query<Assignment>(`SELECT * FROM assignment WHERE status IN ('queued', 'running', 'waiting') ORDER BY started_at`)).rows;
    },
    async assignmentsFor(ticketId) {
      return (await db.query<Assignment>(`SELECT * FROM assignment WHERE ticket_id = $1 ORDER BY started_at DESC`, [ticketId])).rows;
    },
    async latestAssignments() {
      return (await db.query<Assignment>(`SELECT DISTINCT ON (ticket_id) * FROM assignment ORDER BY ticket_id, started_at DESC`)).rows;
    },
  };
}
