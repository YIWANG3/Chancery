import { describe, expect, it } from "vitest";
import { CODEX_STALE_MS, OTHER_PROJECT_KEY, OUTCOME_FACTS, PROCESS_FACTS, UNREAD_EXPIRE_MS, attentionOf, claudeFacts, classifyClaude, classifyCodex, decide, decideAll, groupByProject, stripWorktree, type PreparedRow, type SessionFacts, type SessionRow } from "./overview.js";

describe("decide: one table for every source", () => {
  const base: SessionFacts = { process: "idle", waitingOn: "等你批一个权限", outcome: "completed", outcomeDetail: "上一轮的话", seen: true, childrenRunning: [], idleMs: 60_000, basis: "source.field", turn: "t1", unseenBasis: "unopened" };
  const CHILDREN = { none: [], "at work": ["子会话"] } as const;
  const AGE = { fresh: 60_000, old: UNREAD_EXPIRE_MS + 60_000 } as const;
  const every: Array<{ facts: SessionFacts; line: string }> = [];
  for (const process of PROCESS_FACTS)
    for (const outcome of OUTCOME_FACTS)
      for (const seen of [true, false])
        for (const children of ["none", "at work"] as const)
          for (const age of ["fresh", "old"] as const) {
            const facts = { ...base, process, outcome, seen, childrenRunning: [...CHILDREN[children]], idleMs: AGE[age] };
            every.push({ facts, line: `${process.padEnd(8)} ${outcome.padEnd(12)} ${(seen ? "seen" : "unseen").padEnd(7)} children ${children.padEnd(8)} ${age.padEnd(6)} → ${decide(facts).state}` });
          }

  it("covers every combination of the four axes; the whole table is the snapshot", () => {
    expect(every).toHaveLength(PROCESS_FACTS.length * OUTCOME_FACTS.length * 2 * 2 * 2);
    expect(every.map((e) => e.line).join("\n")).toMatchSnapshot();
  });
  it("lets a live process outrank whatever the last turn said", () => {
    for (const { facts } of every) {
      const { state, turn } = decide(facts);
      if (facts.process === "running") expect([state, turn]).toEqual(["running", ""]);
      if (facts.process === "stalled") expect(state).toBe("stuck");
      if (facts.process === "waiting") expect([state, decide(facts).detail]).toEqual(["needs-you", "等你批一个权限"]);
    }
  });
  it("keeps a failed turn the session's own problem, sub-sessions or not", () => {
    for (const { facts } of every) if (facts.process === "idle" && facts.outcome === "failed") expect(decide(facts).state).toBe("error");
  });
  it("waits on sub-sessions at work whatever else the turn said, short of a failure", () => {
    for (const { facts } of every) {
      if (facts.process !== "idle" || facts.outcome === "failed") continue;
      const v = decide(facts);
      if (facts.childrenRunning.length) expect(v).toMatchObject({ state: "delegated", detail: "等 1 个子会话：子会话", basis: "source.field + sub-sessions at work" });
      else expect(v.state).not.toBe("delegated");
    }
  });
  it("reads a settled turn by its outcome, then by whether it was seen, then by how long it sat", () => {
    for (const { facts } of every) {
      if (facts.process !== "idle" || facts.childrenRunning.length) continue;
      const { state } = decide(facts);
      const expected = { asked: "needs-you", failed: "error", review: "review", interrupted: "interrupted" }[facts.outcome as string] ?? (facts.seen ? "done" : facts.idleMs > UNREAD_EXPIRE_MS ? "expired" : "unread");
      expect(state, JSON.stringify(facts)).toBe(expected);
    }
  });
  it("carries the turn through every settled state, so alerts can fire once per turn", () => {
    for (const { facts } of every) if (facts.process !== "running") expect(decide(facts).turn).toBe("t1");
  });
  it("names the sub-sessions it waits on, up to three, in the person's language", () => {
    const f = { ...base, childrenRunning: ["a", "b", "c", "d"] };
    expect(decide(f).detail).toBe("等 4 个子会话：a、b、c…");
    expect(decide(f, "en").detail).toBe("Waiting on 4 sub-sessions: a, b, c…");
    expect(decide({ ...base, childrenRunning: ["", ""] }, "en").detail).toBe("Waiting on 2 sub-sessions");
  });
});

