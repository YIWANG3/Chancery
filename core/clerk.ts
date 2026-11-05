// The clerk: one short model call that turns a sentence or a pasted note into a structured ticket. DeepSeek's
// OpenAI-compatible API when a key is set (cheap), otherwise `claude -p` on the subscription.
import { run } from "./util/run.js";
import { TICKET_KINDS, type Project, type TicketKind } from "./types.js";

export interface TicketDraft {
  projectId: string | null;
  projectName: string | null;
  title: string;
  body: string;
  kind: TicketKind;
  priority: number;
  needsSpec: boolean;
  reason: string;
}

export interface ClerkOptions {
  backend: "deepseek" | "claude";
  deepseekApiKey?: string;
  deepseekModel?: string;
  deepseekBaseUrl?: string;
  claudeBin?: string;
  claudeModel?: string;
}

function prompt(text: string, projects: Project[]): string {
  const list = projects.map((p) => `- ${p.name}${p.repo ? `（${p.repo}）` : ""}：${p.dir}`).join("\n");
  return `你是开发平台的书记。把下面这段话整理成一张工单，只输出一个 JSON 对象，不要别的文字。

字段：
- project：从项目列表里选一个 name；判断不了就 null
- title：一句话说做什么，不超过 40 字，不要句号
- body：Markdown。小节：背景 / 要做什么 / 验收标准（可测的条目，用 - 列）/ 范围外。原话里有的信息都要保留，没有的不要编
- kind：${TICKET_KINDS.join(" | ")}
- priority：1 到 4，1 最高；原话没说就 3
- needs_spec：true 表示涉及交互、取舍或产品方向，得先和人讨论设计；纯 bug 修复、明确的小改动为 false
- reason：一句话说你为什么这么分

项目列表：
${list || "（没有项目）"}

原话：
<<<
${text.trim()}
>>>`;
}

function parseJson(raw: string): Record<string, unknown> {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("书记没有返回 JSON");
  return JSON.parse(m[0]) as Record<string, unknown>;
}

/** One call to the clerk's model; the prompt must ask for a single JSON object. */
export async function askClerk(p: string, opts: ClerkOptions): Promise<Record<string, unknown>> {
  let raw: string;
  if (opts.backend === "deepseek") {
    if (!opts.deepseekApiKey) throw new Error("没有 DeepSeek API key");
    const res = await fetch(`${opts.deepseekBaseUrl ?? "https://api.deepseek.com"}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.deepseekApiKey}` },
      body: JSON.stringify({ model: opts.deepseekModel ?? "deepseek-chat", messages: [{ role: "user", content: p }], response_format: { type: "json_object" }, temperature: 0.2 }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    raw = j.choices?.[0]?.message?.content ?? "";
  } else {
    const args = ["-p", "--output-format", "json", "--permission-mode", "plan"];
    if (opts.claudeModel) args.push("--model", opts.claudeModel);
    args.push(p);
    const { stdout } = await run(opts.claudeBin ?? "claude", args, { timeoutMs: 120_000 });
    const j = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    if (j.is_error) throw new Error(j.result ?? "claude -p failed");
    raw = j.result ?? "";
  }
  return parseJson(raw);
}

export async function draftTicket(text: string, projects: Project[], opts: ClerkOptions): Promise<TicketDraft> {
  const o = await askClerk(prompt(text, projects), opts);
  const projectName = typeof o.project === "string" ? o.project : null;
  const project = projectName ? projects.find((x) => x.name.toLowerCase() === projectName.toLowerCase()) : undefined;
  const kind = (TICKET_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as TicketKind) : "chore";
  const priority = Math.min(4, Math.max(1, Number(o.priority) || 3));
  return {
    projectId: project?.id ?? null,
    projectName: project?.name ?? projectName,
    title: String(o.title ?? "").trim().slice(0, 120) || text.trim().split("\n")[0]!.slice(0, 80),
    body: String(o.body ?? "").trim(),
    kind,
    priority,
    needsSpec: o.needs_spec === true,
    reason: String(o.reason ?? ""),
  };
}

export interface TriageResult {
  kind: TicketKind;
  priority: number;
  /** ready: no design needed; needs-spec: talk to the human first; done: it was a question, `answer` holds the reply. */
  status: "ready" | "needs-spec" | "done";
  area: string[];
  answer: string | null;
  reason: string;
}

function triagePrompt(ticket: { seq: number; title: string; body: string; kind: string; priority: number }, project: Project, decisions: string | null): string {
  return `你是开发平台的书记。给下面这张工单分类，只输出一个 JSON 对象，不要别的文字。

字段：
- kind：${TICKET_KINDS.join(" | ")}
- priority：1 到 4，1 最高。线上坏了、数据丢失是 1；影响主要功能是 2；一般 3；美化、顺手的是 4
- status：
  - "ready"：有现成或显而易见的验收标准（明确的 bug、小改动、chore），worker 可以直接做
  - "needs-spec"：涉及交互、取舍、产品方向，或范围说不清，得先和人讨论设计
  - "done"：这是个问题而不是任务，你能直接回答；把回答写进 answer
- area：这张工单大概会碰的目录，相对仓库根，最多 3 个；判断不了就 []
- answer：status 为 done 时的回答，否则 null
- reason：一句话说你为什么这么分

项目：${project.name}${project.repo ? `（${project.repo}）` : ""}
${decisions ? `项目已定的事（decisions.md）：\n<<<\n${decisions.slice(0, 6000)}\n>>>\n` : ""}
工单 #${ticket.seq}「${ticket.title}」（现在标的是 ${ticket.kind} P${ticket.priority}）：
<<<
${ticket.body.trim() || "（无正文）"}
>>>`;
}

/** The triage pass over one inbox ticket. Deterministic clean-up of the model's answer; never throws on odd fields. */
export async function triageTicket(ticket: { seq: number; title: string; body: string; kind: string; priority: number }, project: Project, decisions: string | null, opts: ClerkOptions): Promise<TriageResult> {
  const o = await askClerk(triagePrompt(ticket, project, decisions), opts);
  const kind = (TICKET_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as TicketKind) : (ticket.kind as TicketKind);
  const priority = Math.min(4, Math.max(1, Number(o.priority) || ticket.priority));
  const status = o.status === "needs-spec" || o.status === "done" ? o.status : "ready";
  const area = Array.isArray(o.area) ? o.area.filter((a): a is string => typeof a === "string" && a.length > 0).slice(0, 3) : [];
  const answer = status === "done" && typeof o.answer === "string" && o.answer.trim() ? o.answer.trim() : null;
  return { kind, priority, status: answer ? "done" : status === "done" ? "ready" : status, area, answer, reason: String(o.reason ?? "") };
}
