import { useEffect, useState, type ReactNode } from "react";
import type { LangPref } from "@core/i18n";
import { api, type AppSettings, type AxStatus, type ThemePref } from "../api";
import { setLang, useT, type T } from "../i18n";
import { Button, Segmented, Select, SettingGroup, SettingRow, Slider, Switch } from "../ui";

type Opt<T extends string> = { value: T; label: string };

const themes = (t: T): Opt<ThemePref>[] => [
  { value: "system", label: t("theme.system") },
  { value: "light", label: t("theme.light") },
  { value: "dark", label: t("theme.dark") },
];
// Each language is named in itself, so a person who cannot read the current one still finds their own.
const languages = (t: T): Opt<LangPref>[] => [
  { value: "system", label: t("lang.system") },
  { value: "zh", label: t("lang.zh") },
  { value: "en", label: t("lang.en") },
];
const claudeLaunch = (t: T): Opt<AppSettings["claudeLaunchMode"]>[] => [
  { value: "desktop", label: t("launch.desktop") },
  { value: "print", label: "print" },
  { value: "bg", label: "bg" },
];
const PERMISSION: Opt<string>[] = [
  { value: "auto", label: "auto" },
  { value: "acceptEdits", label: "acceptEdits" },
  { value: "bypassPermissions", label: "bypassPermissions" },
];
const codexLaunch = (t: T): Opt<AppSettings["codexLaunchMode"]>[] => [
  { value: "exec", label: "exec" },
  { value: "desktop", label: t("launch.desktop") },
];
const SANDBOX: Opt<AppSettings["codexSandbox"]>[] = [
  { value: "workspace-write", label: "workspace-write" },
  { value: "danger-full-access", label: "danger-full-access" },
  { value: "read-only", label: "read-only" },
];
const clerks = (t: T): Opt<AppSettings["clerkBackend"]>[] => [
  { value: "auto", label: t("clerk.auto") },
  { value: "deepseek", label: "DeepSeek" },
  { value: "claude", label: "Claude" },
];

/** The settings that change how the float looks or where it is: changing one shows the float as a preview. */
const FLOAT_LOOK: Array<keyof AppSettings> = ["floatPlace", "floatStyle", "floatOpacity", "notchDisplay", "notchRest", "notchOpen", "notchCorners"];

