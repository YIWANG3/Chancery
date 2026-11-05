import { describe, expect, it } from "vitest";
import { executePrompt } from "./prompts.js";
import type { Event, Project, Ticket } from "./types.js";

const project = { id: "p", name: "demo", repo: null, default_branch: "main", dir: "/repo", worktree_root: "/wt", platform: {}, default_executor: "codex", default_model: null, parallel: 1, github_sync: false, created_at: "" } as Project;
const ticket = { id: "t", seq: 3, title: "fix it", body: "do the thing", spec_path: null } as Ticket;
const ev = (kind: Event["kind"], actor: string, payload: Record<string, unknown>): Event => ({ id: kind, at: "2026-11-03T10:00:00Z", ticket_id: "t", assignment_id: null, actor, kind, payload, external_id: null });

describe("executePrompt history", () => {
  it("has no history section on a first round", () => {
    expect(executePrompt(ticket, project, { worktree: "/wt/demo/ticket-3-fix-it", branch: "ticket-3-fix-it" })).not.toContain("上一轮");
  });
  it("carries the worker's question and the human's answer into the next round", () => {
    const events = [ev("question", "codex", { summary: "found it", question: "A or B?" }), ev("answer", "human", { text: "B" })];
    const p = executePrompt(ticket, project, { worktree: "/wt/demo/ticket-3-fix-it", branch: "ticket-3-fix-it" }, { events, previous: { branch: "ticket-3-fix-it", worktree: "/wt/demo/ticket-3-fix-it", pr_url: null } });
    expect(p).toContain("问：A or B?");
    expect(p).toContain("我（11/3");
    expect(p).toContain("答：B");
    expect(p).toContain("就在当前目录");
    expect(p).toContain("不要再问一遍");
  });
  it("tells a worker in a different worktree where the earlier branch is", () => {
    const p = executePrompt(ticket, project, null, { events: [], previous: { branch: "claude/fix-it", worktree: "/repo/.claude/worktrees/fix-it", pr_url: "https://github.com/a/b/pull/9" } });
    expect(p).toContain("git merge claude/fix-it");
    expect(p).toContain("pull/9");
  });
});

describe("audit", () => {
  it("parses the last verdict line, case-insensitively", async () => {
    const { parseAuditVerdict } = await import("./prompts.js");
    expect(parseAuditVerdict("发现：…\n\nAUDIT: FAIL")).toBe("fail");
    expect(parseAuditVerdict("all good\naudit: pass\n")).toBe("pass");
    expect(parseAuditVerdict("AUDIT: FAIL\n…reconsidered…\nAUDIT: PASS")).toBe("pass");
    expect(parseAuditVerdict("looks fine")).toBeNull();
  });
  it("tells the auditor it is read-only and how to end", async () => {
    const { auditPrompt } = await import("./prompts.js");
    const p = auditPrompt(ticket, project, { round: 2, pr: { number: 7, url: "https://github.com/a/b/pull/7" }, branch: "ticket-3-fix-it" });
    expect(p).toContain("第 2 轮");
    expect(p).toContain("pull/7");
    expect(p).toContain("不改任何文件");
    expect(p).toContain("AUDIT: PASS");
  });
  it("feeds a failed audit into the next worker round", () => {
    const events = [ev("report", "codex:audit", { state: "audit-failed", summary: "AC2 没有测试\nAUDIT: FAIL" })];
    const p = executePrompt(ticket, project, null, { events, previous: null });
    expect(p).toContain("审计（11/3");
    expect(p).toContain("没通过，要修的：AC2 没有测试");
  });
  it("asks a backend-made worktree to run setup first", () => {
    const withSetup = { ...project, platform: { setup: "npm ci" } } as Project;
    expect(executePrompt(ticket, withSetup, null)).toContain("先在 worktree 里跑一次：npm ci");
    expect(executePrompt(ticket, withSetup, { worktree: "/wt", branch: "b" })).not.toContain("npm ci");
  });
});
