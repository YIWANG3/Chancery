import { describe, expect, it } from "vitest";
import { createDaemon } from "./daemon.js";
import type { Db } from "./db.js";
import type { Repo } from "./repo.js";

/** A repo whose first poll never answers: the shape of a worker that hangs while the app is quitting. */
function stuckRepo(): Repo {
  return { openAssignments: () => new Promise(() => {}) } as unknown as Repo;
}

const fakeDb = (): Db => ({ listen: async () => async () => {} }) as unknown as Db;

describe("daemon.stop", () => {
  it("returns after stopTimeoutMs even when a tick is stuck", async () => {
    const logs: string[] = [];
    const daemon = createDaemon({ db: fakeDb(), repo: stuckRepo(), executors: {}, worktreeRoot: "/tmp", intervalMs: 60_000, stopTimeoutMs: 50, log: (m) => logs.push(m) });
    void daemon.start(); // never resolves: its first tick is stuck
    await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    await daemon.stop();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(daemon.status().running).toBe(false);
    expect(logs.some((m) => m.startsWith("stop: a tick was still running"))).toBe(true);
  });

  it("does not start a tick once stopped", async () => {
    let polls = 0;
    const repo = { openAssignments: async () => (polls++, []), claimReady: async () => null, backoffs: async () => new Map(), ticketsIn: async () => [] } as unknown as Repo;
    const daemon = createDaemon({ db: fakeDb(), repo, executors: {}, worktreeRoot: "/tmp", intervalMs: 60_000 });
    await daemon.start();
    expect(polls).toBe(1);
    await daemon.stop();
    await daemon.tick();
    expect(polls).toBe(1);
  });
});

describe("daemon watchdog", () => {
  const base = { id: "a1", ticket_id: "t1", agent_id: null, role: "execute", executor: "claude-desktop", session_ref: "s", worktree: "/wt", branch: "b", pr_number: null, pr_url: null, status: "running", started_at: "", ended_at: null } as const;
  function harness(assignment: Record<string, unknown>, report: Record<string, unknown>) {
    const calls: Array<[string, unknown]> = [];
    const repo = {
      openAssignments: async () => [assignment],
      claimReady: async () => null,
      getTicket: async () => ({ id: "t1", seq: 1, project_id: "p" }),
      getProject: async () => ({ id: "p" }),
      updateAssignment: async (id: string, patch: unknown) => (calls.push(["updateAssignment", patch]), { ...assignment, ...(patch as object) }),
      addEvent: async (e: unknown) => (calls.push(["addEvent", e]), {}),
      setStatus: async (_id: string, status: string, _actor: string, note?: string) => (calls.push(["setStatus", { status, note }]), {}),
      assignmentsFor: async () => [assignment],
      backoffs: async () => new Map(),
      ticketsIn: async () => [],
    } as unknown as Repo;
    const executors = { "claude-desktop": { kind: "claude-desktop", launch: async () => ({ sessionRef: "x" }), report: async () => report } } as never;
    return { daemon: createDaemon({ db: fakeDb(), repo, executors, worktreeRoot: "/tmp", intervalMs: 60_000, leaseMs: 1000 }), calls };
  }
  const past = new Date(Date.now() - 10_000).toISOString();

  it("renews the lease on a heartbeat even when the lease has expired", async () => {
    const { daemon, calls } = harness({ ...base, lease_until: past, last_report: null }, { state: "running", heartbeat: true });
    await daemon.start();
    await daemon.stop();
    const patch = calls.find(([k]) => k === "updateAssignment")?.[1] as { lease_until?: string };
    expect(patch.lease_until && patch.lease_until > past).toBe(true);
    expect(calls.some(([k]) => k === "setStatus")).toBe(false);
  });
  it("renews when the progress marker moved", async () => {
    const { daemon, calls } = harness({ ...base, lease_until: past, last_report: { progress: "10" } }, { state: "running", progress: "11" });
    await daemon.start();
    await daemon.stop();
    const patch = calls.find(([k]) => k === "updateAssignment")?.[1] as { lease_until?: string };
    expect(patch.lease_until).toBeTruthy();
  });
  it("keeps waiting while the lease is still valid", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { daemon, calls } = harness({ ...base, lease_until: future, last_report: { progress: "10" } }, { state: "running", progress: "10" });
    await daemon.start();
    await daemon.stop();
    const patch = calls.find(([k]) => k === "updateAssignment")?.[1] as { lease_until?: string; status?: string };
    expect(patch.lease_until).toBeUndefined();
    expect(patch.status).toBeUndefined();
  });
  it("hands a stuck worker to the human once the lease expires with no movement", async () => {
    const { daemon, calls } = harness({ ...base, lease_until: past, last_report: { progress: "10" } }, { state: "running", progress: "10", summary: "last words" });
    await daemon.start();
    await daemon.stop();
    const patch = calls.find(([k]) => k === "updateAssignment")?.[1] as { status?: string };
    expect(patch.status).toBe("failed");
    const status = calls.find(([k]) => k === "setStatus")?.[1] as { status: string; note: string };
    expect(status.status).toBe("needs-human");
    expect(status.note).toContain("没有动静");
    const event = calls.find(([k]) => k === "addEvent")?.[1] as { payload: { summary: string } };
    expect(event.payload.summary).toContain("last words");
  });
});

