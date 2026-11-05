// Headless entry: the same core, no Electron. Talks to whatever Postgres the app uses (settings.json).
//   chancery register <dir>            register a git directory as a project
//   chancery projects                  list projects
//   chancery ticket <project> <title> [--body text] [--ready] [--kind k] [--priority n] [--executor codex]
//   chancery tickets [project]         list open tickets
//   chancery show <seq>                one ticket with its events
//   chancery status <seq> <status>     move a ticket
//   chancery draft <text>              ask the clerk to shape a ticket (prints JSON, saves nothing)
//   chancery tick                      run one daemon tick (only when the app is not running)
import { homedir } from "node:os";
import { join } from "node:path";
import { createClaudeDesktopExecutor, createCodexExecutor, createDaemon, createDb, createRepo, draftTicket, migrate } from "../core/index.js";
import { DEFAULT_SETTINGS, loadSettings } from "../main/settings.js";

const userData = process.env.CHANCERY_USER_DATA ?? join(homedir(), "Library", "Application Support", "chancery-claude");
const settings = loadSettings(join(userData, "settings.json"));
const connectionString = process.env.CHANCERY_PG ?? settings.pgConnectionString ?? "";
const url = connectionString || `postgres://chancery:chancery@127.0.0.1:${settings.pgPort ?? DEFAULT_SETTINGS.pgPort}/chancery`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const positional = (args: string[]) => args.filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1]!.startsWith("--") && !["ready"].includes(all[i - 1]!.slice(2))));

async function main() {
  const [cmd = "help", ...args] = process.argv.slice(2);
  const db = createDb(url);
  try {
    await migrate(db);
    const repo = createRepo(db);
    switch (cmd) {
      case "register": {
        const p = await repo.registerProject(args[0]!, settings.worktreeRoot);
        console.log(`${p.name}  ${p.repo ?? "(no github remote)"}  ${p.dir}`);
        break;
      }
      case "projects":
        for (const p of await repo.listProjects()) console.log(`${p.name}\t${p.repo ?? "-"}\t${p.dir}\t${p.default_executor}`);
        break;
      case "ticket": {
        const [name, ...rest] = positional(args);
        const title = rest.join(" ");
        const project = (await repo.listProjects()).find((p) => p.name === name);
        if (!project) throw new Error(`no project named ${name}`);
        const t = await repo.createTicket({
          projectId: project.id,
          title,
          body: flag(args, "body") ?? "",
          kind: (flag(args, "kind") as never) ?? "chore",
          priority: Number(flag(args, "priority") ?? 3),
          status: args.includes("--ready") ? "ready" : "inbox",
        });
        const executor = flag(args, "executor");
        if (executor) await repo.updateTicket(t.id, { executor: executor as never });
        console.log(`#${t.seq} ${t.status} ${t.title}`);
        break;
      }
      case "tickets": {
        const projects = await repo.listProjects();
        const project = args[0] ? projects.find((p) => p.name === args[0]) : undefined;
        const list = await repo.listTickets({ projectId: project?.id });
        for (const t of list) console.log(`#${t.seq}\t${t.status}\tP${t.priority}\t${projects.find((p) => p.id === t.project_id)?.name}\t${t.title}`);
        break;
      }
      case "show": {
        const seq = Number(args[0]);
        const t = (await repo.listTickets()).find((x) => x.seq === seq);
        if (!t) throw new Error(`no ticket #${seq}`);
        console.log(`#${t.seq} ${t.status} ${t.title}\n${t.body}\n`);
        for (const a of await repo.assignmentsFor(t.id)) console.log(`assignment ${a.status} ${a.executor} session=${a.session_ref ?? "-"} branch=${a.branch ?? "-"} pr=${a.pr_url ?? "-"}`);
        for (const e of await repo.listEvents(t.id)) console.log(`${e.at} [${e.actor}] ${e.kind} ${JSON.stringify(e.payload)}`);
        break;
      }
      case "status": {
        const seq = Number(args[0]);
        const t = (await repo.listTickets()).find((x) => x.seq === seq);
        if (!t) throw new Error(`no ticket #${seq}`);
        const u = await repo.setStatus(t.id, args[1] as never, "human", "cli");
        console.log(`#${u.seq} ${u.status}`);
        break;
      }
      case "draft": {
        const text = args.join(" ");
        const backend = settings.clerkBackend === "auto" ? (settings.deepseekApiKey ? "deepseek" : "claude") : settings.clerkBackend;
        const d = await draftTicket(text, await repo.listProjects(), { backend, deepseekApiKey: settings.deepseekApiKey, deepseekModel: settings.deepseekModel, claudeBin: settings.claudeBin });
        console.log(JSON.stringify({ backend, ...d }, null, 2));
        break;
      }
      case "tick": {
        const daemon = createDaemon({
          db,
          repo,
          executors: {
            "claude-desktop": createClaudeDesktopExecutor({
              claudeBin: settings.claudeBin,
              permissionMode: settings.permissionMode,
              launchMode: settings.claudeLaunchMode,
              axctlPath: join(__dirname, "..", "native", "bin", "axctl"),
              runDir: join(homedir(), "Library", "Logs", "chancery-claude", "runs"),
              log: console.error,
            }),
            codex: createCodexExecutor({ codexBin: settings.codexBin, model: settings.codexModel || undefined, sandbox: settings.codexSandbox, launchMode: settings.codexLaunchMode, axctlPath: join(__dirname, "..", "native", "bin", "axctl"), runDir: join(homedir(), "Library", "Logs", "chancery-claude", "runs"), log: console.error }),
          },
          worktreeRoot: settings.worktreeRoot,
          log: console.error,
        });
        await daemon.tick();
        break;
      }
      default:
        console.log("chancery register <dir> | projects | ticket <project> <title> [--body t] [--ready] | tickets [project] | show <seq> | status <seq> <status> | draft <text> | tick");
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
