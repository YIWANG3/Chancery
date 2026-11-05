import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Renderer only. The main process and preload are bundled by scripts/build-main.mjs.
export default defineConfig({
  root: resolve(__dirname, "renderer"),
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@core": resolve(__dirname, "core") } },
  server: { port: 5181, strictPort: true, host: "127.0.0.1" },
  build: { outDir: resolve(__dirname, "out/renderer"), emptyOutDir: true },
  test: { include: ["core/**/*.test.ts"], environment: "node", root: __dirname },
});
