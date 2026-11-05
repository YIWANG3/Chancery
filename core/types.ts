// Shared row shapes. Postgres is the truth; these mirror core/migrations.

export const TICKET_STATUSES = [
  "inbox",
  "needs-spec",
  "ready",
  "in-progress",
  "review",
  "awaiting-merge",
  "needs-human",
  "blocked",
  "done",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_KINDS = ["bug", "feature", "chore", "marketing", "question", "release"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export type ExecutorKind = "claude-desktop" | "codex" | "dsh";

export interface Project {
  id: string;
  name: string;
  repo: string | null; // owner/name
  default_branch: string;
  dir: string; // main checkout
  worktree_root: string;
  platform: Record<string, unknown>; // the repo's .claude/platform.json, read at register time
  default_executor: ExecutorKind;
  default_model: string | null;
  parallel: number;
  github_sync: boolean;
  created_at: string;
}

export interface Ticket {
  id: string;
  seq: number;
  project_id: string;
  source: string;
  external_ref: string | null;
  kind: TicketKind;
  title: string;
  body: string;
  priority: number; // 1 high … 4 low
  status: TicketStatus;
  area: string[];
  spec_path: string | null;
  blocked_by: string[];
  executor: ExecutorKind | null;
  model: string | null;
  auto_merge: boolean;
  created_at: string;
  updated_at: string;
}

export type AssignmentStatus = "queued" | "running" | "waiting" | "done" | "failed";

export interface Assignment {
  id: string;
  ticket_id: string;
  agent_id: string | null;
  role: string;
  executor: ExecutorKind;
  session_ref: string | null;
  worktree: string | null;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  status: AssignmentStatus;
  lease_until: string | null;
  started_at: string;
  ended_at: string | null;
  last_report: Record<string, unknown> | null;
}

export type EventKind = "status" | "report" | "question" | "answer" | "comment" | "ci" | "pr" | "note";

export interface Event {
  id: string;
  at: string;
  ticket_id: string;
  assignment_id: string | null;
  actor: string; // agent id or "human"
  kind: EventKind;
  payload: Record<string, unknown>;
  external_id: string | null;
}

/** What an executor reports back after looking at a running worker. Borrowed from dsh-superagent's worker vocabulary. */
export type ReportState = "running" | "ready" | "waiting" | "blocked" | "failed" | "dropped";

export interface Report {
  state: ReportState;
  summary?: string;
  question?: string;
  pr?: { number: number; url: string } | null;
  raw?: Record<string, unknown>;
  /** failed only: "quota" when the backend's limits, not the task, ended the run. The daemon backs the backend off. */
  reason?: "quota" | string;
  /** running only: the executor knows the worker is alive right now (child process up, session busy). Renews the lease. */
  heartbeat?: boolean;
  /** running only: an opaque marker that changes when the worker makes progress (transcript length, turn count).
   *  A changed marker renews the lease too; an unchanged one past lease_until means the worker is stuck. */
  progress?: string;
}
