import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { initLang } from "./i18n";

// A floating window standing on Liquid Glass is told so in its address (main/index.ts). Marked before anything is
// painted, so the page never shows a solid background over the glass.
if (location.hash.includes("glass=1")) document.documentElement.classList.add("glass");
// Opened in a plain browser during development there is no preload bridge; stand one in with fixtures.
if (import.meta.env.DEV && !window.chancery) (await import("./mock")).installMock();
// The language is known before the first paint, so nothing flashes in the other one.
await initLang();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
