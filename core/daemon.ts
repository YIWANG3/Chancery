// The resident loop. Runs inside the desktop app's main process today and headless later; never imports Electron.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db.js";
import type { Repo } from "./repo.js";
import type { TriageResult } from "./clerk.js";
import type { Executor, WorktreeInfo } from "./executors/types.js";
import { addWorktree, slugify } from "./git/worktree.js";
import { auditPrompt, executePrompt, parseAuditVerdict, type PromptHistory } from "./prompts.js";
import { run } from "./util/run.js";
import type { Assignment, ExecutorKind, Project, Report, Ticket } from "./types.js";

export type Triage = (ticket: Ticket, project: Project, decisions: string | null) => Promise<TriageResult>;

export interface DaemonOptions {
  db: Db;
  repo: Repo;
  executors: Partial<Record<ExecutorKind, Executor>>;
  /** Fallback worktree root when a project has none. */
  worktreeRoot: string;
  intervalMs?: number;
  leaseMs?: number;
  log?: (msg: string) => void;
  /** Called after every tick with what changed, so a UI can refresh. */
  onChange?: () => void;
  /** How long stop() waits for a tick already in flight before giving up on it (default 3 s). */
  stopTimeoutMs?: number;
  /** How long a backend sits out after a worker dies on its limits (default 60 min). */
  quotaBackoffMs?: number;
  /** The clerk's triage call for inbox tickets; returns null to leave inbox alone. Read every tick so a settings
   *  change applies without a restart. */
  clerk?: () => Triage | null;
  /** Whether PRs get an audit round (default on). Read every tick. */
  auditEnabled?: () => boolean;
  /** Audit rounds per ticket before it goes to the human (default 3). */
  maxAuditRounds?: number;
  /** Budget for a project's `setup` command in a fresh worktree (default 10 min). */
  setupTimeoutMs?: number;
}

export interface DaemonStatus {
  running: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  ticks: number;
  paused: boolean;
  /** Assignments currently running (workers and auditors). */
  active: number;
}

export interface Daemon {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
  status(): DaemonStatus;
  setPaused(paused: boolean): void;
}

const AUDIT_EXECUTORS: ReadonlySet<string> = new Set(["claude-desktop", "codex", "dsh"]);

