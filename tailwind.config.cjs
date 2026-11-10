/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./renderer/index.html", "./renderer/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Geist Variable"', '"PingFang SC"', '"Microsoft YaHei UI"', "system-ui", "sans-serif"],
        mono: ['"SF Mono"', "Menlo", "monospace"],
      },
      colors: {
        app: "rgb(var(--app-bg) / <alpha-value>)",
        sidebar: "rgb(var(--sidebar-bg) / <alpha-value>)",
        panel: "rgb(var(--panel-bg) / <alpha-value>)",
        // Fills carry their own alpha, so they take no opacity modifier (no bg-panel2/50).
        panel2: "rgb(var(--fill) / var(--fill-1))",
        hover: "rgb(var(--fill) / var(--fill-2))",
        raised: "rgb(var(--raised-bg) / var(--raised-alpha))",
        overlay: "rgb(0 0 0 / var(--overlay-alpha))",
        line: "rgb(var(--line-color) / <alpha-value>)",
        muted: "rgb(var(--muted-text) / <alpha-value>)",
        text: "rgb(var(--text-color) / <alpha-value>)",
        inverse: "rgb(var(--inverse-bg) / <alpha-value>)",
        "inverse-text": "rgb(var(--inverse-text) / <alpha-value>)",
        accent: "rgb(var(--accent-color) / <alpha-value>)",
        success: "rgb(var(--success-color) / <alpha-value>)",
        warn: "rgb(var(--warn-color) / <alpha-value>)",
        error: "rgb(var(--error-color) / <alpha-value>)",
      },
      borderRadius: { sm: "4px", DEFAULT: "6px", md: "8px", lg: "12px", xl: "16px" },
      // One fixed scale; no arbitrary z-* in components.
      zIndex: { drawer: "30", modal: "40" },
    },
  },
  // `glass:` applies in a window standing on Liquid Glass (the `glass` class on <html>, see renderer/styles.css).
  plugins: [({ addVariant }) => addVariant("glass", ":root.glass &")],
};
