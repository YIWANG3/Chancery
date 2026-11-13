import { describe, expect, it } from "vitest";
import type { Overview, SessionRow } from "./overview.js";
import { ALERT_FRESH_MS, HELD_UP_WINDOW_MS, alertKindOf, createAlertTracker, heldUpSessions } from "./sessionAlerts.js";

const NOW = 1_000_000_000_000;

const row = (over: Partial<SessionRow>): SessionRow => ({ app: "claude", id: "s1", title: "标题", at: NOW, cwd: "/w/a", projectKey: "/w/a", open: null, parent: null, state: "done", detail: "", basis: "", turn: "", ...over });

const overview = (sessions: SessionRow[], readAt = NOW): Overview => ({
  sessions,
  projects: [{ key: "/w/a", name: "a", dir: "/w/a", apps: ["claude", "codex"], sessions: sessions.length, counts: { "needs-you": 0, error: 0, stuck: 0, running: 0, delegated: 0, review: 0, unread: 0, interrupted: 0, expired: 0, done: 0 }, lastAt: NOW }],
  readAt,
  errors: [],
  sources: { claude: true, codex: true },
});

/** A tracker that has already seen one quiet session from each app, so both are past their baseline. */
const started = () => {
  const t = createAlertTracker();
  t.feed(overview([row({ id: "s1", state: "running" }), row({ app: "codex", id: "t1", state: "running" })]));
  return t;
};

describe("alertKindOf", () => {
  it("never announces a state that has no turn behind it", () => {
    expect(alertKindOf({ app: "claude", state: "done", turn: "" })).toBeNull();
    expect(alertKindOf({ app: "claude", state: "needs-you", turn: "" })).toBeNull();
  });
  it("announces a held-up or reviewable session as what it is", () => {
    for (const state of ["needs-you", "error", "stuck", "review"] as const) expect(alertKindOf({ app: "claude", state, turn: "u1" })).toBe(state);
  });
  it("treats a finished Claude turn and an unread Codex thread as finished, and a read Codex thread as seen", () => {
    expect(alertKindOf({ app: "claude", state: "done", turn: "u1" })).toBe("finished");
    expect(alertKindOf({ app: "codex", state: "unread", turn: "3" })).toBe("finished");
    expect(alertKindOf({ app: "codex", state: "done", turn: "3" })).toBeNull();
  });
  it("says nothing about running or interrupted sessions", () => {
    expect(alertKindOf({ app: "codex", state: "running", turn: "" })).toBeNull();
    expect(alertKindOf({ app: "codex", state: "interrupted", turn: "3" })).toBeNull();
    expect(alertKindOf({ app: "codex", state: "expired", turn: "3" })).toBeNull();
  });
});

describe("createAlertTracker", () => {
  it("records what is already waiting when it starts instead of announcing it", () => {
    const t = createAlertTracker();
    const waiting = [row({ id: "s1", state: "needs-you", turn: "u1" }), row({ app: "codex", id: "t1", state: "unread", turn: "2" })];
    expect(t.feed(overview(waiting))).toEqual([]);
    expect(t.feed(overview(waiting))).toEqual([]);
  });

  it("announces a session once when it stops to wait, with its project's name", () => {
    const t = started();
    const blocked = overview([row({ id: "s1", state: "needs-you", turn: "u1", detail: "选 A 还是 B" })]);
    expect(t.feed(blocked)).toMatchObject([{ kind: "needs-you", project: "a", session: { id: "s1", detail: "选 A 还是 B" } }]);
    expect(t.feed(blocked)).toEqual([]);
  });

  it("announces again when the same session ends a later turn in the same state", () => {
    const t = started();
    expect(t.feed(overview([row({ state: "needs-you", turn: "u1" })]))).toHaveLength(1);
    expect(t.feed(overview([row({ state: "needs-you", turn: "u2" })]))).toHaveLength(1);
  });

  it("waits for the summary: a finished turn is announced when it settles, not while it has no turn", () => {
    const t = started();
    expect(t.feed(overview([row({ state: "done", turn: "" })]))).toEqual([]);
    expect(t.feed(overview([row({ state: "done", turn: "u1", detail: "测试全过" })]))).toMatchObject([{ kind: "finished" }]);
  });

  it("stays quiet when a source fails for one read and comes back", () => {
    const t = started();
    const unread = row({ app: "codex", id: "t1", state: "unread", turn: "4" });
    expect(t.feed(overview([unread]))).toHaveLength(1);
    // The history database could not be read: the thread looks finished with no turn on record.
    expect(t.feed(overview([{ ...unread, state: "done", turn: "" }]))).toEqual([]);
    expect(t.feed(overview([unread]))).toEqual([]);
  });

  it("does not announce a Codex thread that was read before the tracker looked", () => {
    const t = started();
    expect(t.feed(overview([row({ app: "codex", id: "t1", state: "done", turn: "4" })]))).toEqual([]);
  });

  it("drops a turn that ended long ago, and does not bring it up later either", () => {
    const t = started();
    const old = row({ state: "done", turn: "u1", at: NOW - ALERT_FRESH_MS - 1 });
    expect(t.feed(overview([old]))).toEqual([]);
    expect(t.feed(overview([{ ...old, at: NOW }]))).toEqual([]);
  });

  it("announces a stuck session even though nothing has moved for a long time", () => {
    const t = started();
    expect(t.feed(overview([row({ app: "codex", id: "t1", state: "stuck", turn: "4", at: NOW - 2 * ALERT_FRESH_MS })]))).toMatchObject([{ kind: "stuck" }]);
  });

  it("takes each app's baseline separately", () => {
    const t = createAlertTracker();
    t.feed(overview([row({ id: "s1", state: "running" })])); // only Claude seen so far
    const both = overview([row({ id: "s2", state: "review", turn: "u9" }), row({ app: "codex", id: "t1", state: "unread", turn: "1" })]);
    expect(t.feed(both).map((a) => a.session.id)).toEqual(["s2"]);
  });
});

describe("heldUpSessions", () => {
  it("counts sessions waiting on a person, leaving out old ones and ones merely waiting to be looked at", () => {
    const o = overview([
      row({ id: "a", state: "needs-you" }),
      row({ id: "b", state: "error" }),
      row({ id: "c", state: "stuck" }),
      row({ id: "d", state: "review" }),
      row({ id: "e", state: "needs-you", at: NOW - HELD_UP_WINDOW_MS - 1 }),
    ]);
    expect(heldUpSessions(o).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});
