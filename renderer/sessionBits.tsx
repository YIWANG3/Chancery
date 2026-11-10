// The pieces a session is drawn with wherever it appears: on the session page's rows and cards and in the
// floating window. State tables, the state label, the reply box and the reply/jump buttons.
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Reply } from "lucide-react";
import type { SessionApp, SessionRow, SessionState } from "@core/overview";
import { SESSION_BUCKET, type SessionBucket } from "@core/sessionBuckets";
import type { MsgKey } from "@core/i18n";
import { SESSION_APPS, SESSION_APP_INFO, isDrivable } from "@core/sessionApps";
import type { SearchHit, SearchMatch } from "@core/sessionIndex";
import { api } from "./api";
import { cn } from "./cn";
import { useT, type T } from "./i18n";
import { Button } from "./ui";

/** The dictionary key of a state's label; `t(stateKey(s))` is the word on screen. */
export const stateKey = (state: SessionState): MsgKey => `state.${state}`;

export const STATE_TONE: Record<SessionState, string> = {
  "needs-you": "text-warn",
  error: "text-error",
  stuck: "text-error",
  review: "text-success",
  unread: "text-text",
  running: "text-accent",
  delegated: "text-accent",
  interrupted: "text-muted",
  expired: "text-muted",
  done: "text-muted",
};

export const STATE_DOT: Record<SessionState, string> = {
  "needs-you": "bg-warn",
  error: "bg-error",
  stuck: "bg-error",
  review: "bg-success",
  unread: "bg-text",
  running: "bg-accent",
  delegated: "bg-accent/50",
  interrupted: "bg-muted/60",
  expired: "bg-muted/60",
  done: "bg-muted/60",
};

/** The states fold into four questions a person asks of the list (the table is the core's, shared with the steward's tools). */
export type Bucket = SessionBucket;
export const BUCKET = SESSION_BUCKET;
export const bucketKey = (bucket: Bucket): MsgKey => `bucket.${bucket}`;

export const APP_LABEL = Object.fromEntries(SESSION_APPS.map((app) => [app, SESSION_APP_INFO[app].name])) as Record<SessionApp, string>;

/** How far back a page looks. The overview itself reads 14 days; the pages narrow it. */
export const WINDOWS = [
  { value: "1", key: "time.today" },
  { value: "3", key: "time.last3Days" },
  { value: "14", key: "time.last14Days" },
] as const satisfies ReadonlyArray<{ value: string; key: MsgKey }>;
export type WindowDays = (typeof WINDOWS)[number]["value"];
export const windowOptions = (t: T) => WINDOWS.map((w) => ({ value: w.value, label: t(w.key) }));

/** What the jump button on a session says it does: straight to the conversation where its app has a link for that,
 *  otherwise to the conversation's folder in that app. */
export const openTitle = (s: Pick<SessionRow, "app" | "open">, t: T): string => {
  if (s.open?.kind === "folder") return t("session.openFolderIn", { app: APP_LABEL[s.app] });
  if (s.open?.kind === "app") return t("session.openApp", { app: APP_LABEL[s.app] });
  if (s.open?.kind === "terminal") return t(`session.openTerminal.${s.open.bin}`);
  return t(s.app === "codex" ? "session.openIn.codex" : "session.openIn.claude");
};

export const ago = (at: number, now: number, t: T): string => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return t("time.justNow");
  if (m < 60) return t("time.minutesAgo", { n: m });
  if (m < 48 * 60) return t("time.hoursAgo", { n: Math.round(m / 60) });
  return t("time.daysAgo", { n: Math.round(m / 1440) });
};

/** State is always a dot plus its label, never color alone. The tooltip says which field decided it. */
export function State({ state, basis }: { state: SessionState; basis: string }) {
  const t = useT();
  return (
    <span title={t("session.basis", { basis })} className={cn("inline-flex items-center gap-2 whitespace-nowrap", STATE_TONE[state])}>
      <span className={cn("size-2 rounded-full", STATE_DOT[state])} />
      {t(stateKey(state))}
    </span>
  );
}

