import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["out/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  // core/ never imports Electron: it must run headless on the always-on machine too.
  { files: ["core/**/*.ts"], rules: { "no-restricted-imports": ["error", { paths: ["electron"] }] } },
];
