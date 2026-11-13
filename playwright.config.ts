import { defineConfig } from "@playwright/test";

// Electron e2e: one app instance per worker, serial specs. `npm run test:e2e` builds first.
// Each worker gets its own ports (tests/e2e/fixtures.ts), so `--workers 2` works when a second spec file is added;
// today flow.spec.ts is the only one on the fixtures that runs without CHANCERY_E2E_REAL (firstrun.spec.ts launches
// a copy of its own, with neither app's sessions and no database), so one worker is the whole run.
const CI = Boolean(process.env.CI);
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // The specs are a serial chain, so one retry re-runs the whole file in a fresh app; a pass on retry is reported
  // as flaky, not hidden.
  retries: CI ? 1 : 0,
  // On CI the html report and the github annotations go with the failure screenshots the fixtures attach.
  reporter: CI ? [["list"], ["github"], ["html", { open: "never" }]] : [["list"]],
  outputDir: "test-results",
});