export function SettingsPage() {
  const t = useT();
  const [s, setS] = useState<AppSettings | null>(null);
  const [ax, setAx] = useState<AxStatus | null>(null);
  /** The backing opacity while its slider is being dragged; null when it is the saved one that shows. */
  const [opacity, setOpacity] = useState<number | null>(null);
  useEffect(() => {
    void api.settings.get().then(setS);
    void api.ax.status().then(setAx);
    // Leaving the page ends the float's preview, if a change here started one.
    return () => void api.float.preview(false);
  }, []);
  if (!s) return null;

  const restart = t("settings.restart");
  /** Every control saves on its own; text fields commit on blur or Enter. */
  const set = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    if (s[key] === value) return;
    // A change to how the float looks or where it is brings the float up, so the change is seen as it is made.
    if (FLOAT_LOOK.includes(key)) void api.float.preview(true);
    const next = await api.settings.set({ [key]: value } as Partial<AppSettings>);
    setS(next);
    // The main process tells every window; this one takes the new language at once, without the round trip.
    setLang(next.lang);
  };
  const text = (key: keyof AppSettings, label: string, opts: { kind?: "text" | "password" | "number"; placeholder?: string } = {}) => (
    <TextField key={key} label={label} kind={opts.kind} placeholder={opts.placeholder} value={String(s[key] ?? "")} onCommit={(v) => void set(key, (opts.kind === "number" ? Number(v) : v) as AppSettings[typeof key])} />
  );
  const toggle = (key: keyof AppSettings, label: string) => <Switch ariaLabel={label} checked={Boolean(s[key])} onChange={(v) => void set(key, v as AppSettings[typeof key])} />;

  return (
    <div className="px-8 pb-12 flex flex-col gap-10 max-w-[800px]">
      <SettingGroup title={t("settings.appearance")}>
        <SettingRow title={t("settings.theme")} description={t("settings.themeHint")}>
          <Segmented value={s.theme} onChange={(v) => void set("theme", v)} options={themes(t)} />
        </SettingRow>
        <SettingRow title={t("settings.language")} description={t("settings.languageHint")}>
          <Segmented value={s.language} onChange={(v) => void set("language", v)} options={languages(t)} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("settings.sessions")}>
        <SettingRow title={t("settings.sessionAlerts")} description={t("settings.sessionAlertsHint")}>
          {toggle("sessionAlerts", t("settings.sessionAlerts"))}
        </SettingRow>
        <SettingRow title={t("settings.floatPlace")} description={t("settings.floatPlaceHint")}>
          <Segmented value={s.floatPlace} onChange={(v) => void set("floatPlace", v)} options={s.floatPlaces.map((value) => ({ value, label: t(`floatPlace.${value}`) }))} />
        </SettingRow>
        {/* Each place has its own choices; only the ones for the place the float is in are shown. */}
        {s.floatPlace === "top" && s.floatPlaces.includes("top") ? (
          <>
            <SettingRow title={t("settings.notchDisplay")} description={t("settings.notchDisplayHint")} wide>
              <Segmented value={s.notchDisplay} onChange={(v) => void set("notchDisplay", v)} options={(["active", "all", "builtin"] as const).map((value) => ({ value, label: t(`notchDisplay.${value}`) }))} />
            </SettingRow>
            <SettingRow title={t("settings.notchRest")} description={t("settings.notchRestHint")}>
              <Segmented value={s.notchRest} onChange={(v) => void set("notchRest", v)} options={(["counts", "hidden"] as const).map((value) => ({ value, label: t(`notchRest.${value}`) }))} />
            </SettingRow>
            <SettingRow title={t("settings.notchOpen")} description={t("settings.notchOpenHint")}>
              <Segmented value={s.notchOpen} onChange={(v) => void set("notchOpen", v)} options={(["hover", "click"] as const).map((value) => ({ value, label: t(`notchOpen.${value}`) }))} />
            </SettingRow>
            <SettingRow title={t("settings.notchCorners")} description={t("settings.notchCornersHint")}>
              <Segmented value={s.notchCorners} onChange={(v) => void set("notchCorners", v)} options={(["round", "tight"] as const).map((value) => ({ value, label: t(`notchCorners.${value}`) }))} />
            </SettingRow>
          </>
        ) : (
          <>
            <SettingRow title={t("settings.floatStyle")} description={t("settings.floatStyleHint")} wide>
              <Segmented value={s.floatStyle} onChange={(v) => void set("floatStyle", v)} options={s.floatStyles.map((value) => ({ value, label: t(`floatStyle.${value}`) }))} />
            </SettingRow>
            {s.floatStyle === "clear" && (
              <SettingRow title={t("settings.floatOpacity")} description={t("settings.floatOpacityHint")}>
                {/* Saved as it is dragged: the float, up beside this window, follows the slider. */}
                <Slider
                  ariaLabel={t("settings.floatOpacity")}
                  value={opacity ?? s.floatOpacity}
                  step={5}
                  format={(v) => `${v}%`}
                  onChange={(v) => {
                    setOpacity(v);
                    void set("floatOpacity", v);
                  }}
                  onCommit={() => setOpacity(null)}
                />
              </SettingRow>
            )}
          </>
        )}
        <SettingRow title={t("settings.floatOnStart")} description={t("settings.floatOnStartHint")}>
          {toggle("floatOnStart", t("settings.floatOnStart"))}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Claude">
        <SettingRow title={t("settings.claudeBin")} description={t("settings.claudeBinHint")}>
          {text("claudeBin", t("settings.claudeBin"))}
        </SettingRow>
        <SettingRow title={t("settings.launchMode")} description={`${t("settings.claudeLaunchHint")}${restart}`}>
          <Segmented value={s.claudeLaunchMode} onChange={(v) => void set("claudeLaunchMode", v)} options={claudeLaunch(t)} />
        </SettingRow>
        <SettingRow title={t("settings.permission")} description={t("settings.permissionHint")}>
          <Select ariaLabel={t("settings.permission")} value={s.permissionMode} onChange={(v) => void set("permissionMode", v)} options={PERMISSION} />
        </SettingRow>
        <SettingRow title={t("settings.defaultModel")} description={t("settings.defaultModelHint")}>
          {text("defaultModel", t("settings.defaultModel"), { placeholder: t("settings.cliDefault") })}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Codex">
        <SettingRow title={t("settings.codexBin")} description={t("settings.codexBinHint")}>
          {text("codexBin", t("settings.codexBin"))}
        </SettingRow>
        <SettingRow title={t("settings.launchMode")} description={`${t("settings.codexLaunchHint")}${restart}`}>
          <Segmented value={s.codexLaunchMode} onChange={(v) => void set("codexLaunchMode", v)} options={codexLaunch(t)} />
        </SettingRow>
        <SettingRow title={t("settings.model")} description={t("settings.codexModelHint")}>
          {text("codexModel", t("settings.model"), { placeholder: t("settings.fromConfigToml") })}
        </SettingRow>
        <SettingRow title={t("settings.sandbox")} description={t("settings.sandboxHint")}>
          <Select ariaLabel={t("settings.sandbox")} value={s.codexSandbox} onChange={(v) => void set("codexSandbox", v)} options={SANDBOX} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("settings.clerk")}>
        <SettingRow title={t("settings.clerkBackend")} description={t("settings.clerkBackendHint")}>
          <Segmented value={s.clerkBackend} onChange={(v) => void set("clerkBackend", v)} options={clerks(t)} />
        </SettingRow>
        <SettingRow title={t("settings.deepseekKey")} description={t("settings.deepseekKeyHint")}>
          {text("deepseekApiKey", t("settings.deepseekKey"), { kind: "password" })}
        </SettingRow>
        <SettingRow title={t("settings.deepseekModel")}>{text("deepseekModel", t("settings.deepseekModel"))}</SettingRow>
        <SettingRow title={t("settings.autoTriage")} description={t("settings.autoTriageHint")}>
          {toggle("autoTriage", t("settings.autoTriage"))}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("settings.daemon")}>
        <SettingRow title={t("settings.audit")} description={t("settings.auditHint")}>
          {toggle("auditEnabled", t("settings.audit"))}
        </SettingRow>
        <SettingRow title={t("settings.lowPriority")} description={`${t("settings.lowPriorityHint")}${restart}`}>
          {toggle("workerLowPriority", t("settings.lowPriority"))}
        </SettingRow>
        <SettingRow title={t("settings.launchAtLogin")} description={t("settings.launchAtLoginHint")}>
          {toggle("launchAtLogin", t("settings.launchAtLogin"))}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("settings.other")}>
        <SettingRow title={t("settings.worktreeRoot")} description={t("settings.worktreeRootHint")} wide>
          {text("worktreeRoot", t("settings.worktreeRoot"))}
        </SettingRow>
        <SettingRow title={t("settings.captureShortcut")} description={`${t("settings.captureShortcutHint")}${restart}`}>
          {text("quickCaptureShortcut", t("settings.captureShortcut"))}
        </SettingRow>
        <SettingRow title={t("settings.externalPg")} description={`${t("settings.externalPgHint")}${restart}`} wide>
          {text("pgConnectionString", t("settings.externalPg"), { placeholder: "postgres://…" })}
        </SettingRow>
        <SettingRow title={t("settings.mcpPort")} description={restart}>
          {text("mcpPort", t("settings.mcpPort"), { kind: "number" })}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("common.claudeDesktop")}>
        <SettingRow title={t("settings.axTitle")} description={axDescription(t, ax)}>
          {ax && ax.available && !ax.trusted && <Button onClick={() => api.ax.status(true).then(setAx)}>{t("settings.requestAx")}</Button>}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("settings.integration")}>
        <SettingRow title={t("settings.database")} description={s.pg.embedded ? t("settings.dbEmbedded") : t("settings.dbExternal")} stacked>
          <Code>{s.pg.connectionString}</Code>
        </SettingRow>
        <SettingRow title="MCP" description={t("settings.mcpHint")} stacked>
          <div className="flex flex-col gap-2 w-full">
            <Code>claude mcp add --scope user --transport http chancery http://127.0.0.1:{s.mcpPort}/mcp</Code>
            <Code>codex mcp add chancery --url http://127.0.0.1:{s.mcpPort}/mcp</Code>
          </div>
        </SettingRow>
      </SettingGroup>
    </div>
  );
}

function axDescription(t: T, ax: AxStatus | null): ReactNode {
  if (!ax) return t("settings.axChecking");
  if (!ax.available) return <span className="text-error">{t("settings.axUnavailable", { error: ax.error ?? "" })}</span>;
  if (!ax.trusted) return <span className="text-warn">{t("settings.axNotTrusted", { self: ax.askedOf ?? "Chancery" })}</span>;
  if (ax.probe && !ax.probe.ok) return <span className="text-warn">{t("settings.axProbeFailed", { error: ax.probe.error ?? "" })}</span>;
  return `${t("settings.axOk", { n: ax.probe?.projects?.length ?? 0 })}${ax.probe?.composer?.usage ? ` · ${t("settings.axUsage", { usage: ax.probe.composer.usage })}` : ""}`;
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
