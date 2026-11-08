import type { Project, Ticket } from "@core/types";
import { resolveLang, type LangPref } from "@core/i18n";

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
  const overview = () => {
    const at = (minutesAgo: number) => Date.now() - minutesAgo * 60_000;
    const af = "/Users/me/workspace/AfterFrame";
    const ch = "/Users/me/workspace/chancery-claude";
    const notes = "/Users/me/notes";
    const s = (app: "claude" | "codex", id: string, projectKey: string, state: string, title: string, minutesAgo: number, detail = "", basis = "fixture") => ({
      app,
      id,
      title,
      state,
      detail,
      basis,
      at: at(minutesAgo),
      cwd: projectKey,
      projectKey,
      turn: state === "running" ? "" : "fixture",
      open: app === "claude" ? { kind: "desktop", desktopSessionId: id } : { kind: "codex-app", threadId: id },
    });
    const sessions = [
      s("claude", "local_1", af, "needs-you", "导入时 HEIC 缩略图偶尔是黑的", 12, "要退回到 ImageIO 解码，还是只对 10-bit 走慢路径？", "postTurnSummary.blocked"),
      s("codex", "t1", af, "error", "给合集页生成封面图", 35, "You've hit your usage limit. Try again at 6:30 PM.", "thread_turns.failed"),
      s("claude", "local_2", ch, "needs-you", "会话总览的状态判定", 50, "Codex 的「等我」读不出来：接受只做到完成未读，还是用辅助功能读侧栏？", "postTurnSummary.blocked"),
      s("claude", "local_3", af, "review", "Format 筛选加上视频家族", 80, "PR #201 已开，CI 两项检查运行中", "postTurnSummary.review_ready"),
      s("codex", "t2", af, "unread", "调研 HEIC 解码的几种路径", 95, "", "thread_turns.completed + unread"),
      s("codex", "t3", notes, "unread", "AI 在 CNC 加工中心的应用", 300, "", "thread_turns.completed + unread"),
      s("claude", "local_4", af, "running", "灯箱里的星级和 Lightroom 不同步", 1, "", "claude agents: busy"),
      s("codex", "t4", ch, "running", "对照 LobeHub 的任务模型", 3, "", "thread_turns.inProgress"),
      s("codex", "t5", af, "interrupted", "批量重命名导出预设", 600, "", "thread_turns.interrupted"),
      s("claude", "local_5", ch, "done", "退出卡住的问题", 130, "退出卡死已修，SIGTERM 1 秒干净退出，测试全过", "postTurnSummary.completed"),
      s("claude", "local_6", notes, "done", "PDF 旅游合集准备", 900, "小红书链接已加入 PDF 介绍页并重新生成，19 页", "postTurnSummary.completed"),
      s("codex", "t6", af, "done", "只回复 ok", 2600, "", "thread_turns.completed"),
      // Enough finished ones under one project for its list to page.
      ...Array.from({ length: 9 }, (_, i) => s("claude", `local_f${i}`, af, "done", `收尾第 ${i + 1} 件小事`, 1500 + i * 90, "", "postTurnSummary.completed")),
    ];
    const zero = { "needs-you": 0, error: 0, stuck: 0, review: 0, unread: 0, running: 0, interrupted: 0, expired: 0, done: 0 };
    const group = (key: string, name: string) => {
      const mine = sessions.filter((x) => x.projectKey === key);
      const counts = { ...zero } as Record<string, number>;
      for (const x of mine) counts[x.state] = (counts[x.state] ?? 0) + 1;
      return { key, name, dir: key, apps: [...new Set(mine.map((x) => x.app))], sessions: mine.length, counts, lastAt: Math.max(...mine.map((x) => x.at)) };
    };
    return { projects: [group(af, "AfterFrame"), group(ch, "chancery-claude"), group(notes, "notes")], sessions, readAt: Date.now(), errors: [] };
  };
  // The language is the one setting the mock keeps, so the settings page can switch it like the app does.
  const settings: { theme: string; language: LangPref } = { theme: "system", language: "system" };
  const routes: Record<string, (p: never) => unknown> = {
    "sessions:overview": overview,
    "notices:list": () => [
      { id: 2, title: "等你 · 导入时 HEIC 缩略图偶尔是黑的", subtitle: "Claude · AfterFrame", body: "要退回到 ImageIO 解码，还是只对 10-bit 走慢路径？" },
      { id: 1, title: "跑完了 · 调研 HEIC 解码的几种路径", subtitle: "Codex · AfterFrame", body: "这一轮结束了。" },
    ],
    "projects:list": () => projects,
    "projects:discover": () => [{ dir: "/Users/me/workspace/vibepin", sources: ["claude-desktop", "codex"], sessions: 7, lastActive: now }],
    "tickets:list": (f: { status?: string[] } | undefined) => (f?.status ? tickets.filter((x) => f.status!.includes(x.status)) : tickets).map((x, i) => ({ ...x, session_open: i === 0 ? { kind: "desktop", desktopSessionId: "local_mock" } : i === 1 ? { kind: "terminal", bin: "claude", sessionId: "abc", cwd: "/tmp" } : null })),
    "tickets:get": ({ id }: { id: string }) => detail(id),
    "daemon:status": () => ({ running: true, paused: false, lastTickAt: now, lastError: null }),
    "agents:claude": () => [{ pid: 1, cwd: "/Users/me/workspace/AfterFrame", kind: "desktop", startedAt: 0, sessionId: "s1", name: "heic 缩略图", status: "busy" }],
    "ax:status": () => ({ available: true, trusted: true, probe: { ok: true, projects: ["AfterFrame"], composer: { usage: "Weekly 45%" } } }),
    "settings:get": () => ({ ...settings, lang: resolveLang(settings.language, navigator.languages), pgPort: 54329, pgConnectionString: "", worktreeRoot: "~/.platform/worktrees", claudeBin: "claude", permissionMode: "auto", claudeLaunchMode: "desktop", defaultModel: "", codexBin: "codex", codexModel: "", codexSandbox: "workspace-write", codexLaunchMode: "exec", quickCaptureShortcut: "CommandOrControl+Shift+Space", daemonIntervalMs: 30000, mcpPort: 41710, clerkBackend: "auto", deepseekApiKey: "", deepseekModel: "deepseek-chat", autoTriage: true, auditEnabled: true, workerLowPriority: true, launchAtLogin: false, sessionAlerts: true, floatOnStart: false, floatPosition: null, pg: { embedded: true, connectionString: "postgres://chancery@127.0.0.1:54329/chancery" } }),
  };
  window.chancery = {
    invoke: async (channel, payload) => {
      const fn = routes[channel];
      if (channel === "settings:set") {
        Object.assign(settings, payload as object);
        return { ...(routes["settings:get"]!(undefined as never) as object), ...(payload as object) };
      }
      if (!fn) return null;
      return fn(payload as never);
    },
    onChanged: () => () => {},
    onNotices: () => () => {},
    onLanguage: () => () => {},
  };
}