describe("decideAll: families", () => {
  const facts = (over: Partial<SessionFacts>): SessionFacts => ({ process: "idle", waitingOn: "", outcome: "completed", outcomeDetail: "", seen: true, childrenRunning: [], idleMs: 1000, basis: "b", turn: "t", unseenBasis: "unread", ...over });
  const row = (id: string, over: Partial<Omit<PreparedRow, "facts">> & { facts?: Partial<SessionFacts> }): PreparedRow => ({ app: "claude", id, title: id, at: 0, cwd: "/w", open: null, parent: null, ...over, facts: facts(over.facts ?? {}) });
  const states = (rows: PreparedRow[]) => Object.fromEntries(decideAll(rows).map((r) => [r.id, r.state]));

  it("makes a parent wait on a child that is running, stuck, waiting on a person, or itself waiting on grandchildren", () => {
    for (const child of [{ process: "running" }, { process: "stalled" }, { process: "waiting" }, { outcome: "asked" }] as Partial<SessionFacts>[]) {
      expect(states([row("p", { facts: { outcome: "asked" } }), row("c", { parent: "claude:p", facts: child })]).p, JSON.stringify(child)).toBe("delegated");
    }
    expect(states([row("p", {}), row("c", { parent: "claude:p" }), row("g", { parent: "claude:c", facts: { process: "running" } })])).toEqual({ p: "delegated", c: "delegated", g: "running" });
  });
  it("lets the parent speak for itself once every child has stopped, failed included", () => {
    expect(states([row("p", { facts: { outcome: "asked" } }), row("c", { parent: "claude:p" })]).p).toBe("needs-you");
    expect(states([row("p", {}), row("c", { parent: "claude:p", facts: { outcome: "failed" } })])).toEqual({ p: "done", c: "error" });
  });
  it("names the children it waits on and says so in the basis", () => {
    const [p] = decideAll([row("p", { facts: { basis: "postTurnSummary.blocked" } }), row("子一", { parent: "claude:p", facts: { process: "running" } }), row("子二", { parent: "claude:p", facts: { outcome: "asked" } })]);
    expect(p).toMatchObject({ state: "delegated", detail: "等 2 个子会话：子一、子二", basis: "postTurnSummary.blocked + sub-sessions at work" });
  });
  it("keeps the apps apart by key, ignores a parent that is not listed, and survives a cycle", () => {
    expect(states([row("p", {}), row("c", { app: "codex", parent: "claude:p", facts: { process: "running" } }), row("x", { parent: "codex:p", facts: { process: "running" } })])).toEqual({ p: "delegated", c: "running", x: "running" });
    expect(states([row("c", { parent: "claude:gone", facts: { process: "running" } })])).toEqual({ c: "running" });
    expect(states([row("a", { parent: "claude:b", facts: { outcome: "asked" } }), row("b", { parent: "claude:a", facts: { outcome: "asked" } })])).toEqual({ a: "needs-you", b: "needs-you" });
  });
  it("hands every row back with its fields, in the order given", () => {
    const out = decideAll([row("p", { title: "父", at: 5, cwd: "/w/p", open: { kind: "desktop", desktopSessionId: "p" } }), row("c", { parent: "claude:p", facts: { process: "running" } })]);
    expect(out.map((r) => r.id)).toEqual(["p", "c"]);
    expect(out[0]).toMatchObject({ app: "claude", id: "p", title: "父", at: 5, cwd: "/w/p", open: { kind: "desktop", desktopSessionId: "p" }, parent: null, state: "delegated" });
    expect(out[1]).toMatchObject({ parent: "claude:p", state: "running", turn: "" });
  });
});

