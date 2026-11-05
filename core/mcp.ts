// The steward's tools: an MCP server over the same repo the app uses. Any Claude or Codex session that has it
// registered can file, read and move tickets, so "把刚才讨论的提成工单" works from inside a conversation.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Daemon } from "./daemon.js";
import type { Repo } from "./repo.js";
import { TICKET_KINDS, TICKET_STATUSES, type Project, type TicketStatus } from "./types.js";

export interface McpDeps {
  repo: Repo;
  daemon: Daemon;
}

const INSTRUCTIONS = `Chancery 是用户的工单和 Agent 派发平台。工单存在它自己的库里，守护进程会把「可派」的工单分给 Claude / Codex 去做。

什么时候用：
- 用户说「记一个」「提成工单」「把这个任务提交上去」「交给平台做」：把当前讨论整理成一张工单后调 create_ticket。标题一句话说做什么；正文写背景、要改什么、验收标准（可测的条目）、范围外；讨论里已经定了的事写进正文，不要让 worker 重新讨论。用户没指定项目时按讨论内容选（list_projects 看有哪些），拿不准就问一句。
- 用户没说"直接派"就放 inbox；说了「直接派」「可以开工」才用 status=ready。涉及交互、取舍、产品方向而讨论里没定的，用 needs-spec。
- 用户问「工单进展」「有什么等我」：list_tickets，needs-human 和 review 是要人看的。
- 用户对某张工单的提问给出回答：answer_ticket，它会重新派。`;

function matchProject(projects: Project[], key: string): Project | undefined {
  const k = key.trim().toLowerCase();
  return projects.find((p) => p.name.toLowerCase() === k) ?? projects.find((p) => p.repo?.toLowerCase() === k || p.repo?.split("/")[1]?.toLowerCase() === k) ?? projects.find((p) => p.dir.toLowerCase() === k || p.dir.toLowerCase().endsWith("/" + k));
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

export function createChanceryMcpServer(deps: McpDeps): McpServer {
  const { repo, daemon } = deps;
  const server = new McpServer({ name: "chancery", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool("list_projects", { description: "已注册的项目：name、repo、dir、默认执行器。create_ticket 的 project 用这里的 name。", inputSchema: {} }, async () => {
    const projects = await repo.listProjects();
    return text(projects.map((p) => ({ name: p.name, repo: p.repo, dir: p.dir, default_executor: p.default_executor, parallel: p.parallel })));
  });

  server.registerTool(
    "list_tickets",
    {
      description: "列工单。不传 status 就是全部未完成的。needs-human = 等人回答，review = 做完了等人看，in-progress = 正在跑。",
      inputSchema: { project: z.string().optional().describe("项目 name，不传就是全部"), status: z.array(z.enum(TICKET_STATUSES)).optional() },
    },
    async ({ project, status }) => {
      const projects = await repo.listProjects();
      const p = project ? matchProject(projects, project) : undefined;
      if (project && !p) return text(`没有叫 ${project} 的项目。有：${projects.map((x) => x.name).join("、")}`);
      const list = await repo.listTickets({ projectId: p?.id, status: status ?? (TICKET_STATUSES.filter((s) => s !== "done") as TicketStatus[]) });
      return text(list.map((t) => ({ seq: t.seq, status: t.status, priority: t.priority, kind: t.kind, title: t.title, project: projects.find((x) => x.id === t.project_id)?.name, updated_at: t.updated_at })));
    },
  );

  server.registerTool("get_ticket", { description: "一张工单的全文、派发记录和事件流水（worker 的汇报和提问都在事件里）。", inputSchema: { seq: z.number().int() } }, async ({ seq }) => {
    const t = (await repo.listTickets()).find((x) => x.seq === seq);
    if (!t) return text(`没有 #${seq}`);
    const [events, assignments] = await Promise.all([repo.listEvents(t.id), repo.assignmentsFor(t.id)]);
    return text({ ticket: t, assignments, events: events.map((e) => ({ at: e.at, actor: e.actor, kind: e.kind, ...e.payload })) });
  });

  server.registerTool(
    "create_ticket",
    {
      description: "建一张工单。正文用 Markdown：背景、要做什么、验收标准、范围外、已定的事。默认进 inbox；用户明确说可以开工才 ready。",
      inputSchema: {
        project: z.string().describe("项目 name（list_projects）"),
        title: z.string().min(2).max(120),
        body: z.string().default(""),
        kind: z.enum(TICKET_KINDS).default("chore"),
        priority: z.number().int().min(1).max(4).default(3).describe("1 最高 4 最低"),
        status: z.enum(["inbox", "ready", "needs-spec"]).default("inbox"),
        executor: z.enum(["claude-desktop", "codex", "dsh"]).optional().describe("不传用项目默认"),
      },
    },
    async ({ project, title, body, kind, priority, status, executor }) => {
      const projects = await repo.listProjects();
      const p = matchProject(projects, project);
      if (!p) return text(`没有叫 ${project} 的项目。有：${projects.map((x) => x.name).join("、")}`);
      const t = await repo.createTicket({ projectId: p.id, title, body, kind, priority, status, source: "mcp", actor: "human" });
      if (executor) await repo.updateTicket(t.id, { executor });
      if (status === "ready") void daemon.tick();
      return text({ seq: t.seq, status: t.status, project: p.name, title: t.title });
    },
  );

  server.registerTool(
    "set_status",
    { description: "推工单状态：ready 会立刻派出去，done 关掉，needs-spec 等设计。", inputSchema: { seq: z.number().int(), status: z.enum(TICKET_STATUSES), note: z.string().optional() } },
    async ({ seq, status, note }) => {
      const t = (await repo.listTickets()).find((x) => x.seq === seq);
      if (!t) return text(`没有 #${seq}`);
      const u = await repo.setStatus(t.id, status, "human", note);
      if (status === "ready") void daemon.tick();
      return text({ seq: u.seq, status: u.status });
    },
  );

  server.registerTool("answer_ticket", { description: "回答 worker 的提问（工单在 needs-human 时），回完它会重新派。", inputSchema: { seq: z.number().int(), text: z.string().min(1) } }, async ({ seq, text: answer }) => {
    const t = (await repo.listTickets()).find((x) => x.seq === seq);
    if (!t) return text(`没有 #${seq}`);
    await repo.addEvent({ ticketId: t.id, actor: "human", kind: "answer", payload: { text: answer } });
    const u = await repo.setStatus(t.id, "ready", "human", "已回复");
    void daemon.tick();
    return text({ seq: u.seq, status: u.status });
  });

  server.registerTool("daemon_status", { description: "守护进程在不在跑、上次 tick、有没有错。", inputSchema: {} }, async () => text(daemon.status()));

  return server;
}
