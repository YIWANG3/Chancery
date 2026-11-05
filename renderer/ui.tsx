import type { ReactNode } from "react";
import { MessageSquare, SquareTerminal } from "lucide-react";
import type { TicketStatus } from "@core/types";
import { api, type SessionOpen } from "./api";
import { cn } from "./cn";

export const STATUS_LABEL: Record<TicketStatus, string> = {
  inbox: "收件",
  "needs-spec": "要设计",
  ready: "可派",
  "in-progress": "进行中",
  review: "待审",
  "awaiting-merge": "待合并",
  "needs-human": "等我",
  blocked: "被挡",
  done: "完成",
};

export const STATUS_TONE: Record<TicketStatus, string> = {
  inbox: "text-muted",
  "needs-spec": "text-warn",
  ready: "text-accent",
  "in-progress": "text-accent",
  review: "text-success",
  "awaiting-merge": "text-success",
  "needs-human": "text-warn",
  blocked: "text-error",
  done: "text-muted",
};

const STATUS_DOT: Record<TicketStatus, string> = {
  inbox: "bg-muted/60",
  "needs-spec": "bg-warn",
  ready: "bg-accent",
  "in-progress": "bg-accent",
  review: "bg-success",
  "awaiting-merge": "bg-success",
  "needs-human": "bg-warn",
  blocked: "bg-error",
  done: "bg-muted/60",
};

/** Status is always a dot plus its label, never color alone. */
export function Status({ status, className }: { status: TicketStatus; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap", STATUS_TONE[status], className)}>
      <span className={cn("size-2 rounded-full", STATUS_DOT[status])} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Sizes follow the desktop apps this sits beside: 36px controls, 32px for compact ones. */
export function Button({ children, onClick, kind = "default", size = "md", disabled, title, className = "", ariaLabel }: { children: ReactNode; onClick?: () => void; kind?: "default" | "primary" | "ghost" | "danger"; size?: "sm" | "md"; disabled?: boolean; title?: string; className?: string; ariaLabel?: string }) {
  const tone = {
    default: "bg-panel2 hover:bg-hover text-text",
    primary: "bg-inverse text-inverse-text hover:opacity-90",
    ghost: "text-muted hover:bg-panel2 hover:text-text",
    danger: "bg-panel2 hover:bg-error/15 text-error",
  }[kind];
  const dims = size === "sm" ? "h-8 px-3 gap-1.5 text-[13px]" : "h-9 px-4 gap-2 text-[14px]";
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={ariaLabel} className={cn("no-drag inline-flex items-center justify-center rounded-md font-medium disabled:opacity-40 disabled:pointer-events-none", dims, tone, className)}>
      {children}
    </button>
  );
}

export function Pill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center h-[22px] px-2 rounded text-[12px] bg-panel2 text-muted whitespace-nowrap", className)}>{children}</span>;
}

/** An empty state has one clear next action when there is one to take. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-4 px-8 py-14 text-[14px] text-muted text-pretty">
      <span>{children}</span>
      {action}
    </div>
  );
}

/** Exclusive choices drawn as one fill with the chosen item lifted; no borders between items. */
export function Segmented<T extends string>({ value, options, onChange, className }: { value: T; options: Array<{ value: T; label: ReactNode; title?: string; ariaLabel?: string }>; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="radiogroup" className={cn("inline-flex items-center h-9 p-1 rounded-md bg-panel2 gap-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.ariaLabel}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn("no-drag h-7 px-3 rounded-[5px] text-[13px] inline-flex items-center gap-2", value === o.value ? "bg-panel text-text shadow-sm" : "text-muted hover:text-text")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A small muted label above a group; groups are separated by space, not lines. */
export function SectionLabel({ children, className, right }: { children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <div className={cn("flex items-center gap-3 min-h-9 text-[13px] text-muted", className)}>
      <span>{children}</span>
      {right && <span className="ml-auto flex items-center gap-2.5">{right}</span>}
    </div>
  );
}

/** An on/off control drawn like the desktop apps' switches; the label lives in the row, so it takes an aria-label. */
export function Switch({ checked, onChange, ariaLabel, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; ariaLabel: string; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("no-drag relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors disabled:opacity-40", checked ? "bg-accent" : "bg-hover", className)}
    >
      <span className={cn("absolute top-[2px] size-[18px] rounded-full bg-white shadow-sm transition-[left]", checked ? "left-[18px]" : "left-[2px]")} />
    </button>
  );
}

/** A native select in the app's field style; options carry their own labels so values can stay raw. */
export function Select<T extends string>({ value, options, onChange, ariaLabel, className }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; ariaLabel: string; className?: string }) {
  return (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value as T)} className={cn("no-drag h-9 w-full", className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** One settings row: title and a one-line explanation on the left, the control on the right. Rows in a group are
 *  separated by lines so every row has the same rhythm whatever its control is. */
export function SettingRow({ title, description, children, wide, stacked }: { title: ReactNode; description?: ReactNode; children?: ReactNode; wide?: boolean; stacked?: boolean }) {
  return (
    <div className={cn("flex py-4 border-b border-line last:border-b-0", stacked ? "flex-col gap-3" : "items-center justify-between gap-8")}>
      <div className="flex flex-col gap-1 min-w-0 text-pretty">
        <div className="text-[14px] text-text">{title}</div>
        {description && <div className="text-[13px] text-muted leading-snug">{description}</div>}
      </div>
      {children && <div className={cn("shrink-0 flex items-center", stacked ? "w-full" : cn("justify-end", wide ? "w-[320px]" : "w-[240px]"))}>{children}</div>}
    </div>
  );
}

/** A settings group: a heading, then its rows. */
export function SettingGroup({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="text-[15px] font-medium text-text mb-1">{title}</h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/** Where a session can be reopened, named by the tool you land in. New targets (a Cursor or Antigravity session)
 *  add a row here and a kind to SessionOpen; nothing else in the UI needs to know. */
const SESSION_TARGET: Record<string, { label: string; action: string; Icon: typeof MessageSquare }> = {
  desktop: { label: "Claude 桌面端", action: "在 Claude 桌面端打开这个会话", Icon: MessageSquare },
  "terminal:claude": { label: "Claude CLI", action: "在终端里续聊：claude --resume", Icon: SquareTerminal },
  "terminal:codex": { label: "Codex CLI", action: "在终端里续聊：codex resume", Icon: SquareTerminal },
};

/** Jumps to the worker's conversation. Always icon plus the target's name, so a card says which tool it opens.
 *  Renders nothing when there is nowhere to go, so callers can place it unconditionally. Stops the click so a card
 *  underneath does not also open. */
export function OpenSession({ open, size = "sm", className }: { open: SessionOpen | null | undefined; size?: "sm" | "md"; className?: string }) {
  if (!open) return null;
  const target = SESSION_TARGET[open.kind === "desktop" ? "desktop" : `terminal:${open.bin}`];
  if (!target) return null;
  const { label, action, Icon } = target;
  const go = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    void api.session.open(open);
  };
  if (size === "md")
    return (
      <Button onClick={() => void api.session.open(open)} size="sm" className={className} title={action}>
        <Icon size={14} />
        {label}
      </Button>
    );
  return (
    <button type="button" aria-label={action} title={action} onClick={go} className={cn("no-drag inline-flex items-center gap-1.5 h-6 px-1.5 -ml-1.5 rounded text-[12px] text-muted hover:text-text hover:bg-hover whitespace-nowrap", className)}>
      <Icon size={13} />
      {label}
    </button>
  );
}

export const PRIORITY_LABEL = ["", "P1", "P2", "P3", "P4"];