describe("classifyClaude", () => {
  const reply = { lastAssistantUuid: "u1", postTurnSummaryFor: "u1" };

  it("is running whenever the CLI reports the process busy, whatever the index still says", () => {
    expect(classifyClaude({ ...reply, postTurnSummary: { status_category: "blocked", needs_action: "选一个" } }, "busy").state).toBe("running");
  });
  it("needs you when the summary is blocked, and says what it needs", () => {
    expect(classifyClaude({ ...reply, postTurnSummary: { status_category: "blocked", status_detail: "卡在选型", needs_action: "选路线 1 或 2" } }, "idle")).toEqual({
      state: "needs-you",
      detail: "选路线 1 或 2",
      basis: "postTurnSummary.blocked",
      turn: "u1",
    });
  });
  it("needs you when a summary names an action even under another category", () => {
    expect(classifyClaude({ ...reply, postTurnSummary: { status_category: "completed", needs_action: "确认导出" } }, undefined).state).toBe("needs-you");
  });
  it("is up for review when the summary says so", () => {
    expect(classifyClaude({ ...reply, postTurnSummary: { status_category: "review_ready", status_detail: "PR #201 已开" } }, "idle")).toMatchObject({ state: "review", detail: "PR #201 已开" });
  });
  it("is done with the summary's line when completed", () => {
    expect(classifyClaude({ ...reply, postTurnSummary: { status_category: "completed", status_detail: "测试全过" } }, undefined)).toMatchObject({ state: "done", detail: "测试全过" });
  });
  describe("a completed turn that landed after the session was last brought up", () => {
    const completed = { ...reply, postTurnSummary: { status_category: "completed", status_detail: "测试全过" } };
    const now = 1_000_000_000_000;
    it("is unread, with the summary's line and a basis that says why", () => {
      expect(classifyClaude({ ...completed, lastFocusedAt: now - 60_000, lastActivityAt: now - 1_000 }, "idle", { now })).toEqual({ state: "unread", detail: "测试全过", basis: "postTurnSummary.completed + unopened", turn: "u1" });
    });
    it("is done once the session was brought up again, or while it is the one being watched", () => {
      expect(classifyClaude({ ...completed, lastFocusedAt: now - 500, lastActivityAt: now - 1_000 }, "idle", { now }).state).toBe("done");
      expect(classifyClaude({ ...completed, lastFocusedAt: now - 60_000, lastActivityAt: now - 1_000 }, "idle", { now, watched: true }).state).toBe("done");
    });
    it("is done when the index has never stamped the session focused (older entries)", () => {
      expect(classifyClaude({ ...completed, lastActivityAt: now - 1_000 }, "idle", { now }).state).toBe("done");
    });
    it("expires after a day unopened, like a Codex thread", () => {
      expect(classifyClaude({ ...completed, lastFocusedAt: now - UNREAD_EXPIRE_MS - 120_000, lastActivityAt: now - UNREAD_EXPIRE_MS - 60_000 }, "idle", { now })).toMatchObject({ state: "expired", detail: "完成后 1 天没打开" });
    });
    it("does not outrank a blocked or review summary", () => {
      expect(classifyClaude({ ...reply, lastFocusedAt: now - 60_000, lastActivityAt: now - 1_000, postTurnSummary: { status_category: "review_ready", status_detail: "PR 已开" } }, "idle", { now }).state).toBe("review");
    });
  });
  it("ignores a summary written for an earlier reply", () => {
    expect(classifyClaude({ lastAssistantUuid: "u2", postTurnSummaryFor: "u1", postTurnSummary: { status_category: "blocked", needs_action: "旧的" } }, "idle")).toMatchObject({ state: "done", detail: "" });
  });
  it("is done with nothing to say when there is no summary", () => {
    expect(classifyClaude({ title: "old session" }, undefined)).toEqual({ state: "done", detail: "", basis: "no summary", turn: "" });
  });
  it("names the turn only once a summary describes the last reply, so nothing is announced before it settles", () => {
    expect(classifyClaude({ ...reply, postTurnSummary: { status_category: "completed" } }, "idle").turn).toBe("u1");
    expect(classifyClaude({ ...reply, postTurnSummary: { status_category: "completed" } }, "busy").turn).toBe("");
    expect(classifyClaude({ lastAssistantUuid: "u2", postTurnSummaryFor: "u1", postTurnSummary: { status_category: "completed" } }, "idle").turn).toBe("");
    expect(classifyClaude({ error: "limit", errorAt: 200, latestUserFrameAt: 100 }, "idle").turn).toBe("error:200");
  });
  it("is held on the person while the process waits on a prompt, whatever the summary says, and says on what", () => {
    expect(decide(claudeFacts({ ...reply, lastActivityAt: 5, postTurnSummary: { status_category: "completed" } }, { status: "waiting", waitingFor: "permission prompt" }))).toEqual({ state: "needs-you", detail: "等你批一个权限", basis: "claude agents: waiting (permission prompt)", turn: "waiting:5" });
    expect(decide(claudeFacts({}, { status: "waiting", waitingFor: "sandbox request" }, { lang: "en" }), "en").detail).toBe("Waiting for you to answer a sandbox request");
    expect(decide(claudeFacts({}, { status: "waiting" }, { lang: "en" }), "en").detail).toBe("Waiting for your input");
    expect(decide(claudeFacts({}, { status: "waiting", waitingFor: "something new" })).detail).toBe("等你：something new");
  });
  it("waits on its sub-sessions while any is at work, even when it stopped on a question", () => {
    const blocked = { ...reply, postTurnSummary: { status_category: "blocked", needs_action: "确认两个子会话的计划" } };
    expect(classifyClaude(blocked, "idle", { childrenRunning: ["多级文件夹", "tag 重梳"] })).toEqual({ state: "delegated", detail: "等 2 个子会话：多级文件夹、tag 重梳", basis: "postTurnSummary.blocked + sub-sessions at work", turn: "u1" });
    expect(classifyClaude(blocked, "idle", { childrenRunning: ["nested folders"], lang: "en" }).detail).toBe("Waiting on 1 sub-session: nested folders");
    expect(classifyClaude(blocked, "busy", { childrenRunning: ["多级文件夹"] }).state).toBe("running");
  });
  it("shows an error only while nothing was sent after it", () => {
    const limit = "You've hit your session limit";
    expect(classifyClaude({ error: limit, errorAt: 200, latestUserFrameAt: 100 }, "idle")).toMatchObject({ state: "error", detail: limit });
    expect(classifyClaude({ error: limit, errorAt: 100, latestUserFrameAt: 200 }, "idle").state).toBe("done");
  });
});

