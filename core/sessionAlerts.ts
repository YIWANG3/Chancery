// Which sessions deserve a notification, decided from successive overviews. Pure: no clock, no I/O. Only types are
// imported from the overview, so the renderer can use the helpers here without pulling in the readers.
import type { Overview, SessionApp, SessionRow, SessionState } from "./overview.js";

export type AlertKind = "needs-you" | "error" | "stuck" | "review" | "finished";

export interface SessionAlert {
  kind: AlertKind;
  session: SessionRow;
  /** The project group's name, for the notification's second line. */
  project: string;
}

/** A turn that ended longer ago than this is not announced: it is something the tracker is only now learning about
 *  (the app rewrote an old session's file, a source came back after failing), not something that just happened. */
export const ALERT_FRESH_MS = 30 * 60_000;

/** The count on the dock, the menu bar item and the navigation covers sessions active within this long, so one that
 *  was left blocked days ago does not sit in the count forever. */
export const HELD_UP_WINDOW_MS = 3 * 86_400_000;

const HELD_UP: ReadonlySet<SessionState> = new Set<SessionState>(["needs-you", "error", "stuck"]);

/** Whether a session in this state is stopped until a person does something. */
export const isHeldUp = (state: SessionState): boolean => HELD_UP.has(state);

/** The recently active sessions that are stopped until a person does something, in the overview's own order. */
export function heldUpSessions(overview: Pick<Overview, "sessions" | "readAt">): SessionRow[] {
  const since = overview.readAt - HELD_UP_WINDOW_MS;
  return overview.sessions.filter((s) => isHeldUp(s.state) && s.at >= since);
}

/**
 * What, if anything, a session's current state is worth announcing as.
 *
 * A state with no turn behind it has not settled (still running, or finished but not yet summarised), so it is never
 * announced. "Finished" means different things in the two apps because they record different things: Codex marks a
 * thread unread until it is opened, so a finished turn that was already read was seen and needs no announcement;
 * Claude Desktop has no read marker in its index, so every summarised end of turn counts.
 */
export function alertKindOf(s: Pick<SessionRow, "app" | "state" | "turn">): AlertKind | null {
  if (!s.turn) return null;
  switch (s.state) {
    case "needs-you":
    case "error":
    case "stuck":
    case "review":
      return s.state;
    case "unread":
      return "finished";
    case "done":
      return s.app === "claude" ? "finished" : null;
    default:
      return null;
  }
}

export interface AlertTracker {
  /** Takes the next overview and returns what became worth announcing since the previous one. */
  feed(overview: Overview): SessionAlert[];
}

/**
 * Remembers what was already announced, so each turn of each session is announced once.
 *
 * - The first overview that contains an app's sessions is that app's baseline: whatever is already waiting when the
 *   tracker starts is recorded, not announced.
 * - What is remembered is the last announcement per session, not the last state seen. A source that fails for one
 *   read makes its sessions look finished for that read; when it comes back they match what was already announced
 *   and stay quiet.
 */
export function createAlertTracker(): AlertTracker {
  const announced = new Map<string, string>();
  const baselined = new Set<SessionApp>();
  return {
    feed(overview) {
      const names = new Map(overview.projects.map((p) => [p.key, p.name]));
      const present = new Set(overview.sessions.map((s) => s.app));
      const out: SessionAlert[] = [];
      for (const s of overview.sessions) {
        const kind = alertKindOf(s);
        if (!kind) continue;
        const key = `${s.app}:${s.id}`;
        const mark = `${kind}:${s.turn}`;
        if (announced.get(key) === mark) continue;
        announced.set(key, mark);
        if (!baselined.has(s.app)) continue;
        // "Stuck" is by definition about something that stopped moving a while ago.
        if (kind !== "stuck" && overview.readAt - s.at > ALERT_FRESH_MS) continue;
        out.push({ kind, session: s, project: names.get(s.projectKey) ?? "" });
      }
      for (const app of present) baselined.add(app);
      return out;
    },
  };
}