/** A tiny in-memory repo for the loop's scheduling logic. Only what the daemon touches. */
function memRepo(seed: { tickets: Array<Record<string, unknown>>; assignments?: Array<Record<string, unknown>>; project?: Record<string, unknown> }) {
  const project = { id: "p", name: "demo", dir: "/repo", worktree_root: "/wt", default_branch: "main", default_executor: "claude-desktop", default_model: null, parallel: 2, platform: {}, ...seed.project };
  const tickets = seed.tickets.map((t) => ({ id: "t1", seq: 1, project_id: "p", title: "fix", body: "", kind: "chore", priority: 3, status: "ready", area: [], executor: null, model: null, spec_path: null, ...t }));
  const assignments: Array<Record<string, unknown>> = (seed.assignments ?? []).map((a) => ({ id: "a0", ticket_id: "t1", role: "execute", executor: "claude-desktop", status: "done", session_ref: "s", worktree: "/wt/demo/b", branch: "b", pr_number: null, pr_url: null, lease_until: null, started_at: "2026-01-01T00:00:00Z", last_report: null, ...a }));
  const events: Array<Record<string, unknown>> = [];
  const backoff = new Map<string, string>();
  let n = 0;
  const repo = {
    getTicket: async (id: string) => tickets.find((t) => t.id === id) ?? null,
    getProject: async () => project,
    listEvents: async (id: string) => events.filter((e) => e.ticketId === id),
    addEvent: async (e: Record<string, unknown>) => (events.push(e), e),
    setStatus: async (id: string, status: string, _actor: string, note?: string) => {
      const t = tickets.find((x) => x.id === id)!;
      t.status = status;
      events.push({ ticketId: id, kind: "status", payload: { to: status, note } });
      return t;
    },
    updateTicket: async (id: string, patch: Record<string, unknown>) => Object.assign(tickets.find((x) => x.id === id)!, patch),
    ticketsIn: async (status: string) => tickets.filter((t) => t.status === status).map((ticket) => ({ ticket, project })),
    openAssignments: async () => assignments.filter((a) => ["queued", "running", "waiting"].includes(a.status as string)),
    assignmentsFor: async (id: string) => assignments.filter((a) => a.ticket_id === id).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))),
    createAssignment: async (input: Record<string, unknown>) => {
      const a = { id: `a${++n}`, status: "queued", role: "execute", session_ref: null, worktree: null, branch: null, pr_number: null, pr_url: null, lease_until: null, started_at: new Date(Date.now() + n).toISOString(), last_report: null, ticket_id: input.ticketId, executor: input.executor, ...(input.role ? { role: input.role } : {}) };
      assignments.push(a);
      return a;
    },
    updateAssignment: async (id: string, patch: Record<string, unknown>) => Object.assign(assignments.find((a) => a.id === id)!, patch),
    claimReady: async ({ executors }: { executors?: string[] }) => {
      const t = tickets.find((x) => x.status === "ready" && (!executors || (x.executor ? executors.includes(x.executor as string) : executors.length > 0)));
      if (!t) return null;
      t.status = "in-progress";
      return { ticket: t, project };
    },
    backoffs: async () => new Map(backoff),
    setBackoff: async (b: string, until: string) => void backoff.set(b, until),
  };
  return { repo: repo as unknown as Repo, tickets, assignments, events, backoff };
}

