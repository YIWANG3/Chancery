import { useEffect, useState, type ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import type { Overview, SessionApp } from "@core/overview";
import { api, type AxStatus } from "./api";
import { cn } from "./cn";
import { useT } from "./i18n";
import { SESSION_APPS, isDrivable } from "@core/sessionApps";
import { APP_LABEL } from "./sessionBits";
import { Button, Switch } from "./ui";

/** How often the note looks again for the Accessibility permission while it is not there: it is granted in System
 *  Settings, which says nothing back. */
const AX_RECHECK_MS = 3000;

/**
 * What a person sees the first time the session page opens, until they put it away: what the page is, what it found
 * on this machine, and the two things that are theirs to decide (the permission that replying needs, and whether to
 * be told when a session stops). Nothing on it has to be done first: the list underneath already works.
 */
export function Welcome({ overview, alerts, onAlerts, onDismiss }: { overview: Overview; alerts: boolean; onAlerts: (on: boolean) => void; onDismiss: () => void }) {
  const t = useT();
  const [ax, setAx] = useState<AxStatus | null>(null);
  const trusted = ax?.trusted ?? null;
  useEffect(() => {
    if (trusted) return;
    let live = true;
    const look = () => void api.ax.status(false, true).then((s) => live && setAx(s)).catch(() => {});
    look();
    const timer = setInterval(look, AX_RECHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [trusted]);

  const source = (app: SessionApp) => {
    const n = overview.sessions.filter((s) => s.app === app).length;
    const found = overview.sources[app];
    return (
      <Row key={app} ok={found} title={APP_LABEL[app]}>
        {!found ? t("welcome.missing") : n ? t("welcome.found", { n }) : t("welcome.foundNone")}
      </Row>
    );
  };

  return (
    <section aria-label={t("welcome.label")} className="shrink-0 mx-8 mb-5 rounded-xl bg-panel2 px-5 py-4 flex flex-col gap-3 text-[14px]">
      <div className="flex flex-col gap-1 text-pretty">
        <h2 className="text-[15px] font-medium text-text">{t("welcome.title")}</h2>
        <p className="text-[13px] leading-5 text-muted max-w-[640px]">{t("welcome.body")}</p>
      </div>
      <ul className="flex flex-col">
        {/* The two apps that can also be driven from here are always named; any other only where it was found. */}
        {SESSION_APPS.filter((app) => isDrivable(app) || overview.sources[app]).map(source)}
        <Row
          ok={trusted === true}
          title={t("welcome.ax")}
          action={
            ax && ax.available && !ax.trusted ? (
              <Button size="sm" onClick={() => void api.ax.grant()}>
                {t("start.grant")}
              </Button>
            ) : null
          }
        >
          {trusted ? t("welcome.axOk") : ax && ax.available && !ax.trusted ? t("welcome.axMissing", { self: ax.askedOf ?? "Chancery" }) : t("welcome.axHint")}
        </Row>
        <Row ok={alerts} title={t("settings.sessionAlerts")} action={<Switch ariaLabel={t("settings.sessionAlerts")} checked={alerts} onChange={onAlerts} />}>
          {t("settings.sessionAlertsHint")}
        </Row>
      </ul>
      <div>
        <Button size="sm" kind="primary" onClick={onDismiss}>
          {t("welcome.dismiss")}
        </Button>
      </div>
    </section>
  );
}

/** One line of the note: a mark for whether it is in place, what it is, and how it stands. */
function Row({ ok, title, children, action }: { ok: boolean; title: string; children: ReactNode; action?: ReactNode }) {
  const Mark = ok ? Check : Minus;
  return (
    <li className="flex items-center gap-3 py-1.5 min-h-9">
      <Mark size={15} strokeWidth={2} className={cn("shrink-0", ok ? "text-success" : "text-muted")} aria-hidden />
      <span className="w-[136px] shrink-0 text-text">{title}</span>
      <span className="min-w-0 flex-1 text-[13px] leading-5 text-muted text-pretty">{children}</span>
      {action && <span className="shrink-0">{action}</span>}
    </li>
  );
}
