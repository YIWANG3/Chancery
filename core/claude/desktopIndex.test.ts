import { describe, expect, it } from "vitest";
import { sessionOpenFor, type DesktopSession } from "./desktopIndex.js";

const idx = new Map<string, DesktopSession>([["11111111-1111-4111-8111-111111111111", { sessionId: "local_x" } as DesktopSession]]);
const wt = "/tmp/wt";

describe("sessionOpenFor", () => {
  it("prefers Claude Desktop when its index knows the session", () => {
    expect(sessionOpenFor({ executor: "claude-desktop", session_ref: "11111111-1111-4111-8111-111111111111", worktree: wt }, idx)).toEqual({ kind: "desktop", desktopSessionId: "local_x" });
  });
  it("falls back to a terminal resume for a finished print worker", () => {
    expect(sessionOpenFor({ executor: "claude-desktop", session_ref: "22222222-2222-4222-8222-222222222222", worktree: wt }, idx)).toEqual({ kind: "terminal", bin: "claude", sessionId: "22222222-2222-4222-8222-222222222222", cwd: wt });
  });
  it("has nowhere to go while a print worker is still running, or without a worktree, or with a fake id", () => {
    expect(sessionOpenFor({ executor: "claude-desktop", session_ref: "print:abc", worktree: wt }, idx)).toBeNull();
    expect(sessionOpenFor({ executor: "claude-desktop", session_ref: "22222222-2222-4222-8222-222222222222", worktree: null }, idx)).toBeNull();
    expect(sessionOpenFor({ executor: "claude-desktop", session_ref: "fake-session-1", worktree: wt }, idx)).toBeNull();
  });
  it("resumes a Codex thread in a terminal", () => {
    expect(sessionOpenFor({ executor: "codex", session_ref: "01a1a92c-09c6-75f2-adc6-6169b9473d4b", worktree: wt }, idx)).toEqual({ kind: "terminal", bin: "codex", sessionId: "01a1a92c-09c6-75f2-adc6-6169b9473d4b", cwd: wt });
    expect(sessionOpenFor({ executor: "codex", session_ref: "codex:assignment", worktree: wt }, idx)).toBeNull();
  });
});
