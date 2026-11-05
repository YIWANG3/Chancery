/** Workers without a wrap_up tool (claude -p, codex exec) end with plain text. This guesses whether that text is a
 *  question for the human rather than a report. Conservative on purpose: a report with no PR is "done, look at it",
 *  not "waiting for an answer". */
export function looksLikeQuestion(text: string): boolean {
  const tail = text.trim().slice(-600);
  if (!tail) return false;
  // "没有需要你决定的事" is a report, not a question: the ask-phrases only count without a negation in front.
  if (/(?<!没有|不再|不|无|没)(需要你(决定|确认|选择|回答)|请你(决定|确认|选择))|(?<!不|没有|无需)(要不要|是否要)|你希望|你想要|which do you|do you want|should i|please confirm|(?<!no |don't |does not |doesn't )need your (decision|input)/i.test(tail)) return true;
  const lines = tail.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return /[?？]$/.test(last);
}
