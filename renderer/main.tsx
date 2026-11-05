import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

// Opened in a plain browser during development there is no preload bridge; stand one in with fixtures.
if (import.meta.env.DEV && !window.chancery) (await import("./mock")).installMock();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
