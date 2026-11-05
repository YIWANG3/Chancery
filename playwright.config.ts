import { defineConfig } from "@playwright/test";

// Electron e2e: one app instance per worker, serial specs. `npm run test:e2e` builds first.
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  outputDir: "test-results",
});
