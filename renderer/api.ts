import type { Assignment, Event, Project, Ticket, TicketStatus } from "@core/types";
import type { SessionOpen } from "@core/claude/desktopIndex";
export type { SessionOpen };
import type { DaemonStatus } from "@core/daemon";
import type { DiscoveredProject } from "@core/discover";
import type { TicketDraft } from "@core/clerk";
import type { Overview } from "@core/overview";
import type { StartProjects } from "@core/sessionStart";
import type { Lang, LangPref } from "@core/i18n";
export type { TicketDraft };
export type { DiscoveredProject };

declare global {
  interface Window {
    chancery: {
      invoke: (channel: string, payload?: unknown) => Promise<unknown>;
      onChanged: (cb: () => void) => () => void;
      onNotices: (cb: () => void) => () => void;
      onLanguage: (cb: (lang: string) => void) => () => void;
    };
  }
}

const call = <T>(channel: string, payload?: unknown) => window.chancery.invoke(channel, payload) as Promise<T>;

export interface TicketDetail {
  ticket: Ticket;
  events: Event[];
  /** session_open says where the worker's conversation can be reopened; null when it cannot be. */
  assignments: Array<Assignment & { session_open: SessionOpen | null }>;
}

/** A ticket in a list, with where its latest worker's conversation can be reopened. */
export type TicketRow = Ticket & { session_open: SessionOpen | null };

export type ThemePref = "system" | "light" | "dark";

export interface AppSettings {
  theme: ThemePref;
  /** What was chosen: a language or the system's. */
  language: LangPref;
  /** The language that choice comes out as right now, resolved by the main process. */
  lang: Lang;
  pgPort: number;
  pgConnectionString: string;
  worktreeRoot: string;
  claudeBin: string;
  permissionMode: string;
  claudeLaunchMode: "desktop" | "print" | "bg";
  defaultModel: string;
  codexBin: string;
  codexModel: string;
  codexSandbox: string;
  codexLaunchMode: "exec" | "desktop";
  quickCaptureShortcut: string;
  daemonIntervalMs: number;
  mcpPort: number;
  clerkBackend: "auto" | "deepseek" | "claude";
  deepseekApiKey: string;
  deepseekModel: string;
  autoTriage: boolean;
  auditEnabled: boolean;
  workerLowPriority: boolean;
  launchAtLogin: boolean;
  sessionAlerts: boolean;
  floatOnStart: boolean;
  floatPosition: { x: number; y: number } | null;
  pg: { embedded: boolean; connectionString: string };
}

export interface PanelNotice {
  id: number;
  title: string;
  subtitle: string;
  body: string;
}

export interface AxStatus {
  available: boolean;
  trusted: boolean;
  error?: string;
  probe?: { ok: boolean; error?: string; projects?: string[]; composer?: { present?: boolean; usage?: string; model?: string } } | null;
}

export interface ClaudeAgent {
  pid: number;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  name: string;
  status: string;
}

export const api = {
  projects: {
    list: () => call<Project[]>("projects:list"),
    register: (dir?: string) => call<Project | null>("projects:register", { dir }),
    update: (id: string, patch: Partial<Project>) => call<Project>("projects:update", { id, patch }),
    discover: () => call<DiscoveredProject[]>("projects:discover"),
    registerMany: (dirs: string[]) => call<Array<{ dir: string; ok: boolean; error?: string }>>("projects:registerMany", { dirs }),
  },
  tickets: {
    list: (filter?: { projectId?: string; status?: TicketStatus[] }) => call<TicketRow[]>("tickets:list", filter),
    get: (id: string) => call<TicketDetail | null>("tickets:get", { id }),
    create: (input: { projectId: string; title: string; body?: string; kind?: Ticket["kind"]; priority?: number; status?: TicketStatus }) => call<Ticket>("tickets:create", input),
    update: (id: string, patch: Partial<Ticket>) => call<Ticket>("tickets:update", { id, patch }),
    setStatus: (id: string, status: TicketStatus, note?: string) => call<Ticket>("tickets:setStatus", { id, status, note }),
    answer: (id: string, text: string) => call<Ticket>("tickets:answer", { id, text }),
    draft: (text: string) => call<TicketDraft & { backend: string }>("tickets:draft", { text }),
  },
  daemon: {
    status: () => call<DaemonStatus>("daemon:status"),
    tick: () => call<void>("daemon:tick"),
    pause: (paused: boolean) => call<DaemonStatus>("daemon:pause", { paused }),
  },
  agents: { claude: () => call<ClaudeAgent[]>("agents:claude") },
  /** Every Claude Desktop and Codex session on this machine, by project. Read from the two apps' own state. */
  sessions: { overview: () => call<Overview>("sessions:overview") },
  ax: {
    status: (prompt?: boolean) => call<AxStatus>("ax:status", { prompt }),
    /** Asks macOS for the Accessibility permission and opens the pane of System Settings it is granted in. */
    grant: () => call<void>("ax:grant"),
  },
  settings: {
    get: () => call<AppSettings>("settings:get"),
    set: (patch: Partial<Omit<AppSettings, "lang" | "pg">>) => call<AppSettings>("settings:set", patch),
  },
  shell: {
    open: (url: string) => call<void>("shell:open", { url }),
    reveal: (path: string) => call<void>("shell:reveal", { path }),
  },
  session: {
    open: (open: SessionOpen) => call<void>("session:open", { open }),
    /** Sends one message into the conversation through its own app. Rejects with a sentence for the person. */
    reply: (target: { app: "claude" | "codex"; id: string; title: string }, text: string) => call<void>("session:reply", { target, text }),
    /** The projects a new conversation can be started in: the ones the session list shows, paired with what the app's
     *  sidebar calls them. Comes with the reason when the sidebar could not be read. */
    startProjects: (app: "claude" | "codex") => call<StartProjects>("session:startProjects", { app }),
    /** Has the app start a new conversation in one of those projects with this first message. Rejects with a sentence for the person. */
    start: (target: { app: "claude" | "codex"; project: string; worktree?: boolean }, prompt: string) => call<void>("session:start", { target, prompt }),
  },
  main: { show: () => call<void>("main:show") },
  /** The floating session window: the main window's minimized form. Showing one puts the other away. */
  float: {
    show: () => call<void>("float:show"),
    toggle: () => call<boolean>("float:toggle"),
    hide: () => call<void>("float:hide"),
    visible: () => call<boolean>("float:visible"),
    /** The page's own size after a render; the window takes it. */
    fit: (size: { width: number; height: number }) => call<void>("float:fit", size),
  },
  /** The notice panel: what it is showing, and what a click on one of them does. */
  notices: {
    list: () => call<PanelNotice[]>("notices:list"),
    open: (id: number) => call<void>("notices:open", { id }),
    dismiss: (id: number) => call<void>("notices:dismiss", { id }),
    onChange: (cb: () => void) => window.chancery.onNotices(cb),
  },
  onChanged: (cb: () => void) => window.chancery.onChanged(cb),
  onLanguage: (cb: (lang: string) => void) => window.chancery.onLanguage(cb),
};
