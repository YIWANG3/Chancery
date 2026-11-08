// Headless entry: the same core, no Electron. Talks to whatever Postgres the app uses (settings.json).
//   chancery register <dir>            register a git directory as a project
//   chancery projects                  list projects
//   chancery ticket <project> <title> [--body text] [--ready] [--kind k] [--priority n] [--executor codex]
//   chancery tickets [project]         list open tickets
//   chancery show <seq>                one ticket with its events
//   chancery status <seq> <status>     move a ticket
//   chancery draft <text>              ask the clerk to shape a ticket (prints JSON, saves nothing)
//   chancery tick                      run one daemon tick (only when the app is not running)
//   chancery sessions [--days n] [--all] [--json]
//                                      Claude Desktop and Codex sessions by project (needs no database; --all
//                                      also lists Codex threads started by `codex exec`)
import { homedir } from "node:os";
import { join } from "node:path";
import { buildOverview, createClaudeDesktopExecutor, createCodexExecutor, createDaemon, createDb, createRepo, draftTicket, migrate, resolveLang, translator, type SessionState } from "../core/index.js";
import { DEFAULT_SETTINGS, loadSettings } from "../main/settings.js";

const userData = process.env.CHANCERY_USER_DATA ?? join(homedir(), "Library", "Application Support", "chancery-claude");
const settings = loadSettings(join(userData, "settings.json"));
const connectionString = process.env.CHANCERY_PG ?? settings.pgConnectionString ?? "";
const url = connectionString || `postgres://chancery:chancery@127.0.0.1:${settings.pgPort ?? DEFAULT_SETTINGS.pgPort}/chancery`;
// The app's language setting, else the shell's locale (LC_ALL wins over LANG, as in any other command).
const lang = resolveLang(settings.language, [process.env.CHANCERY_LANG, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].filter((s): s is string => Boolean(s)));
const t = translator(lang);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const positional = (args: string[]) => args.filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1]!.startsWith("--") && !["ready"].includes(all[i - 1]!.slice(2))));

const stateLabel = (s: SessionState) => t(`state.${s}`);

/** Reads only the two apps' own state, so it runs whether or not the app or its Postgres is up. */
async function sessions(args: string[]): Promise<void> {
  const now = Date.now();
  const overview = await buildOverview({ claudeBin: settings.claudeBin, days: Number(flag(args, "days") ?? 14), includeExec: args.includes("--all"), includeGone: args.includes("--all"), now, lang });
  if (args.includes("--json")) {
    console.log(JSON.stringify(overview, null, 2));
    return;
  }
  const ago = (at: number) => {
    const m = Math.round((now - at) / 60_000);
    return m < 60 ? t("time.minutesAgo", { n: m }) : m < 48 * 60 ? t("time.hoursAgo", { n: Math.round(m / 60) }) : t("time.daysAgo", { n: Math.round(m / 1440) });
  };
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  for (const p of overview.projects) {
    const tally = (Object.entries(p.counts) as Array<[SessionState, number]>).filter(([, n]) => n > 0).map(([s, n]) => `${stateLabel(s)} ${n}`);
    console.log(`\n${p.name}  ·  ${tally.join("  ")}${p.dir ? `  ·  ${p.dir.replace(homedir(), "~")}` : ""}`);
    for (const s of overview.sessions.filter((x) => x.projectKey === p.key)) {
      // Chinese labels are padded with full-width spaces so the columns line up; English ones are longer and plain.
      const label = lang === "zh" ? stateLabel(s.state).padEnd(4, "　") : stateLabel(s.state).padEnd(12);
      console.log(`  ${label} ${s.app.padEnd(6)} ${ago(s.at).padStart(lang === "zh" ? 9 : 14)}  ${clip(s.title.replace(/\s+/g, " ") || t("common.untitled"), 40)}`);
      if (s.detail) console.log(`${" ".repeat(26)}↳ ${clip(s.detail.replace(/\s+/g, " "), 90)}`);
    }
  }
  for (const e of overview.errors) console.error(t("common.cannotRead", { what: e }));
}

async function main() {
  const [cmd = "help", ...args] = process.argv.slice(2);
  if (cmd === "sessions") return sessions(args);
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
