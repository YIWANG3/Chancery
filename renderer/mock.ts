import type { Project, Ticket } from "@core/types";

/**
 * Dev-only stand-in for the preload bridge so the renderer can be opened in a plain browser
 * (http://127.0.0.1:5181) to iterate on the interface without Electron. Fixture data only; never loaded in the app.
 */
export function installMock(): void {
  const now = new Date().toISOString();
  const projects: Project[] = [
    { id: "p1", name: "AfterFrame", dir: "/Users/me/workspace/AfterFrame", repo: "YIWANG3/AfterFrame", default_branch: "main", default_executor: "claude-desktop", default_model: null, parallel: 2, created_at: now, updated_at: now } as unknown as Project,
    { id: "p2", name: "chancery-claude", dir: "/Users/me/workspace/chancery-claude", repo: null, default_branch: "main", default_executor: "codex", default_model: null, parallel: 1, created_at: now, updated_at: now } as unknown as Project,
  ];
  const t = (seq: number, title: string, status: Ticket["status"], kind: Ticket["kind"], priority: number, project_id = "p1"): Ticket =>
    ({ id: `t${seq}`, seq, project_id, title, body: "背景：…\n要做什么：…\n验收：…", status, kind, priority, external_ref: null, created_at: now, updated_at: now }) as Ticket;
  const tickets: Ticket[] = [
    t(12, "导入时 HEIC 的缩略图偶尔是黑的", "needs-human", "bug", 1),
    t(11, "Format 筛选加上视频家族", "awaiting-merge", "feature", 2),
    t(10, "0.5.17 发版说明", "needs-spec", "release", 2),
    t(9, "灯箱里的星级和 Lightroom 不同步", "review", "bug", 2),
    t(8, "智能合集支持按颜色排除", "in-progress", "feature", 3),
    t(7, "小红书周三的图文", "ready", "marketing", 3, "p2"),
    t(6, "worktree 清理脚本", "blocked", "chore", 4, "p2"),
    t(5, "把 README 的截图换成新界面", "inbox", "chore", 4),
    t(4, "人脸索引在 Intel 上的 stdout 污染", "done", "bug", 1),
  ];
  const detail = (id: string) => {
    const ticket = tickets.find((x) => x.id === id)!;
    return {
      ticket,
      assignments: [{ id: "a1", ticket_id: id, executor: "claude-desktop", status: "waiting", branch: "claude/heic-thumbs", worktree: "/Users/me/workspace/AfterFrame/.claude/worktrees/heic-thumbs", session_ref: "abc", pr_url: null, pr_number: null, session_open: { kind: "desktop", desktopSessionId: "local_mock" } }],
      events: [
        { id: "e1", ticket_id: id, at: now, actor: "me", kind: "status", payload: { to: "ready" } },
        { id: "e2", ticket_id: id, at: now, actor: "daemon", kind: "status", payload: { from: "ready", to: "in-progress", note: "派给 claude-desktop" } },
        { id: "e3", ticket_id: id, at: now, actor: "claude", kind: "question", payload: { summary: "复现了，是 sips 解码 10-bit HEIC 时返回空缓冲。", question: "要退回到 ImageIO 解码还是只对 10-bit 走慢路径？" } },
      ],
    };
  };
  const routes: Record<string, (p: never) => unknown> = {
    "projects:list": () => projects,
    "projects:discover": () => [{ dir: "/Users/me/workspace/vibepin", sources: ["claude-desktop", "codex"], sessions: 7, lastActive: now }],
    "tickets:list": (f: { status?: string[] } | undefined) => (f?.status ? tickets.filter((x) => f.status!.includes(x.status)) : tickets).map((x, i) => ({ ...x, session_open: i === 0 ? { kind: "desktop", desktopSessionId: "local_mock" } : i === 1 ? { kind: "terminal", bin: "claude", sessionId: "abc", cwd: "/tmp" } : null })),
    "tickets:get": ({ id }: { id: string }) => detail(id),
    "daemon:status": () => ({ running: true, paused: false, lastTickAt: now, lastError: null }),
    "agents:claude": () => [{ pid: 1, cwd: "/Users/me/workspace/AfterFrame", kind: "desktop", startedAt: 0, sessionId: "s1", name: "heic 缩略图", status: "busy" }],
    "ax:status": () => ({ available: true, trusted: true, probe: { ok: true, projects: ["AfterFrame"], composer: { usage: "Weekly 45%" } } }),
    "settings:get": () => ({ theme: "system", pgPort: 54329, pgConnectionString: "", worktreeRoot: "~/.platform/worktrees", claudeBin: "claude", permissionMode: "auto", claudeLaunchMode: "desktop", defaultModel: "", codexBin: "codex", codexModel: "", codexSandbox: "workspace-write", codexLaunchMode: "exec", quickCaptureShortcut: "CommandOrControl+Shift+Space", daemonIntervalMs: 30000, mcpPort: 41710, clerkBackend: "auto", deepseekApiKey: "", deepseekModel: "deepseek-chat", autoTriage: true, auditEnabled: true, workerLowPriority: true, launchAtLogin: false, pg: { embedded: true, connectionString: "postgres://chancery@127.0.0.1:54329/chancery" } }),
  };
  window.chancery = {
    invoke: async (channel, payload) => {
      const fn = routes[channel];
      if (!fn) return channel === "settings:set" ? { ...(routes["settings:get"]!(undefined as never) as object), ...(payload as object) } : null;
      return fn(payload as never);
    },
    onChanged: () => () => {},
  };
}
