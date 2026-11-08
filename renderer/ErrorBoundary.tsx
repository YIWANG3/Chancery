import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "./i18n";

/** A render error shows its message in place instead of unmounting the whole window to a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("render failed", error, info.componentStack);
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="h-full flex flex-col gap-3 px-8 py-10 text-[14px]">
        <div className="font-medium text-error">{t("error.renderFailed")}</div>
        <pre className="whitespace-pre-wrap font-mono text-[12.5px] text-muted text-pretty">{error.stack ?? error.message}</pre>
        <div>
          <button className="h-9 px-4 rounded-md bg-panel2 hover:bg-hover" onClick={() => this.setState({ error: null })}>
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  }
}
