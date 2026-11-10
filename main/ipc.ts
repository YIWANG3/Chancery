import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { Daemon, Repo, TicketStatus } from "../core/index.js";
import { desktopSessionsByCli, discoverProjects, draftTicket, listClaudeAgents, listStartProjects, replyToSession, sessionOpenFor, startSession, t, type Lang, type Overview, type ReplyTarget, type SessionApp, type SessionOpen, type StartTarget } from "../core/index.js";
import { run } from "../core/util/run.js";
import { openSession } from "./openSession.js";
import type { Settings } from "./settings.js";

export interface IpcDeps {
  repo: Repo;
  daemon: Daemon;
  settings: () => Settings;
  saveSettings: (s: Settings) => void;
  /** The language the app speaks right now: the setting, or the system's when the setting says so. */
  lang: () => Lang;
  worktreeRoot: () => string;
  pgInfo: () => { embedded: boolean; connectionString: string };
  axctlPath: string;
  log: (msg: string) => void;
  showMain: () => void;
  /** The session watch's newest snapshot of both apps' sessions. */
  sessions: () => Promise<Overview>;
  /** Has the session watch read again now. */
  refreshSessions: () => void;
  /** Where the session overview reads the two apps' state from, when not the real home. */
  sessionsHome?: string;
}

/** One channel per verb. The renderer calls window.chancery.invoke(channel, payload). */
export function registerIpc(deps: IpcDeps): void {
  const { repo, daemon } = deps;
  const h = <T, R>(channel: string, fn: (payload: T, win: BrowserWindow | null) => Promise<R> | R) =>
    ipcMain.handle(channel, (ev, payload: T) => fn(payload, BrowserWindow.fromWebContents(ev.sender)));

  h("projects:list", () => repo.listProjects());
  h<{ dir?: string }, unknown>("projects:register", async ({ dir }, win) => {
    let target = dir;
    if (!target) {
      const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: t(deps.lang(), "dialog.pickGitDir") });
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
    const ticket = await repo.setStatus(id, status, "human", note);
    if (status === "ready") void daemon.tick();
    return ticket;
  });
  h<{ id: string; text: string }, unknown>("tickets:answer", async ({ id, text }) => {
    await repo.addEvent({ ticketId: id, actor: "human", kind: "answer", payload: { text } });
    // Phase 0: the answer is recorded and the ticket goes back to ready for a fresh worker. Delivery into the
    // existing session (--resume) is Phase 1.
    const ticket = await repo.setStatus(id, "ready", "human", t(deps.lang(), "ticket.answeredNote"));
    void daemon.tick();
    return ticket;
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
  // The overview comes from the session watch, which reads the two apps' own files on a timer whether or not a
  // window is open, and tells the windows when something changed.
  h("sessions:overview", () => deps.sessions());
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

  // Both answers carry the same extras: where the database is, and which language the setting comes out as.
  const withExtras = (s: Settings) => ({ ...s, pg: deps.pgInfo(), lang: deps.lang() });
  h("settings:get", () => withExtras(deps.settings()));
  h<Partial<Settings>, unknown>("settings:set", (patch) => {
    const next = { ...deps.settings(), ...patch };
    deps.saveSettings(next);
    return withExtras(deps.settings());
  });

  h("main:show", () => deps.showMain());
  h<{ url: string }, void>("shell:open", ({ url }) => shell.openExternal(url));
  h<{ path: string }, void>("shell:reveal", ({ path }) => shell.showItemInFolder(path));
  h<{ open: SessionOpen }, void>("session:open", ({ open }) => openSession(open, deps.settings(), deps.log));
  // A quick reply: one message into a conversation, sent by its own app. The list is read again a moment later,
  // when the app has had time to mark the session as running.
  h<{ target: ReplyTarget; text: string }, void>("session:reply", async ({ target, text }) => {
    deps.log(`reply to ${target.app}:${target.id} (${text.trim().length} chars)`);
    try {
      await replyToSession(target, text, { axctlPath: deps.axctlPath, home: deps.sessionsHome, lang: deps.lang() });
    } catch (err) {
      deps.log(`reply to ${target.app}:${target.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    setTimeout(deps.refreshSessions, 1500);
  });
  // A new conversation, started by the app that will own it. The projects are the ones its sidebar offers, by the
  // names it shows; the first message goes into the fresh composer. The app takes a few seconds to write the
  // session into its own files, so the list is read again twice.
  h<{ app: SessionApp }, string[]>("session:startProjects", ({ app }) => listStartProjects(app, { axctlPath: deps.axctlPath, lang: deps.lang() }));
  h<{ target: StartTarget; prompt: string }, void>("session:start", async ({ target, prompt }) => {
    const where = `${target.app} "${target.project}"${target.app === "claude" ? (target.worktree ? " +worktree" : " -worktree") : ""}`;
    deps.log(`new session in ${where} (${prompt.trim().length} chars)`);
    try {
      await startSession(target, prompt, { axctlPath: deps.axctlPath, lang: deps.lang() });
    } catch (err) {
      deps.log(`new session in ${where} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    for (const ms of [2000, 6000]) setTimeout(deps.refreshSessions, ms);
  });
}

export function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}
