import { useEffect, useState, type ReactNode } from "react";
import { api, type AppSettings, type AxStatus, type ThemePref } from "../api";
import { Button, Segmented, Select, SettingGroup, SettingRow, Switch } from "../ui";

type Opt<T extends string> = { value: T; label: string };

const THEMES: Opt<ThemePref>[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];
const CLAUDE_LAUNCH: Opt<AppSettings["claudeLaunchMode"]>[] = [
  { value: "desktop", label: "桌面端" },
  { value: "print", label: "print" },
  { value: "bg", label: "bg" },
];
const PERMISSION: Opt<string>[] = [
  { value: "auto", label: "auto" },
  { value: "acceptEdits", label: "acceptEdits" },
  { value: "bypassPermissions", label: "bypassPermissions" },
];
const CODEX_LAUNCH: Opt<AppSettings["codexLaunchMode"]>[] = [
  { value: "exec", label: "exec" },
  { value: "desktop", label: "桌面端" },
];
const SANDBOX: Opt<AppSettings["codexSandbox"]>[] = [
  { value: "workspace-write", label: "workspace-write" },
  { value: "danger-full-access", label: "danger-full-access" },
  { value: "read-only", label: "read-only" },
];
const CLERK: Opt<AppSettings["clerkBackend"]>[] = [
  { value: "auto", label: "自动" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "claude", label: "Claude" },
];

const RESTART = "重启后生效。";