const launches: Array<Record<string, unknown>> = [];
const fakeExecutor = (report: Record<string, unknown>) =>
  ({
    kind: "claude-desktop",
    launch: async (ctx: Record<string, unknown>) => {
      launches.push({ role: ctx.role, prompt: (ctx as { buildPrompt: (w: unknown) => string }).buildPrompt((ctx as { existingWorktree?: unknown }).existingWorktree ?? null), existing: ctx.existingWorktree });
      return { sessionRef: "sess" };
    },
    report: async () => report,
  }) as Record<string, unknown>;

async function runOnce(repo: Repo, executors: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const daemon = createDaemon({ db: fakeDb(), repo, executors: executors as never, worktreeRoot: "/tmp", intervalMs: 60_000, leaseMs: 1000, ...extra });
  await daemon.start();
  await daemon.stop();
  return daemon;
}

describe("quota backoff", () => {
  it("backs the backend off and requeues the ticket instead of asking the human", async () => {
    const m = memRepo({ tickets: [{ status: "in-progress" }], assignments: [{ status: "running", lease_until: null }] });
    await runOnce(m.repo, { "claude-desktop": fakeExecutor({ state: "failed", summary: "You've hit your limit", reason: "quota" }) });
    expect(m.tickets[0]!.status).toBe("ready");
    expect(m.backoff.has("claude-desktop")).toBe(true);
    expect(m.assignments[0]!.status).toBe("failed");
  });
  it("dispatches an unpinned ticket to the other backend while one is in backoff", async () => {
    const m = memRepo({ tickets: [{ status: "ready" }] });
    m.backoff.set("claude-desktop", new Date(Date.now() + 60_000).toISOString());
    launches.length = 0;
    const codex = { ...fakeExecutor({ state: "running", heartbeat: true }), kind: "codex" };
    await runOnce(m.repo, { "claude-desktop": fakeExecutor({ state: "running" }), codex }, { auditEnabled: () => false });
    expect(m.assignments.at(-1)?.executor).toBe("codex");
    expect(m.events.some((e) => String((e.payload as Record<string, unknown>)?.text ?? "").includes("改派 codex"))).toBe(true);
  });
});

describe("triage", () => {
  it("applies the clerk's call to an inbox ticket", async () => {
    const m = memRepo({ tickets: [{ status: "inbox", title: "按钮重叠" }] });
    await runOnce(m.repo, {}, { clerk: () => async () => ({ kind: "bug", priority: 2, status: "ready", area: ["renderer"], answer: null, reason: "明确的 bug" }) });
    expect(m.tickets[0]).toMatchObject({ status: "ready", kind: "bug", priority: 2, area: ["renderer"] });
  });
  it("closes a question with the clerk's answer in the stream", async () => {
    const m = memRepo({ tickets: [{ status: "inbox", title: "怎么跑？" }] });
    await runOnce(m.repo, {}, { clerk: () => async () => ({ kind: "question", priority: 3, status: "done", area: [], answer: "看 README", reason: "是个问题" }) });
    expect(m.tickets[0]!.status).toBe("done");
    expect(m.events.some((e) => e.kind === "comment" && (e.payload as { text: string }).text === "看 README")).toBe(true);
  });
  it("leaves inbox alone when the clerk is off, and records a failing clerk without spinning", async () => {
    const m = memRepo({ tickets: [{ status: "inbox" }] });
    await runOnce(m.repo, {}, { clerk: () => null });
    expect(m.tickets[0]!.status).toBe("inbox");
    const d = createDaemon({ db: fakeDb(), repo: m.repo, executors: {}, worktreeRoot: "/tmp", intervalMs: 60_000, clerk: () => async () => { throw new Error("no key"); } });
    await d.start();
    await d.tick();
    await d.stop();
    expect(m.tickets[0]!.status).toBe("inbox");
    expect(m.events.filter((e) => e.kind === "note").length).toBe(1);
  });
});

