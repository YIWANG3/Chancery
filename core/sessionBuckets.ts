// The ten session states folded into the four questions a person asks of the list: who is waiting on me, what is
// there to look at, what is still going, and what is over. Kept apart from overview.ts, which reads files, so the
// pages can use the table too.
import type { SessionState } from "./overview.js";

export type SessionBucket = "needs" | "look" | "running" | "ended";

export const SESSION_BUCKET: Record<SessionState, SessionBucket> = {
  "needs-you": "needs",
  error: "needs",
  stuck: "needs",
  review: "look",
  unread: "look",
  running: "running",
  delegated: "running",
  interrupted: "ended",
  expired: "ended",
  done: "ended",
};
