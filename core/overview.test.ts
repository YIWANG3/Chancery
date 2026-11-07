import { describe, expect, it } from "vitest";
import { CODEX_STALE_MS, OTHER_PROJECT_KEY, attentionOf, classifyClaude, classifyCodex, groupByProject, stripWorktree, type SessionRow } from "./overview.js";

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
  });
  it("carries the failure message", () => {
    expect(classifyCodex(facts({ turnStatus: "failed", errorJson: '{"message":"You\'ve hit your usage limit."}' }), now)).toMatchObject({ state: "error", detail: "You've hit your usage limit." });
    expect(classifyCodex(facts({ turnStatus: "failed", errorJson: "not json" }), now)).toMatchObject({ state: "error", detail: "" });
  });
  it("tells unread from read for a completed turn", () => {
    expect(classifyCodex(facts({ unread: true }), now).state).toBe("unread");
    expect(classifyCodex(facts({ unread: false }), now).state).toBe("done");
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
  const row = (over: Partial<SessionRow>): SessionRow => ({ app: "claude", id: "x", title: "", at: 0, cwd: "", projectKey: "/w/a", open: null, state: "done", detail: "", basis: "", turn: "", ...over });

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
  it("names the catch-all group and gives it no directory", () => {
    const { projects } = groupByProject([row({ projectKey: OTHER_PROJECT_KEY })]);
    expect(projects[0]).toMatchObject({ name: "其他", dir: null });
  });
});