describe("classifyCodex", () => {
  const now = 1_000_000_000_000;
  const facts = (over: Partial<Parameters<typeof classifyCodex>[0]>) => ({ turnStatus: "completed", turnOrdinal: 3, errorJson: null, unread: false, lastActivityAt: now, ...over });

  it("is running while a turn is in progress and something moved recently", () => {
    expect(classifyCodex(facts({ turnStatus: "inProgress", lastActivityAt: now - 60_000 }), now).state).toBe("running");
  });
  it("is stuck when an in-progress turn has been silent past the threshold", () => {
    expect(classifyCodex(facts({ turnStatus: "inProgress", lastActivityAt: now - CODEX_STALE_MS - 60_000 }), now)).toMatchObject({ state: "stuck", detail: "31 分钟没有动静" });
    expect(classifyCodex(facts({ turnStatus: "inProgress", lastActivityAt: now - CODEX_STALE_MS - 60_000 }), now, "en")).toMatchObject({ state: "stuck", detail: "No activity for 31 minutes" });
  });
  it("carries the failure message", () => {
    expect(classifyCodex(facts({ turnStatus: "failed", errorJson: '{"message":"You\'ve hit your usage limit."}' }), now)).toMatchObject({ state: "error", detail: "You've hit your usage limit." });
    expect(classifyCodex(facts({ turnStatus: "failed", errorJson: "not json" }), now)).toMatchObject({ state: "error", detail: "" });
  });
  it("tells unread from read for a completed turn", () => {
    expect(classifyCodex(facts({ unread: true }), now).state).toBe("unread");
    expect(classifyCodex(facts({ unread: false }), now).state).toBe("done");
  });
  it("expires an unread thread nobody opened for a day, and says how long it sat", () => {
    expect(classifyCodex(facts({ unread: true, lastActivityAt: now - UNREAD_EXPIRE_MS + 60_000 }), now).state).toBe("unread");
    expect(classifyCodex(facts({ unread: true, lastActivityAt: now - 3 * UNREAD_EXPIRE_MS - 60_000 }), now)).toMatchObject({ state: "expired", detail: "完成后 3 天没打开", turn: "3" });
    // Read threads were seen; they end as done however old they are.
    expect(classifyCodex(facts({ unread: false, lastActivityAt: now - 10 * UNREAD_EXPIRE_MS }), now).state).toBe("done");
  });
  it("keeps interrupted apart from done, and treats a thread with no turn as done", () => {
    expect(classifyCodex(facts({ turnStatus: "interrupted", unread: true }), now).state).toBe("interrupted");
    expect(classifyCodex(facts({ turnStatus: null, turnOrdinal: null }), now)).toMatchObject({ state: "done", basis: "no turn", turn: "" });
  });
  it("names the turn by its position in the thread, and not at all while it is still running", () => {
    expect(classifyCodex(facts({ unread: true }), now).turn).toBe("3");
    expect(classifyCodex(facts({ turnStatus: "inProgress" }), now).turn).toBe("");
    expect(classifyCodex(facts({ turnStatus: "inProgress", lastActivityAt: now - CODEX_STALE_MS - 1 }), now).turn).toBe("3");
  });
});