/** What can be done to a session from here: answer it, or go to it. Shared by the row and the card. */
export function useReply(s: SessionRow, now: number) {
  const t = useT();
  const [replying, setReplying] = useState(false);
  const [sentAt, setSentAt] = useState(0);
  // A running session cannot take a reply: its app would queue the message instead of sending it.
  const canReply = isDrivable(s.app) && s.state !== "running";
  return {
    open: replying && canReply,
    buttons: (
      <>
        {canReply && (
          <button
            type="button"
            aria-label={t("session.reply")}
            aria-expanded={replying}
            title={t("session.replyHint")}
            onClick={() => setReplying((v) => !v)}
            className={cn("no-drag size-6 inline-flex items-center justify-center rounded hover:text-text hover:bg-hover", replying ? "text-text bg-hover" : "text-muted")}
          >
            <Reply size={15} />
          </button>
        )}
        {s.open && (
          <button
            type="button"
            aria-label={openTitle(s, t)}
            title={openTitle(s, t)}
            onClick={() => s.open && void api.session.open(s.open)}
            className="no-drag size-6 inline-flex items-center justify-center rounded text-muted hover:text-text hover:bg-hover"
          >
            <ArrowUpRight size={15} />
          </button>
        )}
      </>
    ),
    box: (opts: { className?: string; stacked?: boolean } = {}) => (
      <ReplyBox
        s={s}
        className={opts.className}
        stacked={opts.stacked}
        onSent={() => {
          setReplying(false);
          setSentAt(Date.now());
        }}
        onCancel={() => setReplying(false)}
      />
    ),
    // Until the next read shows the session running, say that the message went out.
    sent: !replying && sentAt > s.at && now - sentAt < 60_000 ? t("session.sent", { app: APP_LABEL[s.app] }) : "",
  };
}

/** A quick reply: one message, typed here, sent by the session's own app. Return sends, Shift+Return breaks the
 *  line, Escape closes. What was typed stays in the box when the send is refused, with the reason under it. */
export function ReplyBox({ s, onSent, onCancel, className, stacked }: { s: SessionRow; onSent: () => void; onCancel: () => void; className?: string; stacked?: boolean }) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);
  const send = async () => {
    const app = s.app;
    if (!text.trim() || busy || !isDrivable(app)) return;
    setBusy(true);
    setError("");
    try {
      await api.session.reply({ app, id: s.id, title: s.title }, text);
      onSent();
    } catch (err) {
      setError(String(err).replace(/^.*Error: /, ""));
      setBusy(false);
    }
  };
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {/* In a card there is no room beside the field, so the button goes under it and the field starts taller. */}
      <div className={cn("flex gap-2", stacked ? "flex-col items-end" : "items-end")}>
        <textarea
          ref={box}
          aria-label={t("session.replyLabel", { title: s.title || t("common.untitledShort") })}
          value={text}
          disabled={busy}
          rows={Math.min(6, Math.max(stacked ? 2 : 1, text.split("\n").length))}
          placeholder={t("session.replyPlaceholder", { app: APP_LABEL[s.app] })}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Return while an input method is composing picks a candidate; it must not send.
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            } else if (e.key === "Escape" && !busy) {
              onCancel();
            }
          }}
          className={cn("no-drag min-w-0 resize-none rounded-md border border-line bg-panel px-3 py-1.5 text-[14px] leading-6 text-text placeholder:text-muted focus:outline-none focus:border-accent disabled:opacity-60", stacked ? "w-full" : "flex-1")}
        />
        <Button size="sm" onClick={() => void send()} disabled={busy || !text.trim()}>
          {busy ? t("common.sending") : t("common.send")}
        </Button>
      </div>
      {error && (
        <span role="alert" className="text-[13px] text-error">
          {error}
        </span>
      )}
    </div>
  );
}

export interface ProjectTagProps {
  name: string;
  /** Whether the page is already narrowed to this project; clicking then widens it again. */
  active: boolean;
  onClick: () => void;
}

