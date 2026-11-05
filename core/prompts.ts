import type { Event, Project, Ticket } from "./types.js";
import type { WorktreeInfo } from "./executors/types.js";

/** What an earlier round of work on the same ticket left behind, so a fresh worker continues instead of restarting. */
export interface PromptHistory {
  /** question / answer / report events in order; the daemon passes the tail of the ticket's event stream. */
  events: Event[];
  /** The last assignment's branch and worktree, if any. */
  previous?: { branch: string | null; worktree: string | null; pr_url: string | null } | null;
}

const indent = (text: string) => text.replace(/\n/g, "\n  ");
const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function historyLines(h: PromptHistory | undefined, where: WorktreeInfo | null): string[] {
  if (!h || (!h.events.length && !h.previous?.branch)) return [];
  const out: string[] = [``, `## 上一轮`];
  for (const e of h.events) {
    const p = e.payload as Record<string, unknown>;
    const who = e.actor === "human" ? "我" : "上一轮 worker";
    if (e.kind === "answer") out.push(`- ${who}（${fmtWhen(e.at)}）答：${indent(String(p.text ?? "").trim())}`);
    else if (e.kind === "report" && p.state === "audit-failed") out.push(`- 审计（${fmtWhen(e.at)}）没通过，要修的：${indent(String(p.summary ?? "").trim())}`);
    else if (e.kind === "question") {
      // Workers without wrap_up report the same text as summary and question; say it once.
      const summary = String(p.summary ?? "").trim();
      const question = String(p.question ?? "").trim();
      const parts: string[] = [];
      if (summary && summary !== question) parts.push(`汇报：${indent(summary)}`);
      if (question) parts.push(`问：${indent(question)}`);
      out.push(`- ${who}（${fmtWhen(e.at)}）${parts.join("\n  ")}`);
    }
    else if (e.kind === "report") out.push(`- ${who}（${fmtWhen(e.at)}）${String(p.state ?? "")}：${String(p.summary ?? "").trim()}`);
  }
  const prev = h.previous;
  if (prev?.branch) {
    const same = where && (where.branch === prev.branch || where.worktree === prev.worktree);
    if (same) out.push(`- 上一轮的改动就在当前目录（分支 ${prev.branch}），接着做，不要重做。`);
    else out.push(`- 上一轮的改动在分支 \`${prev.branch}\`${prev.worktree ? `（目录 ${prev.worktree}）` : ""}。先 \`git merge ${prev.branch}\`（或 cherry-pick）把它拿过来再继续，不要重做。`);
    if (prev.pr_url) out.push(`- 上一轮已经开了 PR：${prev.pr_url}，继续往那个分支提交即可。`);
  }
  out.push(`- 我已经回答了上面的问题，不要再问一遍；按回答继续做完。仍有新的、必须由人定的事再停下来问。`);
  return out;
}

/** The first message a worker gets. Backend-agnostic: the same text goes to Claude, Codex or dsh. */
export function executePrompt(ticket: Ticket, project: Project, where: WorktreeInfo | null, history?: PromptHistory): string {
  const platform = project.platform as Record<string, unknown>;
  const quick = typeof platform.quick === "string" ? platform.quick : null;
  const setup = typeof platform.setup === "string" ? platform.setup : null;
  const decisions = typeof platform.decisions === "string" ? platform.decisions : "docs/decisions.md";
  const whereLine = where?.selfMade
    ? `当前目录是项目的主 checkout，不能在这里改东西。第一步：\`git worktree add -b ${where.branch} ${where.worktree} ${project.default_branch}\`（分支已存在就去掉 -b），并把 \`.chancery/\` 追加进 .git/info/exclude；之后所有改动和命令都在 ${where.worktree} 里做；`
    : where
      ? `当前目录是这张工单专用的 worktree（分支 ${where.branch}），只在这里改代码；`
      : `当前目录是桌面端为这张工单开的 worktree，只在这里改代码；`;
  const lines = [
    `你在处理工单 #${ticket.seq}「${ticket.title}」，项目 ${project.name}${project.repo ? `（${project.repo}）` : ""}。`,
    `${whereLine}${where?.selfMade ? "worktree 之外的文件一律不动" : `不要碰 ${project.dir}`}，不要 push 到 ${project.default_branch}，不要合并。`,
    ``,
    `## 工单`,
    ticket.body.trim() || "（无正文）",
    ...historyLines(history, where),
    ``,
    `## 规矩`,
    // Daemon-made worktrees had setup run already; a worktree the backend made (desktop modes) has not.
    ...(setup && (!where || where.selfMade) ? [`- 先在 worktree 里跑一次：${setup}`] : []),
    `- 先读 ${decisions}（如果存在）：定过的事不要重新讨论。`,
    ticket.spec_path ? `- 规格在 ${ticket.spec_path}，按它的验收标准做，每条验收标准配一个最便宜层级的测试。` : `- 没有 spec。做之前用一两句话写下你理解的验收标准，拿不准就停下来问。`,
    quick ? `- 提交前跑：${quick}` : `- 提交前跑项目的快速检查。`,
    `- 按路径 git add，提交信息说明做了什么；完成后用 gh pr create 开 PR 到 ${project.default_branch}，PR 正文写改了什么、怎么验证。`,
    `- 遇到必须由人决定的事（删数据、发版、对外发消息、花钱、改产品方向），不要做，停下来把问题和选项写清楚。`,
    `- 结束时用 wrap_up 汇报：recap 写结果和 PR 链接；有问题要问就写 ask。`,
  ];
  return lines.join("\n");
}

export interface AuditInput {
  round: number; // 1-based
  pr: { number: number; url: string } | null;
  branch: string | null;
}

/** The auditor's first message: read-only, test-backed, ends with one verdict line the daemon parses. */
export function auditPrompt(ticket: Ticket, project: Project, input: AuditInput): string {
  const platform = project.platform as Record<string, unknown>;
  const quick = typeof platform.quick === "string" ? platform.quick : null;
  return [
    `你是审计。工单 #${ticket.seq}「${ticket.title}」的 worker 说做完了${input.pr ? `，PR 是 ${input.pr.url}` : ""}${input.branch ? `，分支 ${input.branch}` : ""}。这是第 ${input.round} 轮审计（最多 3 轮）。`,
    `当前目录就是 worker 的 worktree。你只读：不改任何文件，不提交，不 push。可以跑测试和读 diff（git diff ${project.default_branch}...HEAD）。`,
    ``,
    `## 工单`,
    ticket.body.trim() || "（无正文）",
    ticket.spec_path ? `\n规格：${ticket.spec_path}` : "",
    ``,
    `## 检查什么`,
    `- 每条验收标准是否都有对应的改动，和一个会在改动被撤掉时变红的测试。`,
    quick ? `- 跑 ${quick}，看它是不是绿的。` : `- 跑项目的快速检查，看它是不是绿的。`,
    `- 只报真会出错的问题：会导致功能不对、测试造假、越过工单范围、碰了不该碰的文件。风格问题不报。`,
    ``,
    `## 怎么汇报`,
    `先写发现（每条：在哪、什么情况下错、后果），最后单独一行写结论，只能是下面两种之一：`,
    `AUDIT: PASS`,
    `AUDIT: FAIL`,
  ].join("\n");
}

/** Reads the auditor's verdict line; null when it did not give one. */
export function parseAuditVerdict(text: string): "pass" | "fail" | null {
  const m = [...text.matchAll(/AUDIT:\s*(PASS|FAIL)/gi)].pop();
  return m ? (m[1]!.toUpperCase() === "PASS" ? "pass" : "fail") : null;
}
