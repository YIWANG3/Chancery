import { useEffect, useState } from "react";
import { Bot, FolderGit2, ListTodo, Settings as SettingsIcon } from "lucide-react";
import { NEEDS_ME, Tickets } from "./pages/Tickets";
import { Projects } from "./pages/Projects";
import { Capture } from "./pages/Capture";
import { Agents } from "./pages/Agents";
import { SettingsPage } from "./pages/Settings";
import { useChanged } from "./hooks";
import { api } from "./api";
import { cn } from "./cn";

const NAV = [
  { route: "/tickets", label: "工单", icon: ListTodo },
  { route: "/projects", label: "项目", icon: FolderGit2 },
  { route: "/agents", label: "Agent", icon: Bot },
  { route: "/settings", label: "设置", icon: SettingsIcon },
];

function useRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(() => location.hash.replace(/^#/, "") || "/tickets");
  useEffect(() => {
    const on = () => setRoute(location.hash.replace(/^#/, "") || "/tickets");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (r) => (location.hash = r)];
}

export function App() {
  const [route, go] = useRoute();
  if (route.startsWith("/capture")) return <Capture />;
  const raw = route.split("?")[0] ?? "/tickets";
  const page = raw === "/board" || raw === "/inbox" ? "/tickets" : raw;
  return (
    <div className="flex h-full">
      <aside className="w-[240px] shrink-0 bg-sidebar border-r border-line flex flex-col">
        <div className="drag h-[56px] shrink-0" />
        <nav className="px-3 flex flex-col gap-1">
          {NAV.map(({ route: r, label, icon: Icon }) => (
            <button key={r} onClick={() => go(r)} aria-current={page === r ? "page" : undefined} className={cn("no-drag flex items-center gap-2.5 px-3 h-9 rounded-md text-left text-[14px]", page === r ? "bg-hover text-text font-medium" : "text-muted hover:bg-hover/60 hover:text-text")}>
              <Icon size={17} strokeWidth={page === r ? 2 : 1.5} />
              <span>{label}</span>
              {r === "/tickets" && <InboxCount />}
            </button>
          ))}
        </nav>
        <div className="mt-auto p-4">
          <DaemonBadge />
        </div>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col bg-app">
        <div className="drag h-[56px] shrink-0 flex items-center px-8">
          <span className="text-[16px] font-medium">{NAV.find((n) => n.route === page)?.label ?? ""}</span>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {page === "/tickets" && <Tickets />}
          {page === "/projects" && <Projects />}
          {page === "/agents" && <Agents />}
          {page === "/settings" && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}

function InboxCount() {
  const [n, setN] = useState(0);
  useChanged(() => {
    void api.tickets.list({ status: NEEDS_ME }).then((t) => setN(t.length));
  });
  if (!n) return null;
  return <span className="ml-auto text-[12px] tabular-nums rounded-full bg-warn/15 text-warn px-2 leading-[20px]">{n}</span>;
}

function DaemonBadge() {
  const [s, setS] = useState<{ running: boolean; paused: boolean; lastTickAt: string | null; lastError: string | null } | null>(null);
  useChanged(() => {
    void api.daemon.status().then(setS);
  });
  if (!s) return null;
  const color = !s.running ? "bg-error" : s.paused ? "bg-warn" : s.lastError ? "bg-error" : "bg-success";
  const label = !s.running ? "守护进程没在跑" : s.paused ? "已暂停" : s.lastError ? "上次出错" : "在跑";
  return (
    <button onClick={() => api.daemon.pause(!s.paused).then(setS)} title={s.lastError ?? (s.lastTickAt ? `上次 ${new Date(s.lastTickAt).toLocaleTimeString()}` : "")} className="no-drag flex items-center gap-2.5 h-9 px-3 -mx-1 rounded-md text-[13px] text-muted hover:bg-hover/60 hover:text-text">
      <span className={cn("inline-block size-2 rounded-full", color)} />
      {label}
    </button>
  );
}
