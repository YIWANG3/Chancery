import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, MessageSquare, SquareTerminal } from "lucide-react";
import type { TicketStatus } from "@core/types";
import type { MsgKey } from "@core/i18n";
import { api, type SessionOpen } from "./api";
import { cn } from "./cn";
import { useT, type T } from "./i18n";

/** The dictionary key of a ticket status's label; `t(statusKey(s))` is the word on screen. */
export const statusKey = (status: TicketStatus): MsgKey => `ticket.${status}`;

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
  const t = useT();
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap", STATUS_TONE[status], className)}>
      <span className={cn("size-2 rounded-full", STATUS_DOT[status])} />
      {t(statusKey(status))}
    </span>
  );
}

/** Sizes follow the desktop apps this sits beside: 36px controls, 32px for compact ones. */
/** The id of the element in the window's title row that a page renders its main action into, through a portal. */
export const PAGE_ACTIONS = "page-actions";

export function Button({ children, onClick, kind = "default", size = "md", disabled, title, className = "", ariaLabel }: { children: ReactNode; onClick?: () => void; kind?: "default" | "primary" | "ghost" | "danger"; size?: "sm" | "md"; disabled?: boolean; title?: string; className?: string; ariaLabel?: string }) {
  const tone = {
    default: "bg-panel2 hover:bg-hover text-text",
    primary: "bg-inverse text-inverse-text hover:opacity-90",
    ghost: "text-muted hover:bg-panel2 hover:text-text",
    danger: "bg-panel2 hover:bg-error/15 text-error",
  }[kind];
  const dims = size === "sm" ? "h-8 px-3 gap-1.5 text-[13px]" : "h-9 px-4 gap-2 text-[14px]";
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={ariaLabel} className={cn("no-drag inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none", dims, tone, className)}>
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
export function Segmented<T extends string>({ value, options, onChange, className, size = "md" }: { value: T; options: Array<{ value: T; label: ReactNode; title?: string; ariaLabel?: string }>; onChange: (v: T) => void; className?: string; /** `sm` for a bar of filters, where width matters more than a large target. */ size?: "sm" | "md" }) {
  const sm = size === "sm";
  return (
    <div role="radiogroup" className={cn("inline-flex shrink-0 items-center rounded-md bg-panel2 gap-0.5", sm ? "h-7 p-0.5" : "h-9 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.ariaLabel}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn("no-drag rounded-[5px] inline-flex items-center gap-2 whitespace-nowrap transition-colors", sm ? "h-6 px-2 text-[12px]" : "h-7 px-3 text-[13px]", value === o.value ? "bg-raised text-text shadow-sm" : "text-muted hover:text-text")}
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
      className={cn("no-drag relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors disabled:opacity-40", checked ? "bg-inverse" : "bg-hover", className)}
    >
      <span className={cn("absolute top-[2px] size-[18px] rounded-full shadow-sm transition-[left]", checked ? "left-[18px] bg-inverse-text" : "left-[2px] bg-white")} />
    </button>
  );
}

/** A native select in the app's field style; options carry their own labels so values can stay raw. */
export function Select<T extends string>({ value, options, onChange, ariaLabel, className, size = "md" }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; ariaLabel: string; className?: string; size?: "sm" | "md" }) {
  return (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value as T)} className={cn("no-drag w-full", size === "sm" ? "h-7 min-h-0 py-0 pl-2.5 pr-6 rounded-md text-[12px] [background-position:right_7px_center]" : "h-9", className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A quiet dropdown for the row of choices under a composer: the trigger is the chosen label and a chevron with no
 * box of its own, and the list opens under it. A filled field per choice there would be louder than what is being
 * written. Arrow keys move, Return picks, Escape closes; the trigger is named by `ariaLabel`, so what it shows is
 * its text, not its name.
 */
export function Menu<T extends string>({ value, options, onChange, ariaLabel, placeholder, icon, className }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; ariaLabel: string; /** Shown when `value` is none of the options. */ placeholder?: string; icon?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);
  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);
  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const pick = (v: T) => {
    // Back to the trigger first, so a caller that moves the focus on from its onChange has the last word.
    close();
    onChange(v);
  };
  return (
    <div
      className={cn("relative inline-flex min-w-0", className)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={!options.length}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show();
          } else if (e.key === "Escape" && open) {
            // The focus is back here after a click on the trigger while the list is open.
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={cn("no-drag inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors hover:bg-panel2 hover:text-text disabled:pointer-events-none disabled:opacity-60", open ? "bg-panel2 text-text" : "text-muted")}
      >
        {icon}
        <span className="truncate">{current?.label ?? placeholder}</span>
        <ChevronDown size={13} className="shrink-0 opacity-70" />
      </button>
      {open && (
        <div
          ref={list}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-activedescendant={`${id}-${active}`}
          onKeyDown={(e) => {
            const last = options.length - 1;
            const to = { ArrowDown: Math.min(last, active + 1), ArrowUp: Math.max(0, active - 1), Home: 0, End: last }[e.key];
            if (to !== undefined) {
              e.preventDefault();
              setActive(to);
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              const o = options[active];
              if (o) pick(o.value);
            } else if (e.key === "Escape") {
              // Only the list closes; whatever the list sits in (a form that Escape also closes) stays.
              e.stopPropagation();
              close();
            } else if (e.key === "Tab") {
              setOpen(false);
            }
          }}
          className="no-drag absolute left-0 top-full z-menu mt-1 flex max-h-[320px] min-w-[200px] max-w-[340px] flex-col gap-px overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-xl outline-none"
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={o.value === value}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(o.value)}
              className={cn("flex h-8 shrink-0 cursor-pointer items-center gap-3 rounded-md px-2 text-[13px] text-text", i === active && "bg-panel2")}
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.value === value && <Check size={14} className="shrink-0 text-muted" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A value picked along a line, with the value said beside it. It reports while it is dragged (`onChange`) and once
 *  when it is let go (`onCommit`), for a setting that is costly to apply. */
export function Slider({ value, min = 0, max = 100, step = 1, onChange, onCommit, ariaLabel, format = String, className }: { value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; onCommit?: (v: number) => void; ariaLabel: string; format?: (v: number) => string; className?: string }) {
  return (
    <span className={cn("inline-flex w-full items-center gap-3", className)}>
      <input
        type="range"
        aria-label={ariaLabel}
        aria-valuetext={format(value)}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number(e.currentTarget.value))}
        onKeyUp={(e) => onCommit?.(Number(e.currentTarget.value))}
        className="no-drag h-4 min-h-0 min-w-0 flex-1 cursor-pointer bg-transparent p-0 accent-[rgb(var(--inverse-bg))] hover:bg-transparent"
      />
      <span className="w-10 shrink-0 text-right text-[13px] tabular-nums text-muted">{format(value)}</span>
    </span>
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
const SESSION_TARGET: Record<string, { label: (t: T) => string; action: MsgKey; Icon: typeof MessageSquare }> = {
  desktop: { label: (t) => t("common.claudeDesktop"), action: "session.openIn.claude", Icon: MessageSquare },
  "codex-app": { label: (t) => t("common.codexApp"), action: "session.openIn.codex", Icon: MessageSquare },
  // Tool names are the same in every language.
  "terminal:claude": { label: () => "Claude CLI", action: "session.openTerminal.claude", Icon: SquareTerminal },
  "terminal:codex": { label: () => "Codex CLI", action: "session.openTerminal.codex", Icon: SquareTerminal },
  "terminal:gemini": { label: () => "Gemini CLI", action: "session.openTerminal.gemini", Icon: SquareTerminal },
  "terminal:opencode": { label: () => "OpenCode", action: "session.openTerminal.opencode", Icon: SquareTerminal },
  "terminal:qwen": { label: () => "Qwen Code", action: "session.openTerminal.qwen", Icon: SquareTerminal },
};

/** Jumps to the worker's conversation. Always icon plus the target's name, so a card says which tool it opens.
 *  Renders nothing when there is nowhere to go, so callers can place it unconditionally. Stops the click so a card
 *  underneath does not also open. */
export function OpenSession({ open, size = "sm", className }: { open: SessionOpen | null | undefined; size?: "sm" | "md"; className?: string }) {
  const t = useT();
  if (!open) return null;
  const target = SESSION_TARGET[open.kind === "terminal" ? `terminal:${open.bin}` : open.kind];
  if (!target) return null;
  const { Icon } = target;
  const label = target.label(t);
  const action = t(target.action);
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
