/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./renderer/index.html", "./renderer/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', '"PingFang SC"', '"Microsoft YaHei UI"', "system-ui", "sans-serif"],
        mono: ['"SF Mono"', "Menlo", "monospace"],
      },
      colors: {
        app: "rgb(var(--app-bg) / <alpha-value>)",
        sidebar: "rgb(var(--sidebar-bg) / <alpha-value>)",
        panel: "rgb(var(--panel-bg) / <alpha-value>)",
        panel2: "rgb(var(--panel-bg-2) / <alpha-value>)",
        hover: "rgb(var(--hover-bg) / <alpha-value>)",
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
  plugins: [],
};
