import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { initLang } from "./i18n";
import { markLook } from "./look";

// A floating window is told in its address what it stands on (main/index.ts).
markLook();
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
