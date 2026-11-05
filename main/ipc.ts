import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { Daemon, Repo, TicketStatus } from "../core/index.js";
import { desktopSessionsByCli, discoverProjects, draftTicket, listClaudeAgents, sessionOpenFor, type SessionOpen } from "../core/index.js";
import { run } from "../core/util/run.js";
import type { Settings } from "./settings.js";

export interface IpcDeps {
  repo: Repo;
  daemon: Daemon;
  settings: () => Settings;
  saveSettings: (s: Settings) => void;
  worktreeRoot: () => string;
  pgInfo: () => { embedded: boolean; connectionString: string };
  axctlPath: string;
}

/** One channel per verb. The renderer calls window.chancery.invoke(channel, payload). */
export function registerIpc(deps: IpcDeps): void {
  const { repo, daemon } = deps;
  /** Single-quotes a string for sh. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Opens a new Terminal window running the command (macOS). The command is passed through AppleScript as a string literal. */
async function openTerminal(command: string): Promise<void> {
  const lit = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await run("osascript", ["-e", 'tell application "Terminal"', "-e", "activate", "-e", `do script "${lit}"`, "-e", "end tell"], { timeoutMs: 10_000 });
}

const h = <T, R>(channel: string, fn: (payload: T, win: BrowserWindow | null) => Promise<R> | R) =>
    ipcMain.handle(channel, (ev, payload: T) => fn(payload, BrowserWindow.fromWebContents(ev.sender)));

  h("projects:list", () => repo.listProjects());
  h<{ dir?: string }, unknown>("projects:register", async ({ dir }, win) => {
    let target = dir;
    if (!target) {
      const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "选择项目的 git 目录" });
      if (r.canceled || !r.filePaths[0]) return null;
      target = r.filePaths[0];
    }
    return repo.registerProject(target, deps.worktreeRoot());
  });
  h<{ id: string; patch: Record<string, unknown> }, unknown>("projects:update", ({ id, patch }) => repo.updateProject(id, patch));
  h("projects:discover", async () => {
    const registered = (await repo.listProjects()).map((p) => p.dir);
    return discoverProjects({ exclude: registered });
  });
  h<{ dirs: string[] }, unknown>("projects:registerMany", async ({ dirs }) => {
    const results: Array<{ dir: string; ok: boolean; error?: string }> = [];
    for (const dir of dirs) {
      try {
        await repo.registerProject(dir, deps.worktreeRoot());
        results.push({ dir, ok: true });
      } catch (err) {
        results.push({ dir, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  });

  // Each ticket carries where its latest worker's conversation can be reopened: Claude Desktop when its index knows
  // the session (the deep link wants that local_<id>, not the CLI id), else a terminal with the CLI's resume.
  h<{ projectId?: string; status?: TicketStatus[] } | undefined, unknown>("tickets:list", async (f) => {
    const [tickets, latest, index] = await Promise.all([repo.listTickets(f ?? {}), repo.latestAssignments(), desktopSessionsByCli().catch(() => new Map())]);
    const byTicket = new Map(latest.map((a) => [a.ticket_id, a]));
    return tickets.map((t) => {
      const a = byTicket.get(t.id);
      return { ...t, session_open: a ? sessionOpenFor(a, index) : null };
    });
  });
  h<{ id: string }, unknown>("tickets:get", async ({ id }) => {
    const ticket = await repo.getTicket(id);
    if (!ticket) return null;
    const [events, raw, index] = await Promise.all([repo.listEvents(id), repo.assignmentsFor(id), desktopSessionsByCli().catch(() => new Map())]);
    const assignments = raw.map((a) => ({ ...a, session_open: sessionOpenFor(a, index) }));
    return { ticket, events, assignments };
  });
  h<Parameters<Repo["createTicket"]>[0], unknown>("tickets:create", (input) => repo.createTicket(input));
  h<{ id: string; patch: Record<string, unknown> }, unknown>("tickets:update", ({ id, patch }) => repo.updateTicket(id, patch));
  h<{ id: string; status: TicketStatus; note?: string }, unknown>("tickets:setStatus", async ({ id, status, note }) => {
    const t = await repo.setStatus(id, status, "human", note);
    if (status === "ready") void daemon.tick();
    return t;
  });
  h<{ id: string; text: string }, unknown>("tickets:answer", async ({ id, text }) => {
    await repo.addEvent({ ticketId: id, actor: "human", kind: "answer", payload: { text } });
    // Phase 0: the answer is recorded and the ticket goes back to ready for a fresh worker. Delivery into the
    // existing session (--resume) is Phase 1.
    const t = await repo.setStatus(id, "ready", "human", "已回复");
    void daemon.tick();
    return t;
  });

  h<{ text: string }, unknown>("tickets:draft", async ({ text }) => {
    const s = deps.settings();
    const backend = s.clerkBackend === "auto" ? (s.deepseekApiKey ? "deepseek" : "claude") : s.clerkBackend;
    const projects = await repo.listProjects();
    const draft = await draftTicket(text, projects, { backend, deepseekApiKey: s.deepseekApiKey, deepseekModel: s.deepseekModel, claudeBin: s.claudeBin });
    return { ...draft, backend };
  });
  h("daemon:status", () => daemon.status());
  h("daemon:tick", () => daemon.tick());
  h<{ paused: boolean }, unknown>("daemon:pause", ({ paused }) => {
    daemon.setPaused(paused);
    return daemon.status();
  });
  h("agents:claude", () => listClaudeAgents(deps.settings().claudeBin).catch(() => []));
  h<{ prompt?: boolean } | undefined, unknown>("ax:status", async (p) => {
    try {
      const { stdout } = await run(deps.axctlPath, ["trusted", ...(p?.prompt ? ["--prompt"] : [])], { timeoutMs: 10_000 });
      const trusted = (JSON.parse(stdout) as { trusted: boolean }).trusted;
      let probe: unknown = null;
      if (trusted) {
        const r = await run(deps.axctlPath, ["probe"], { timeoutMs: 20_000 }).catch((err) => ({ stdout: JSON.stringify({ ok: false, error: String(err) }) }));
        probe = JSON.parse(r.stdout);
      }
      return { available: true, trusted, probe };
    } catch (err) {
      return { available: false, trusted: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  h("settings:get", () => ({ ...deps.settings(), pg: deps.pgInfo() }));
  h<Partial<Settings>, unknown>("settings:set", (patch) => {
    const next = { ...deps.settings(), ...patch };
    deps.saveSettings(next);
    return next;
  });

  h<{ url: string }, void>("shell:open", ({ url }) => shell.openExternal(url));
  h<{ path: string }, void>("shell:reveal", ({ path }) => shell.showItemInFolder(path));
  /** Opens a session in Claude Desktop by its own local_<id> (from tickets:get), never by the CLI session id. */
  h<{ open: SessionOpen }, void>("session:open", async ({ open }) => {
    if (open.kind === "desktop") return shell.openExternal(`claude://code/continue?session=${encodeURIComponent(open.desktopSessionId)}`);
    if (!/^[0-9a-f-]{36}$/i.test(open.sessionId)) throw new Error("bad session id");
    const bin = open.bin === "codex" ? deps.settings().codexBin : deps.settings().claudeBin;
    const resume = open.bin === "codex" ? ["resume", open.sessionId] : ["--resume", open.sessionId];
    await openTerminal([`cd ${shq(open.cwd)}`, [shq(bin), ...resume].join(" ")].join(" && "));
  });
}

export function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}
