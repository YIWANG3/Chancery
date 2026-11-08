import { useEffect, useState } from "react";
import { Bot, FolderGit2, MessagesSquare, Minimize2, Settings as SettingsIcon } from "lucide-react";
import { Tickets } from "./pages/Tickets";
import { Sessions } from "./pages/Sessions";
import { Projects } from "./pages/Projects";
import { Capture } from "./pages/Capture";
import { Notices } from "./pages/Notices";
import { Float } from "./pages/Float";
import { Agents } from "./pages/Agents";
import { SettingsPage } from "./pages/Settings";
import { heldUpSessions } from "@core/sessionAlerts";
import { useChanged } from "./hooks";
import { api } from "./api";
import { cn } from "./cn";

const HOME = "/sessions";

// The ticket page is no longer in the navigation: the app is now about watching sessions, and the ticket pipeline is
// shelved. Its route still resolves (`#/tickets`) so the code and its end-to-end test keep working until it is
// either revived or deleted.
const HIDDEN_TITLE: Record<string, string> = { "/tickets": "工单" };

const NAV = [
  { route: "/sessions", label: "会话", icon: MessagesSquare },
  { route: "/projects", label: "项目", icon: FolderGit2 },
  { route: "/agents", label: "Agent", icon: Bot },
  { route: "/settings", label: "设置", icon: SettingsIcon },
];

function useRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(() => location.hash.replace(/^#/, "") || HOME);
  useEffect(() => {
    const on = () => setRoute(location.hash.replace(/^#/, "") || HOME);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (r) => (location.hash = r)];
}

export function App() {
  const [route, go] = useRoute();
  if (route.startsWith("/capture")) return <Capture />;
  if (route.startsWith("/notices")) return <Notices />;
  if (route.startsWith("/float")) return <Float />;
  const raw = route.split("?")[0] ?? HOME;
  const page = raw === "/board" || raw === "/inbox" ? "/tickets" : raw;
  return (
    <div className="relative flex h-full bg-app">
      {/* The strip above the inset container still drags the window. */}
      <div className="drag absolute top-0 inset-x-0 h-2" />
      <aside className="w-[232px] shrink-0 bg-sidebar flex flex-col">
        <div className="drag h-[56px] shrink-0" />
        <nav className="px-2 flex flex-col gap-0.5">
          {NAV.map(({ route: r, label, icon: Icon }) => (
            <button key={r} onClick={() => go(r)} aria-current={page === r ? "page" : undefined} className={cn("no-drag flex items-center gap-2.5 px-3 h-9 rounded-md text-left text-[14px]", page === r ? "bg-panel2 text-text font-medium" : "text-muted hover:bg-panel2 hover:text-text")}>
              <Icon size={17} strokeWidth={page === r ? 2 : 1.5} />
              <span>{label}</span>
              {r === "/sessions" && <HeldUpCount />}
            </button>
          ))}
        </nav>
        <div className="mt-auto px-3 py-3">
          <DaemonBadge />
        </div>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col my-2 mr-2 rounded-lg border border-line bg-panel overflow-hidden">
        <div className="drag h-[52px] shrink-0 flex items-center pl-8 pr-4">
          <span className="text-[16px] font-medium">{NAV.find((n) => n.route === page)?.label ?? HIDDEN_TITLE[page] ?? ""}</span>
          {/* The window's own control, so it sits in the window's corner on every page, apart from any page's filters. */}
          <button type="button" aria-label="最小化到浮窗" title="最小化到浮窗：收起这个窗口，换成一个总在最前面的小窗，列出在等你、待看和在跑的会话" onClick={() => void api.float.show()} className="no-drag ml-auto size-8 inline-flex items-center justify-center rounded-md text-muted hover:text-text hover:bg-panel2">
            <Minimize2 size={15} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {page === "/sessions" && <Sessions />}
          {page === "/tickets" && <Tickets />}
          {page === "/projects" && <Projects />}
          {page === "/agents" && <Agents />}
          {page === "/settings" && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}

/** How many sessions are stopped until you do something: the same number as on the dock icon and the menu bar item.
 *  The main process says when it changes; the timer only covers a window that was hidden meanwhile. */
function HeldUpCount() {
  const [n, setN] = useState(0);
  useChanged(
    () => {
      void api.sessions
        .overview()
        .then((o) => setN(heldUpSessions(o).length))
        .catch(() => {});
    },
    [],
    { everyMs: 30_000 },
  );
  if (!n) return null;
  return (
    <span className="ml-auto text-[12px] tabular-nums rounded-full bg-warn/15 text-warn px-2 leading-[20px]" title={`最近 3 天里有 ${n} 个会话在等你`}>
      <span className="sr-only">，</span>
      {n}
      <span className="sr-only"> 个在等你</span>
    </span>
  );
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
    <button onClick={() => api.daemon.pause(!s.paused).then(setS)} title={s.lastError ?? (s.lastTickAt ? `上次 ${new Date(s.lastTickAt).toLocaleTimeString()}` : "")} className="no-drag flex items-center gap-2.5 h-9 px-3 -mx-1 rounded-md text-[13px] text-muted hover:bg-panel2 hover:text-text">
      <span className={cn("inline-block size-2 rounded-full", color)} />
      {label}
    </button>
  );
}
