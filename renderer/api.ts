import type { Assignment, Event, Project, Ticket, TicketStatus } from "@core/types";
import type { SessionOpen } from "@core/claude/desktopIndex";
export type { SessionOpen };
import type { DaemonStatus } from "@core/daemon";
import type { DiscoveredProject } from "@core/discover";
import type { TicketDraft } from "@core/clerk";
export type { TicketDraft };
export type { DiscoveredProject };

declare global {
  interface Window {
    chancery: {
      invoke: (channel: string, payload?: unknown) => Promise<unknown>;
      onChanged: (cb: () => void) => () => void;
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
  pg: { embedded: boolean; connectionString: string };
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
  ax: { status: (prompt?: boolean) => call<AxStatus>("ax:status", { prompt }) },
  settings: {
    get: () => call<AppSettings>("settings:get"),
    set: (patch: Partial<AppSettings>) => call<AppSettings>("settings:set", patch),
  },
  shell: {
    open: (url: string) => call<void>("shell:open", { url }),
    reveal: (path: string) => call<void>("shell:reveal", { path }),
  },
  session: { open: (open: SessionOpen) => call<void>("session:open", { open }) },
  onChanged: (cb: () => void) => window.chancery.onChanged(cb),
};