describe("audit", () => {
  it("starts a read-only audit in the worker's worktree once a PR exists", async () => {
    const m = memRepo({ tickets: [{ status: "review" }], assignments: [{ status: "done", pr_number: 7, pr_url: "https://x/pull/7" }] });
    launches.length = 0;
    await runOnce(m.repo, { "claude-desktop": fakeExecutor({ state: "running", heartbeat: true }) });
    expect(launches[0]).toMatchObject({ role: "audit", existing: { worktree: "/wt/demo/b", branch: "b" } });
    expect(String(launches[0]!.prompt)).toContain("AUDIT: PASS");
    expect(m.assignments.at(-1)).toMatchObject({ role: "audit", status: "running", pr_number: 7 });
    expect(m.tickets[0]!.status).toBe("review");
  });
  it("does not audit a round without a PR, nor twice", async () => {
    const m = memRepo({ tickets: [{ status: "review" }], assignments: [{ status: "done" }] });
    launches.length = 0;
    await runOnce(m.repo, { "claude-desktop": fakeExecutor({ state: "running" }) });
    expect(launches).toHaveLength(0);
    const m2 = memRepo({ tickets: [{ status: "review" }], assignments: [{ status: "done", pr_number: 7, pr_url: "u" }, { id: "a9", role: "audit", status: "running", started_at: "2026-01-02T00:00:00Z", lease_until: new Date(Date.now() + 60_000).toISOString() }] });
    await runOnce(m2.repo, { "claude-desktop": fakeExecutor({ state: "running", heartbeat: true }) });
    expect(launches).toHaveLength(0);
  });
  it("PASS moves the ticket to awaiting-merge", async () => {
    const m = memRepo({ tickets: [{ status: "review" }], assignments: [{ status: "done", pr_number: 7, pr_url: "u" }, { id: "a9", role: "audit", status: "running", started_at: "2026-01-02T00:00:00Z" }] });
    await runOnce(m.repo, { "claude-desktop": fakeExecutor({ state: "ready", summary: "fine\nAUDIT: PASS" }) });
    expect(m.tickets[0]!.status).toBe("awaiting-merge");
  });
  it("FAIL requeues with the findings, and the third FAIL goes to the human", async () => {
    const m = memRepo({ tickets: [{ status: "review" }], assignments: [{ status: "done", pr_number: 7, pr_url: "u" }, { id: "a9", role: "audit", status: "running", started_at: "2026-01-02T00:00:00Z" }] });
    launches.length = 0;
    // One tick: audit settles to FAIL → ready; dispatch then starts worker round 2 whose prompt carries the findings.
    await runOnce(m.repo, { "claude-desktop": fakeExecutor({ state: "ready", summary: "AC2 没测试\nAUDIT: FAIL" }) });
    expect(launches.at(-1)).toMatchObject({ role: "execute" });
    expect(String(launches.at(-1)!.prompt)).toContain("没通过，要修的：AC2 没测试");
    const audits = [1, 2, 3].map((i) => ({ id: `x${i}`, role: "audit", status: i === 3 ? "running" : "failed", started_at: `2026-01-0${i + 1}T00:00:00Z` }));
    const m3 = memRepo({ tickets: [{ status: "review" }], assignments: [{ status: "done", pr_number: 7, pr_url: "u" }, ...audits] });
    await runOnce(m3.repo, { "claude-desktop": fakeExecutor({ state: "ready", summary: "AUDIT: FAIL" }) });
    expect(m3.tickets[0]!.status).toBe("needs-human");
  });
  it("no verdict goes to the human", async () => {
    const m = memRepo({ tickets: [{ status: "review" }], assignments: [{ status: "done", pr_number: 7, pr_url: "u" }, { id: "a9", role: "audit", status: "running", started_at: "2026-01-02T00:00:00Z" }] });
    await runOnce(m.repo, { "claude-desktop": fakeExecutor({ state: "ready", summary: "I looked around" }) });
    expect(m.tickets[0]!.status).toBe("needs-human");
  });
});

describe("independent steps", () => {
  it("still dispatches when polling throws", async () => {
    const m = memRepo({ tickets: [{ status: "ready" }] });
    const broken = { ...m.repo, openAssignments: async () => { throw new Error("pg hiccup"); } } as unknown as Repo;
    launches.length = 0;
    const d = await runOnce(broken, { "claude-desktop": fakeExecutor({ state: "running" }) }, { auditEnabled: () => false });
    expect(launches).toHaveLength(1);
    expect(d.status().lastError).toContain("poll: pg hiccup");
  });
});
