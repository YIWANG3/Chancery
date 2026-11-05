// Bundles the main process and the preload with esbuild into out/. `--watch`
// rebuilds on change; Electron itself is restarted by hand (the daemon holds
// the embedded Postgres, so an automatic restart loop would fight over it).
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  // Native-ish packages stay external and are resolved from node_modules at runtime.
  external: ["electron", "pg", "pg-native", "embedded-postgres"],
};
const targets = [
  { ...shared, entryPoints: ["main/index.ts"], outfile: "out/main.cjs" },
  { ...shared, entryPoints: ["preload/index.ts"], outfile: "out/preload.cjs" },
  { ...shared, entryPoints: ["cli/index.ts"], outfile: "out/cli.cjs", banner: { js: "#!/usr/bin/env node" } },
];

if (watch) {
  for (const t of targets) (await context(t)).watch();
} else {
  await Promise.all(targets.map((t) => build(t)));
}