describe("stripWorktree", () => {
  it("folds both apps' worktree directories back to the repository", () => {
    expect(stripWorktree("/w/AfterFrame/.claude/worktrees/beautiful-rosalind")).toBe("/w/AfterFrame");
    expect(stripWorktree("/w/AfterFrame/.chancery/worktrees/ticket-8/apps/desktop")).toBe("/w/AfterFrame");
    expect(stripWorktree("/w/AfterFrame/apps/desktop")).toBe("/w/AfterFrame/apps/desktop");
  });
});

describe("groupByProject", () => {
  const row = (over: Partial<SessionRow>): SessionRow => ({ app: "claude", id: "x", title: "", at: 0, cwd: "", projectKey: "/w/a", open: null, parent: null, state: "done", detail: "", basis: "", turn: "", ...over });

  it("puts what needs a person first, newest first within a state", () => {
    const { sessions } = groupByProject([
      row({ id: "done-new", state: "done", at: 30 }),
      row({ id: "running", state: "running", at: 10 }),
      row({ id: "needs-old", state: "needs-you", at: 1 }),
      row({ id: "needs-new", state: "needs-you", at: 2 }),
      row({ id: "error", state: "error", at: 5 }),
    ]);
    expect(sessions.map((s) => s.id)).toEqual(["needs-new", "needs-old", "error", "running", "done-new"]);
  });
  it("merges both apps into one project and counts states", () => {
    const { projects } = groupByProject([row({ app: "claude", state: "needs-you", at: 5 }), row({ app: "codex", state: "running", at: 9 }), row({ app: "codex", state: "done", at: 1 })]);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ key: "/w/a", name: "a", dir: "/w/a", apps: ["claude", "codex"], sessions: 3, lastAt: 9 });
    expect(projects[0]!.counts).toMatchObject({ "needs-you": 1, running: 1, done: 1 });
    expect(attentionOf(projects[0]!.counts)).toBe(1);
  });
  it("orders projects by how many sessions are held up, then running, then recency", () => {
    const { projects } = groupByProject([
      row({ projectKey: "/w/quiet", state: "done", at: 99 }),
      row({ projectKey: "/w/busy", state: "running", at: 2 }),
      row({ projectKey: "/w/blocked", state: "needs-you", at: 1 }),
    ]);
    expect(projects.map((p) => p.name)).toEqual(["blocked", "busy", "quiet"]);
  });
  it("lists sessions by state: held up, then running, then waiting to be looked at, then ended; newest first within a state", () => {
    const { sessions } = groupByProject([
      row({ app: "codex", state: "unread", at: 50 }),
      row({ app: "codex", state: "unread", at: 60 }),
      row({ app: "claude", state: "done", at: 99 }),
      row({ app: "claude", state: "running", at: 1 }),
      row({ app: "claude", state: "review", at: 70 }),
      row({ app: "claude", state: "needs-you", at: 2 }),
    ]);
    expect(sessions.map((s) => `${s.state}@${s.at}`)).toEqual(["needs-you@2", "running@1", "review@70", "unread@60", "unread@50", "done@99"]);
  });
  it("names the catch-all group and gives it no directory", () => {
    const { projects } = groupByProject([row({ projectKey: OTHER_PROJECT_KEY })]);
    expect(projects[0]).toMatchObject({ name: "其他", dir: null });
    expect(groupByProject([row({ projectKey: OTHER_PROJECT_KEY })], "en").projects[0]).toMatchObject({ name: "Other" });
  });
});