export function SettingsPage() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [ax, setAx] = useState<AxStatus | null>(null);
  useEffect(() => {
    void api.settings.get().then(setS);
    void api.ax.status().then(setAx);
  }, []);
  if (!s) return null;

  /** Every control saves on its own; text fields commit on blur or Enter. */
  const set = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    if (s[key] === value) return;
    setS(await api.settings.set({ [key]: value } as Partial<AppSettings>));
  };
  const text = (key: keyof AppSettings, label: string, opts: { kind?: "text" | "password" | "number"; placeholder?: string } = {}) => (
    <TextField key={key} label={label} kind={opts.kind} placeholder={opts.placeholder} value={String(s[key] ?? "")} onCommit={(v) => void set(key, (opts.kind === "number" ? Number(v) : v) as AppSettings[typeof key])} />
  );
  const toggle = (key: keyof AppSettings, label: string) => <Switch ariaLabel={label} checked={Boolean(s[key])} onChange={(v) => void set(key, v as AppSettings[typeof key])} />;

  return (
    <div className="px-8 pb-12 flex flex-col gap-10 max-w-[800px]">
      <SettingGroup title="外观">
        <SettingRow title="主题" description="跟随系统时和 macOS 的外观一起切换。">
          <Segmented value={s.theme} onChange={(v) => void set("theme", v)} options={THEMES} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Claude">
        <SettingRow title="claude 命令" description="启动 worker 和书记用的可执行文件，可以是完整路径。">
          {text("claudeBin", "claude 命令")}
        </SettingRow>
        <SettingRow title="启动方式" description={`桌面端走辅助功能，在 Claude 侧栏里可见；print 和 bg 在后台跑 claude -p。${RESTART}`}>
          <Segmented value={s.claudeLaunchMode} onChange={(v) => void set("claudeLaunchMode", v)} options={CLAUDE_LAUNCH} />
        </SettingRow>
        <SettingRow title="worker 权限" description="后台 worker 的 --permission-mode；bypassPermissions 跳过一切确认。">
          <Select ariaLabel="worker 权限" value={s.permissionMode} onChange={(v) => void set("permissionMode", v)} options={PERMISSION} />
        </SettingRow>
        <SettingRow title="默认模型" description="留空用 CLI 自己的默认。">
          {text("defaultModel", "默认模型", { placeholder: "CLI 默认" })}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Codex">
        <SettingRow title="codex 命令" description="启动 Codex worker 用的可执行文件。">
          {text("codexBin", "codex 命令")}
        </SettingRow>
        <SettingRow title="启动方式" description={`exec 在后台跑 codex exec；桌面端走辅助功能，在 Codex app 侧栏里可见。${RESTART}`}>
          <Segmented value={s.codexLaunchMode} onChange={(v) => void set("codexLaunchMode", v)} options={CODEX_LAUNCH} />
        </SettingRow>
        <SettingRow title="模型" description="留空用 ~/.codex/config.toml 里的。">
          {text("codexModel", "模型", { placeholder: "config.toml 的" })}
        </SettingRow>
        <SettingRow title="沙箱" description="codex exec 的 --sandbox；审计一律 read-only。">
          <Select ariaLabel="沙箱" value={s.codexSandbox} onChange={(v) => void set("codexSandbox", v)} options={SANDBOX} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="书记">
        <SettingRow title="用谁" description="自动：有 DeepSeek key 就用 DeepSeek，否则用 claude -p。">
          <Segmented value={s.clerkBackend} onChange={(v) => void set("clerkBackend", v)} options={CLERK} />
        </SettingRow>
        <SettingRow title="DeepSeek API key" description="整理工单和自动分类都用它。">
          {text("deepseekApiKey", "DeepSeek API key", { kind: "password" })}
        </SettingRow>
        <SettingRow title="DeepSeek 模型">{text("deepseekModel", "DeepSeek 模型")}</SettingRow>
        <SettingRow title="自动分类收件" description="每轮把收件里的工单判成可派、要设计，或者直接回答。关掉就都由你手点。">
          {toggle("autoTriage", "自动分类收件")}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="守护进程">
        <SettingRow title="PR 后审计" description="worker 开了 PR 就起一轮只读审计，最多三轮，过了才进待合并。">
          {toggle("auditEnabled", "PR 后审计")}
        </SettingRow>
        <SettingRow title="worker 走后台 QoS" description={`用 taskpolicy -b 启动，不和你抢 CPU。${RESTART}`}>
          {toggle("workerLowPriority", "worker 走后台 QoS")}
        </SettingRow>
        <SettingRow title="登录时启动" description="常驻托盘，守护进程随你登录就在。">
          {toggle("launchAtLogin", "登录时启动")}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="其他">
        <SettingRow title="worktree 根目录" description="每张工单的 worktree 都建在这下面，按项目分文件夹。" wide>
          {text("worktreeRoot", "worktree 根目录")}
        </SettingRow>
        <SettingRow title="记一条的快捷键" description={`Electron 的快捷键写法。${RESTART}`}>
          {text("quickCaptureShortcut", "记一条的快捷键")}
        </SettingRow>
        <SettingRow title="外部 Postgres" description={`留空用内置的。${RESTART}`} wide>
          {text("pgConnectionString", "外部 Postgres", { placeholder: "postgres://…" })}
        </SettingRow>
        <SettingRow title="MCP 端口" description={RESTART}>
          {text("mcpPort", "MCP 端口", { kind: "number" })}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Claude 桌面端">
        <SettingRow title="辅助功能授权" description={axDescription(ax)}>
          {ax && ax.available && !ax.trusted && <Button onClick={() => api.ax.status(true).then(setAx)}>请求授权</Button>}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="接入">
        <SettingRow title="数据库" description={s.pg.embedded ? "内置的 Postgres，随 app 启停。" : "外部 Postgres。"} stacked>
          <Code>{s.pg.connectionString}</Code>
        </SettingRow>
        <SettingRow title="MCP" description="app 在跑时可用。接进去之后在任何会话里说「提成工单」就行。" stacked>
          <div className="flex flex-col gap-2 w-full">
            <Code>claude mcp add --scope user --transport http chancery http://127.0.0.1:{s.mcpPort}/mcp</Code>
            <Code>codex mcp add chancery --url http://127.0.0.1:{s.mcpPort}/mcp</Code>
          </div>
        </SettingRow>
      </SettingGroup>
    </div>
  );
}

function axDescription(ax: AxStatus | null): ReactNode {
  if (!ax) return "检查中…";
  if (!ax.available) return <span className="text-error">axctl 不可用：{ax.error}</span>;
  if (!ax.trusted) return <span className="text-warn">还没有辅助功能授权。系统设置 → 隐私与安全性 → 辅助功能。</span>;
  if (ax.probe && !ax.probe.ok) return <span className="text-warn">已授权，但读不到桌面端：{ax.probe.error}</span>;
  return `已授权 · 桌面端列出 ${ax.probe?.projects?.length ?? 0} 个项目${ax.probe?.composer?.usage ? ` · 用量 ${ax.probe.composer.usage}` : ""}`;
}

/** Edits locally, commits on blur or Enter, and takes the saved value back when it changes underneath. */
function TextField({ label, value, onCommit, kind = "text", placeholder }: { label: string; value: string; onCommit: (v: string) => void; kind?: "text" | "password" | "number"; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      className="no-drag h-9 w-full"
      aria-label={label}
      type={kind}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[12.5px] text-text/80 bg-panel2 rounded-md px-3 py-2 select-all w-full break-all leading-snug">{children}</code>;
}