export function createDaemon(opts: DaemonOptions): Daemon {
  const { db, repo } = opts;
  const log = opts.log ?? (() => {});
  const intervalMs = opts.intervalMs ?? 30_000;
  const leaseMs = opts.leaseMs ?? 5 * 60_000;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 3_000;
  const quotaBackoffMs = opts.quotaBackoffMs ?? 60 * 60_000;
  const maxAuditRounds = opts.maxAuditRounds ?? 3;
  const setupTimeoutMs = opts.setupTimeoutMs ?? 10 * 60_000;
  let timer: NodeJS.Timeout | null = null;
  let unlisten: (() => Promise<void>) | null = null;
  let ticking: Promise<void> | null = null;
  let wantAnother = false;
  const triageTried = new Map<string, number>(); // ticket id → last attempt, so a failing clerk does not spin
  const state: DaemonStatus = { running: false, lastTickAt: null, lastError: null, ticks: 0, paused: false, active: 0 };

  const executorFor = (kind: ExecutorKind): Executor | null => opts.executors[kind] ?? null;
  const platformOf = (project: Project) => project.platform as Record<string, unknown>;
  const nowIso = () => new Date().toISOString();

  // ---- poll ------------------------------------------------------------------------------------------------

  async function pollAssignment(a: Assignment): Promise<void> {
    if (a.status !== "running") return;
    const ticket = await repo.getTicket(a.ticket_id);
    const project = ticket ? await repo.getProject(ticket.project_id) : null;
    if (!ticket || !project) return;
    const executor = executorFor(a.executor);
    if (!executor) return;
    let report: Report;
    try {
      report = await executor.report(a, { ticket, project });
    } catch (err) {
      log(`report #${ticket.seq} failed: ${String(err)}`);
      return;
    }
    if (report.pr && (a.pr_number !== report.pr.number || a.pr_url !== report.pr.url)) {
      await repo.updateAssignment(a.id, { pr_number: report.pr.number, pr_url: report.pr.url });
      await repo.addEvent({ ticketId: ticket.id, assignmentId: a.id, actor: a.executor, kind: "pr", payload: { number: report.pr.number, url: report.pr.url } });
    }
    const sessionId = typeof report.raw?.sessionId === "string" ? report.raw.sessionId : null;
    if (sessionId && a.session_ref !== sessionId) await repo.updateAssignment(a.id, { session_ref: sessionId });
    const now = nowIso();
    const actor = a.role === "audit" ? `${a.executor}:audit` : a.executor;
    switch (report.state) {
      case "running": {
        // The lease is renewed only on evidence of life: a heartbeat, or a progress marker that moved since last
        // time. A worker that shows neither past lease_until is stuck (archived desktop session, a hung turn, an
        // index entry for a session that never ran) and would otherwise hold the ticket and its slot forever.
        const prevProgress = typeof a.last_report?.progress === "string" ? a.last_report.progress : undefined;
        const moved = report.heartbeat === true || (report.progress !== undefined && report.progress !== prevProgress);
        const lastReport = { ...report.raw, ...(report.progress !== undefined ? { progress: report.progress } : {}) };
        const expired = !!a.lease_until && new Date(a.lease_until).getTime() < Date.now();
        if (moved) {
          await repo.updateAssignment(a.id, { lease_until: new Date(Date.now() + leaseMs).toISOString(), last_report: lastReport });
          return;
        }
        if (!expired) {
          await repo.updateAssignment(a.id, { last_report: lastReport });
          return;
        }
        const minutes = Math.round(leaseMs / 60_000);
        const summary = report.summary?.trim() ? `最后的话：${report.summary.trim()}` : "没有留下任何汇报";
        log(`watchdog: #${ticket.seq} ${a.executor} ${a.session_ref ?? ""} showed no sign of life for ${minutes} min`);
        await repo.updateAssignment(a.id, { status: "failed", ended_at: now, last_report: { ...lastReport, summary: report.summary, stuck: true } });
        await repo.addEvent({ ticketId: ticket.id, assignmentId: a.id, actor: "daemon", kind: "report", payload: { state: "stuck", summary: `${a.role === "audit" ? "审计" : "worker"} ${minutes} 分钟没有动静。${summary}` } });
        await repo.setStatus(ticket.id, "needs-human", "daemon", `${a.role === "audit" ? "审计" : "worker"} ${minutes} 分钟没有动静，当它卡住了；看一眼会话再决定重派还是关掉`);
        return;
      }
      case "ready": {
        await repo.updateAssignment(a.id, { status: "done", ended_at: now, last_report: { ...report.raw, summary: report.summary } });
        if (a.role === "audit") {
          await settleAudit(ticket, a, report);
          return;
        }
        await repo.addEvent({ ticketId: ticket.id, assignmentId: a.id, actor, kind: "report", payload: { state: "ready", summary: report.summary ?? "" } });
        await repo.setStatus(ticket.id, "review", "daemon", report.pr ? "worker 完成，PR 已开" : "worker 完成，没有 PR，看一眼汇报");
        return;
      }
      case "waiting":
      case "blocked": {
        await repo.updateAssignment(a.id, { status: "waiting", last_report: { ...report.raw, summary: report.summary, question: report.question } });
        await repo.addEvent({ ticketId: ticket.id, assignmentId: a.id, actor, kind: "question", payload: { summary: report.summary ?? "", question: report.question ?? "" } });
        await repo.setStatus(ticket.id, "needs-human", "daemon", report.state === "blocked" ? `${a.role === "audit" ? "审计" : "worker"} 被挡住了` : `${a.role === "audit" ? "审计" : "worker"} 有问题要问`);
        return;
      }
      case "failed":
      case "dropped": {
        await repo.updateAssignment(a.id, { status: "failed", ended_at: now, last_report: { ...report.raw, summary: report.summary, reason: report.reason } });
        await repo.addEvent({ ticketId: ticket.id, assignmentId: a.id, actor, kind: "report", payload: { state: report.state, summary: report.summary ?? "", reason: report.reason ?? null } });
        if (report.reason === "quota") {
          // The backend's limits, not the task: sit that backend out and put the ticket back in the queue (an
          // unpinned ticket goes to another backend next tick, a pinned one waits).
          const until = new Date(Date.now() + quotaBackoffMs).toISOString();
          await repo.setBackoff(a.executor, until);
          log(`quota: ${a.executor} backed off until ${until} after #${ticket.seq}`);
          await repo.addEvent({ ticketId: ticket.id, assignmentId: a.id, actor: "daemon", kind: "note", payload: { text: `${a.executor} 撞到额度，退避到 ${until}` } });
          await repo.setStatus(ticket.id, a.role === "audit" ? "review" : "ready", "daemon", `${a.executor} 撞到额度，稍后换一家或等它恢复`);
          return;
        }
        await repo.setStatus(ticket.id, "needs-human", "daemon", `${a.role === "audit" ? "审计" : "worker"} ${report.state}：${report.summary ?? ""}`);
        return;
      }
    }
  }

  /** The auditor finished: its last line decides where the ticket goes. */
  async function settleAudit(ticket: Ticket, a: Assignment, report: Report): Promise<void> {
    const summary = report.summary ?? "";
    const verdict = parseAuditVerdict(summary);
    const rounds = (await repo.assignmentsFor(ticket.id)).filter((x) => x.role === "audit").length;
    if (verdict === "pass") {
      await repo.addEvent({ ticketId: ticket.id, assignmentId: a.id, actor: `${a.executor}:audit`, kind: "report", payload: { state: "audit-passed", summary, round: rounds } });
      await repo.setStatus(ticket.id, "awaiting-merge", "daemon", `审计第 ${rounds} 轮通过`);
      return;
    }
    if (verdict === "fail") {
      await repo.addEvent({ ticketId: ticket.id, assignmentId: a.id, actor: `${a.executor}:audit`, kind: "report", payload: { state: "audit-failed", summary, round: rounds } });
      if (rounds >= maxAuditRounds) {
        await repo.setStatus(ticket.id, "needs-human", "daemon", `审计 ${rounds} 轮没过，你来看`);
        return;
      }
      // Back to the queue: the next worker's first message carries the audit's findings.
      await repo.setStatus(ticket.id, "ready", "daemon", `审计第 ${rounds} 轮没过，再来一轮修`);
      return;
    }
    await repo.addEvent({ ticketId: ticket.id, assignmentId: a.id, actor: `${a.executor}:audit`, kind: "report", payload: { state: "audit-unclear", summary, round: rounds } });
    await repo.setStatus(ticket.id, "needs-human", "daemon", "审计没有给出 PASS / FAIL 结论，你来看");
  }

  // ---- triage ----------------------------------------------------------------------------------------------

  async function readDecisions(project: Project): Promise<string | null> {
    const rel = typeof platformOf(project).decisions === "string" ? (platformOf(project).decisions as string) : "docs/decisions.md";
    return readFile(join(project.dir, rel), "utf8").catch(() => null);
  }

  async function triageInbox(): Promise<void> {
    const clerk = opts.clerk?.();
    if (!clerk) return;
    for (const { ticket, project } of await repo.ticketsIn("inbox", 5)) {
      const last = triageTried.get(ticket.id) ?? 0;
      if (Date.now() - last < 10 * 60_000) continue;
      triageTried.set(ticket.id, Date.now());
      let r: TriageResult;
      try {
        r = await clerk(ticket, project, await readDecisions(project));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`triage #${ticket.seq} failed: ${message}`);
        await repo.addEvent({ ticketId: ticket.id, actor: "clerk", kind: "note", payload: { text: `没能自动分类：${message}` } });
        continue;
      }
      await repo.updateTicket(ticket.id, { kind: r.kind, priority: r.priority, area: r.area });
      if (r.status === "done" && r.answer) {
        await repo.addEvent({ ticketId: ticket.id, actor: "clerk", kind: "comment", payload: { text: r.answer } });
        await repo.setStatus(ticket.id, "done", "clerk", `这是个问题，已直接回答：${r.reason}`, { kind: r.kind, priority: r.priority });
      } else {
        await repo.setStatus(ticket.id, r.status === "needs-spec" ? "needs-spec" : "ready", "clerk", r.reason, { kind: r.kind, priority: r.priority, area: r.area });
      }
      log(`triage #${ticket.seq}: ${r.kind} P${r.priority} → ${r.status}`);
      triageTried.delete(ticket.id);
    }
  }

  // ---- audit -----------------------------------------------------------------------------------------------

  async function scheduleAudits(backoffs: Map<string, string>): Promise<void> {
    if (!(opts.auditEnabled?.() ?? true)) return;
    for (const { ticket, project } of await repo.ticketsIn("review", 20)) {
      const assignments = await repo.assignmentsFor(ticket.id);
      const latest = assignments[0];
      // Only a finished worker round with a PR gets audited; an audit already running or settled is left alone.
      if (!latest || latest.role !== "execute" || latest.status !== "done" || !latest.pr_number) continue;
      const rounds = assignments.filter((a) => a.role === "audit").length;
      if (rounds >= maxAuditRounds) continue;
      if (!latest.worktree || !latest.branch) {
        await repo.addEvent({ ticketId: ticket.id, actor: "daemon", kind: "note", payload: { text: "没有 worktree 可以审计，留给人看" } });
        await repo.setStatus(ticket.id, "needs-human", "daemon", "worker 有 PR 但没有可审计的 worktree");
        continue;
      }
      const agents = (platformOf(project).agents ?? {}) as Record<string, unknown>;
      const kind = (typeof agents.audit === "string" && AUDIT_EXECUTORS.has(agents.audit) ? agents.audit : latest.executor) as ExecutorKind;
      const executor = executorFor(kind);
      if (!executor) {
        await repo.setStatus(ticket.id, "needs-human", "daemon", `没有 ${kind} 执行器做审计`);
        continue;
      }
      if (backoffs.has(kind)) continue; // tries again when the backend is back
      const round = rounds + 1;
      const assignment = await repo.createAssignment({ ticketId: ticket.id, executor: kind, role: "audit" });
      const where: WorktreeInfo = { worktree: latest.worktree, branch: latest.branch };
      try {
        const { sessionRef, detail } = await executor.launch({
          role: "audit",
          ticket,
          project,
          assignment,
          model: ticket.model ?? project.default_model,
          planned: where,
          existingWorktree: where,
          ensureWorktree: async () => where,
          buildPrompt: () => auditPrompt(ticket, project, { round, pr: latest.pr_number && latest.pr_url ? { number: latest.pr_number, url: latest.pr_url } : null, branch: latest.branch }),
        });
        await repo.updateAssignment(assignment.id, { status: "running", session_ref: sessionRef, worktree: where.worktree, branch: where.branch, pr_number: latest.pr_number, pr_url: latest.pr_url, lease_until: new Date(Date.now() + leaseMs).toISOString() });
        await repo.addEvent({ ticketId: ticket.id, assignmentId: assignment.id, actor: "daemon", kind: "note", payload: { text: `审计第 ${round} 轮开始（${kind}，会话 ${sessionRef}${detail ? "，" + detail : ""}）` } });
        log(`audit round ${round} for #${ticket.seq} on ${kind}: ${sessionRef}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`audit launch #${ticket.seq} failed: ${message}`);
        await repo.updateAssignment(assignment.id, { status: "failed", ended_at: nowIso(), last_report: { error: message } });
        await repo.setStatus(ticket.id, "needs-human", "daemon", `审计启动失败：${message}`);
      }
    }
  }

  // ---- dispatch --------------------------------------------------------------------------------------------

  async function dispatchOne(available: ExecutorKind[]): Promise<boolean> {
    const claimed = await repo.claimReady({ executors: available });
    if (!claimed) return false;
    const { ticket, project } = claimed;
    let kind = (ticket.executor ?? project.default_executor) as ExecutorKind;
    if (!available.includes(kind)) {
      if (ticket.executor) {
        // Pinned to a backend in backoff; the claim filter should have skipped it. Put it back.
        await repo.setStatus(ticket.id, "ready", "daemon", `${kind} 在退避中，等它恢复`);
        return true;
      }
      const fallback = available[0];
      if (!fallback) {
        await repo.setStatus(ticket.id, "ready", "daemon", "所有后端都在退避中");
        return true;
      }
      await repo.addEvent({ ticketId: ticket.id, actor: "daemon", kind: "note", payload: { text: `${kind} 在退避中，改派 ${fallback}` } });
      kind = fallback;
    }
    const executor = executorFor(kind);
    if (!executor) {
      await repo.setStatus(ticket.id, "needs-human", "daemon", `没有 ${kind} 执行器`);
      return true;
    }
    // Earlier rounds on this ticket: their questions, the human's answers and the audit's findings go into the
    // new worker's first message (delivery into the old session is Phase 1), and their open assignments are
    // closed as superseded.
    const earlier = await repo.assignmentsFor(ticket.id);
    for (const old of earlier) {
      if (old.status === "queued" || old.status === "running" || old.status === "waiting") {
        await repo.updateAssignment(old.id, { status: "done", ended_at: nowIso(), last_report: { ...old.last_report, superseded: true } });
      }
    }
    const lastExecute = earlier.find((a) => a.role === "execute") ?? null;
    const previous = lastExecute ? { branch: lastExecute.branch, worktree: lastExecute.worktree, pr_url: lastExecute.pr_url } : null;
    const history: PromptHistory = { events: (await repo.listEvents(ticket.id)).filter((e) => e.kind === "question" || e.kind === "answer" || e.kind === "report").slice(-8), previous };
    const assignment = await repo.createAssignment({ ticketId: ticket.id, executor: kind });
    // The slug is deterministic, so a daemon-made worktree from an earlier round is reused as is (addWorktree is
    // idempotent); a desktop-made one lives elsewhere and the prompt tells the worker to merge that branch.
    const branch = slugify(ticket.seq, ticket.title);
    const worktree = join(project.worktree_root || opts.worktreeRoot, project.name, branch);
    try {
      const { sessionRef, detail, worktree: usedWorktree, branch: usedBranch } = await executor.launch({
        role: "execute",
        ticket,
        project,
        assignment,
        model: ticket.model ?? project.default_model,
        planned: { worktree, branch },
        async ensureWorktree() {
          const { created } = await addWorktree({ repoDir: project.dir, dir: worktree, branch, base: project.default_branch });
          await repo.updateAssignment(assignment.id, { worktree, branch });
          await repo.addEvent({ ticketId: ticket.id, assignmentId: assignment.id, actor: "daemon", kind: "note", payload: { text: `worktree ${worktree}，分支 ${branch}${created ? "" : "（复用上一轮的）"}` } });
          const setup = typeof platformOf(project).setup === "string" ? (platformOf(project).setup as string) : null;
          if (created && setup) {
            const t0 = Date.now();
            try {
              await run(process.platform === "darwin" ? "/usr/sbin/taskpolicy" : "sh", process.platform === "darwin" ? ["-b", "sh", "-c", setup] : ["-c", setup], { cwd: worktree, timeoutMs: setupTimeoutMs });
            } catch (err) {
              throw new Error(`setup（${setup}）失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
            }
            await repo.addEvent({ ticketId: ticket.id, assignmentId: assignment.id, actor: "daemon", kind: "note", payload: { text: `setup 跑完：${setup}（${Math.round((Date.now() - t0) / 1000)} 秒）` } });
          }
          return { worktree, branch };
        },
        buildPrompt: (where) => executePrompt(ticket, project, where, history),
      });
      await repo.updateAssignment(assignment.id, {
        status: "running",
        session_ref: sessionRef,
        ...(usedWorktree ? { worktree: usedWorktree } : {}),
        ...(usedBranch ? { branch: usedBranch } : {}),
        lease_until: new Date(Date.now() + leaseMs).toISOString(),
      });
      await repo.addEvent({ ticketId: ticket.id, assignmentId: assignment.id, actor: kind, kind: "note", payload: { text: `会话 ${sessionRef}${detail ? "（" + detail + "）" : ""}${usedWorktree && usedWorktree !== worktree ? `，worktree ${usedWorktree}` : ""}` } });
      log(`launched #${ticket.seq} on ${kind}: ${sessionRef}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`launch #${ticket.seq} failed: ${message}`);
      await repo.updateAssignment(assignment.id, { status: "failed", ended_at: nowIso(), last_report: { error: message } });
      await repo.setStatus(ticket.id, "needs-human", "daemon", `启动失败：${message}`);
    }
    return true;
  }

  // ---- the loop --------------------------------------------------------------------------------------------

  /** One step of a tick; a failure is logged and recorded but never stops the steps after it. */
  async function step(name: string, fn: () => Promise<void>, errors: string[]): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(message);
      log(`tick ${message}`);
    }
  }

  async function tick(): Promise<void> {
    if (!state.running) return;
    if (ticking) {
      wantAnother = true;
      return ticking;
    }
    ticking = (async () => {
      const errors: string[] = [];
      try {
        if (!state.paused) {
          await step("poll", async () => {
            const open = await repo.openAssignments();
            for (const a of open) await pollAssignment(a);
            state.active = open.filter((a) => a.status === "running").length;
          }, errors);
          await step("triage", triageInbox, errors);
          let backoffs = new Map<string, string>();
          await step("backoffs", async () => {
            backoffs = await repo.backoffs();
          }, errors);
          await step("audit", () => scheduleAudits(backoffs), errors);
          await step("dispatch", async () => {
            const available = (Object.keys(opts.executors) as ExecutorKind[]).filter((k) => opts.executors[k] && !backoffs.has(k));
            for (let i = 0; i < 5; i++) if (!(await dispatchOne(available))) break;
          }, errors);
        }
        state.lastError = errors.length ? errors.join("；") : null;
      } finally {
        state.ticks += 1;
        state.lastTickAt = nowIso();
        ticking = null;
        opts.onChange?.();
      }
    })();
    await ticking;
    if (wantAnother) {
      wantAnother = false;
      if (state.running) await tick();
    }
  }

  return {
    async start() {
      if (state.running) return;
      state.running = true;
      unlisten = await db.listen(
        (payload) => {
          // Only ticket changes can make new work; event/assignment writes are our own.
          if (payload.startsWith("ticket:")) void tick();
          opts.onChange?.();
        },
        () => {
          log("listen: reconnected, catching up");
          void tick();
        },
      );
      timer = setInterval(() => void tick(), intervalMs);
      await tick();
    },
    async stop() {
      state.running = false;
      wantAnother = false;
      if (timer) clearInterval(timer);
      timer = null;
      // A tick in flight may be waiting on a worker or a slow executor; the app is quitting, so it gets a
      // bounded wait and is otherwise abandoned (nothing it would write is lost: leases and reports re-derive).
      const inFlight = ticking ? ticking.catch(() => {}) : Promise.resolve();
      const timedOut = await Promise.race([inFlight.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), stopTimeoutMs).unref?.())]);
      if (timedOut) log(`stop: a tick was still running after ${stopTimeoutMs} ms; not waiting for it`);
      const u = unlisten;
      unlisten = null;
      if (u) await Promise.race([u(), new Promise<void>((r) => setTimeout(r, 1_000).unref?.())]);
    },
    tick,
    status: () => ({ ...state }),
    setPaused(paused) {
      state.paused = paused;
    },
  };
}