/** A session's project as a small tag. Clicking it narrows the page to that project, or widens it again. */
export function ProjectTag({ name, active, onClick }: ProjectTagProps) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? t("project.onlyThisActive") : t("project.onlyThis")}
      className={cn("no-drag inline-flex items-center h-[22px] max-w-[180px] px-2 rounded text-[12px] whitespace-nowrap hover:bg-hover hover:text-text", active ? "bg-hover text-text" : "bg-panel2 text-muted")}
    >
      <span className="truncate">{name}</span>
    </button>
  );
}

export interface FoundProps {
  match: SearchMatch;
  /** The words that were searched for, to mark in the snippet. */
  words: string[];
}

/** What to show of a search hit under its session: the first match inside the conversation. A match in the title
 *  or the status line is already on screen, so there is nothing to add for it. */
export function foundIn(hit: SearchHit | undefined, query: string): FoundProps | undefined {
  const match = hit?.matches.find((m) => m.where === "prompt" || m.where === "reply" || m.where === "file");
  return match ? { match, words: query.toLowerCase().split(/\s+/).filter(Boolean) } : undefined;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One line saying where in the conversation the search found its words, with the words marked. */
export function Found({ match, words, className }: FoundProps & { className?: string }) {
  const t = useT();
  const parts = words.length ? match.snippet.split(new RegExp(`(${words.map(escapeRe).join("|")})`, "gi")) : [match.snippet];
  return (
    <span className={cn("text-[13px] leading-[22px] text-muted", className)} title={match.turn ? t("search.turn", { n: match.turn }) : undefined}>
      <span className="mr-2 text-text/70">{t(`search.where.${match.where as "prompt" | "reply" | "file"}`)}</span>
      {parts.map((part, i) => (i % 2 ? <mark key={i} className="bg-transparent text-text font-medium">{part}</mark> : part))}
    </span>
  );
}

/** One session as a row. The title gets whatever width is left; the second line carries its project tag (when the
 *  list mixes projects) and what the session says about itself, at full strength when it is held up. */
export function SessionItem({ s, now, project, found }: { s: SessionRow; now: number; project?: ProjectTagProps; found?: FoundProps }) {
  const t = useT();
  const heldUp = BUCKET[s.state] === "needs";
  const reply = useReply(s, now);
  const second = project || s.detail;
  return (
    <div role="listitem" className="hover:bg-panel2 rounded-md px-3 py-2 flex flex-col gap-2 text-[14px]">
      <div className="flex items-start gap-3">
        <span className="w-[88px] shrink-0 leading-6">
          <State state={s.state} basis={s.basis} />
        </span>
        <span className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="truncate leading-6" title={s.title}>
            {s.title || t("common.untitled")}
          </span>
          {second && (
            <span className="flex flex-wrap lg:flex-nowrap items-start gap-x-2 gap-y-1 text-[13px] leading-[22px] text-muted">
              {project && (
                <span className="shrink-0 flex items-center gap-1.5">
                  <ProjectTag {...project} />
                  {/* In a narrow window the app's own column is dropped and its name sits here instead. */}
                  <span className="lg:hidden">{APP_LABEL[s.app]}</span>
                </span>
              )}
              {s.detail && (
                <span className={cn("w-full lg:w-auto lg:flex-1 min-w-0 line-clamp-2", heldUp && "text-text")} title={s.detail}>
                  {s.detail}
                </span>
              )}
            </span>
          )}
          {found && <Found {...found} className="line-clamp-2" />}
        </span>
        <span className={cn("w-[48px] shrink-0 text-[13px] text-muted leading-6", project && "hidden lg:block")}>{APP_LABEL[s.app]}</span>
        <span className="w-[72px] shrink-0 text-right text-[13px] text-muted tabular-nums leading-6 whitespace-nowrap" title={new Date(s.at).toLocaleString()}>
          {ago(s.at, now, t)}
        </span>
        <span className="w-[52px] shrink-0 h-6 flex items-center justify-end gap-1">{reply.buttons}</span>
      </div>
      {reply.open && reply.box({ className: "pl-[100px]" })}
      {reply.sent && <span className="pl-[100px] text-[13px] text-muted">{reply.sent}</span>}
    </div>
  );
}
