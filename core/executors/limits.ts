/** Spots a worker that died on the subscription's limits rather than on the task. Both CLIs say so in prose;
 *  the daemon turns this into a ledger backoff instead of a needs-human. */
export function quotaReason(text: string): "quota" | null {
  return /rate.?limit|usage limit|hit your limit|limit reached|out of (credits|quota)|insufficient_quota|quota exceeded|too many requests|(?:status|http|code|error)\W{0,3}429\b|overloaded_error|reset(s)? at \d/i.test(text) ? "quota" : null;
}
