// The pieces a session is drawn with wherever it appears: on the session page's rows and cards and in the
// floating window. State tables, the state label, the reply box and the reply/jump buttons.
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Reply } from "lucide-react";
import type { SessionApp, SessionRow, SessionState } from "@core/overview";
import { api } from "./api";
import { cn } from "./cn";
import { Button } from "./ui";

export const STATE_LABEL: Record<SessionState, string> = {
  "needs-you": "等我",
  error: "出错",
  stuck: "卡住",
  review: "待审",
  unread: "完成未读",
  running: "运行中",
  interrupted: "已中断",
  done: "已完成",
};

export const STATE_TONE: Record<SessionState, string> = {
  "needs-you": "text-warn",
  error: "text-error",
  stuck: "text-error",
  review: "text-success",
  unread: "text-text",
  running: "text-accent",
  interrupted: "text-muted",
  done: "text-muted",
};

export const STATE_DOT: Record<SessionState, string> = {
  "needs-you": "bg-warn",
  error: "bg-error",
  stuck: "bg-error",
  review: "bg-success",
  unread: "bg-text",
  running: "bg-accent",
  interrupted: "bg-muted/60",
  done: "bg-muted/60",
};

/** The states fold into four questions a person asks of the list. */
export type Bucket = "needs" | "look" | "running" | "ended";
export const BUCKET: Record<SessionState, Bucket> = {
  "needs-you": "needs",
  error: "needs",
  stuck: "needs",
  review: "look",
  unread: "look",
  running: "running",
  interrupted: "ended",
  done: "ended",
};
export const BUCKET_LABEL: Record<Bucket, string> = { needs: "等我", look: "待看", running: "运行中", ended: "已结束" };

export const APP_LABEL: Record<SessionApp, string> = { claude: "Claude", codex: "Codex" };
export const OPEN_LABEL: Record<SessionApp, string> = { claude: "在 Claude 桌面端打开这个会话", codex: "在 Codex 应用里打开这个会话" };

export const ago = (at: number, now: number): string => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  if (m < 48 * 60) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 1440)} 天前`;
};

/** State is always a dot plus its label, never color alone. The tooltip says which field decided it. */
export function State({ state, basis }: { state: SessionState; basis: string }) {
  return (
    <span title={`依据：${basis}`} className={cn("inline-flex items-center gap-2 whitespace-nowrap", STATE_TONE[state])}>
      <span className={cn("size-2 rounded-full", STATE_DOT[state])} />
      {STATE_LABEL[state]}
    </span>
  );
}

/** What can be done to a session from here: answer it, or go to it. Shared by the row and the card. */
export function useReply(s: SessionRow, now: number) {
  const [replying, setReplying] = useState(false);
  const [sentAt, setSentAt] = useState(0);
  // A running session cannot take a reply: its app would queue the message instead of sending it.
  const canReply = s.state !== "running";
  return {
    open: replying && canReply,
    buttons: (
      <>
        {canReply && (
          <button
            type="button"
            aria-label="回复这个会话"
            aria-expanded={replying}
            title="在这里回一句，由它自己的应用发出去"
            onClick={() => setReplying((v) => !v)}
            className={cn("no-drag size-6 inline-flex items-center justify-center rounded hover:text-text hover:bg-hover", replying ? "text-text bg-hover" : "text-muted")}
          >
            <Reply size={15} />
          </button>
        )}
        {s.open && (
          <button
            type="button"
            aria-label={OPEN_LABEL[s.app]}
            title={OPEN_LABEL[s.app]}
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
    sent: !replying && sentAt > s.at && now - sentAt < 60_000 ? `已发到 ${APP_LABEL[s.app]}，等它开始跑。` : "",
  };
}

/** A quick reply: one message, typed here, sent by the session's own app. Return sends, Shift+Return breaks the
 *  line, Escape closes. What was typed stays in the box when the send is refused, with the reason under it. */
export function ReplyBox({ s, onSent, onCancel, className, stacked }: { s: SessionRow; onSent: () => void; onCancel: () => void; className?: string; stacked?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.session.reply({ app: s.app, id: s.id, title: s.title }, text);
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
          aria-label={`回复「${s.title || "无标题"}」`}
          value={text}
          disabled={busy}
          rows={Math.min(6, Math.max(stacked ? 2 : 1, text.split("\n").length))}
          placeholder={`回一句，发到 ${APP_LABEL[s.app]} 的这条会话里`}
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
          {busy ? "发送中…" : "发送"}
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

