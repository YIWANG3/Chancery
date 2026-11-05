import { useEffect, useState } from "react";
import type { Project } from "@core/types";
import { api, type DiscoveredProject } from "../api";
import { fmtTime, useChanged } from "../hooks";
import { Button, Empty, Pill, SectionLabel } from "../ui";

const SOURCE_LABEL: Record<string, string> = { "claude-desktop": "Claude 桌面端", "claude-cli": "Claude CLI", codex: "Codex" };

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [found, setFound] = useState<DiscoveredProject[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    setProjects(await api.projects.list());
    const f = await api.projects.discover();
    setFound(f);
    setPicked(new Set(f.filter((p) => p.sources.includes("claude-desktop")).map((p) => p.dir)));
  };
  useChanged(() => void refresh());
  useEffect(() => void refresh(), []);

  const importDirs = async (dirs: string[]) => {
    if (!dirs.length) return;
    setBusy(true);
    setError("");
    const results = await api.projects.registerMany(dirs);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) setError(failed.map((f) => `${f.dir.split("/").pop()}：${f.error?.replace(/^.*Error: /, "")}`).join("；"));
    await refresh();
    setBusy(false);
  };
  const register = async () => {
    setError("");
    try {
      await api.projects.register();
      await refresh();
    } catch (err) {
      setError(String(err).replace(/^.*Error: /, ""));
    }
  };

  return (
    <div className="px-8 pb-10 flex flex-col gap-10 max-w-[1040px]">
      <section className="flex flex-col gap-3">
        <SectionLabel right={<Button onClick={register}>选一个目录</Button>}>已注册 · {projects.length}</SectionLabel>
        {!projects.length && <Empty>还没有项目。下面是本机 Claude 和 Codex 用过的 git 目录，勾上导入。</Empty>}
        <div className="flex flex-col gap-3">
          {projects.map((p) => (
            <ProjectRow key={p.id} p={p} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionLabel
          right={
            <>
              <Button disabled={busy || !picked.size} kind="primary" onClick={() => importDirs([...picked])}>
                导入所选{picked.size ? ` ${picked.size}` : ""}
              </Button>
              <Button disabled={busy || !found?.length} onClick={() => importDirs((found ?? []).map((p) => p.dir))}>
                全部导入
              </Button>
            </>
          }
        >
          发现的 · {found?.length ?? "…"}
          <span className="ml-2.5 opacity-70">Claude 桌面端、Claude CLI、Codex 用过的 git 目录</span>
        </SectionLabel>
        {error && <div className="text-error text-[13px]">{error}</div>}
        {found && !found.length && <Empty>没有新的了。</Empty>}
        <div className="flex flex-col gap-0.5 -mx-3">
          {(found ?? []).map((p) => (
            <label key={p.dir} className="flex items-center gap-3.5 hover:bg-panel2 rounded-md px-3 h-10 text-[14px]">
              <input
                type="checkbox"
                checked={picked.has(p.dir)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(p.dir);
                  else next.delete(p.dir);
                  setPicked(next);
                }}
              />
              <span className="font-medium">{p.dir.split("/").pop()}</span>
              <span className="text-muted truncate min-w-0">{p.dir.replace(/^\/Users\/[^/]+/, "~")}</span>
              <span className="ml-auto flex gap-2 shrink-0 items-center">
                {p.sources.map((s) => (
                  <Pill key={s}>{SOURCE_LABEL[s] ?? s}</Pill>
                ))}
                {p.sessions > 0 && <Pill>{p.sessions} 个会话</Pill>}
                {p.lastActive && <span className="text-muted text-[12.5px] w-[96px] text-right tabular-nums">{fmtTime(p.lastActive)}</span>}
              </span>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}

function ProjectRow({ p }: { p: Project }) {
  const update = (patch: Partial<Project>) => api.projects.update(p.id, patch);
  return (
    <div className="bg-sidebar rounded-lg px-5 py-4 flex flex-col gap-3">
      <div className="flex items-center gap-3.5">
        <span className="font-medium text-[15px]">{p.name}</span>
        {p.repo && (
          <button className="text-[13px] text-muted hover:text-text" onClick={() => api.shell.open(`https://github.com/${p.repo}`)}>
            {p.repo}
          </button>
        )}
        <button className="text-[13px] text-muted hover:text-text ml-auto truncate" onClick={() => api.shell.reveal(p.dir)}>
          {p.dir.replace(/^\/Users\/[^/]+/, "~")}
        </button>
      </div>
      <div className="flex items-center gap-6 text-[13px] text-muted">
        <label className="flex items-center gap-2.5">
          执行器
          <select value={p.default_executor} onChange={(e) => update({ default_executor: e.target.value as Project["default_executor"] })} className="h-8 min-h-0 py-0 bg-panel">
            <option value="claude-desktop">Claude</option>
            <option value="codex">Codex</option>
            <option value="dsh">dsh</option>
          </select>
        </label>
        <label className="flex items-center gap-2.5">
          并发
          <input type="number" min={1} max={8} value={p.parallel} onChange={(e) => update({ parallel: Number(e.target.value) || 1 })} className="w-[64px] h-8 min-h-0 py-0 bg-panel tabular-nums" />
        </label>
        <label className="flex items-center gap-2.5">
          模型
          <input value={p.default_model ?? ""} placeholder="默认" onChange={(e) => update({ default_model: e.target.value || null })} className="w-[160px] h-8 min-h-0 py-0 bg-panel" />
        </label>
        <span>
          分支 <span className="font-mono">{p.default_branch}</span>
        </span>
      </div>
    </div>
  );
}
