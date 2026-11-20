import type { Config } from "tailwindcss";

// Maps the CSS variables in src/styles/tokens.css to utilities. Names follow
// the Slash DESIGN.md export (colours, Surfaces, Type Scale); `ink`, `line`
// and `status` are this app's semantic aliases. Tailwind's default 4px
// spacing scale already covers the export's spacing steps (4–48px).
const rgb = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        obsidian: rgb("obsidian"),
        onyx: rgb("onyx"),
        carbon: rgb("carbon"),
        graphite: rgb("graphite"),
        slate: rgb("slate"),
        smoke: rgb("smoke"),
        ash: rgb("ash"),
        steel: rgb("steel"),
        fog: rgb("fog"),
        mist: rgb("mist"),
        silver: rgb("silver"),
        bone: rgb("bone"),
        "paper-white": rgb("paper-white"),
        black: rgb("black"),
        copper: rgb("copper"),
        gilded: rgb("gilded"),

        // DESIGN.md "Surfaces"
        surface: {
          void: rgb("obsidian"), // level 0: page canvas
          card: rgb("onyx"), // level 1: cards, contained blocks
          panel: rgb("carbon"), // level 2: elevated panels, dropdowns, inputs
          floating: rgb("graphite"), // level 3: floating UI, icon wells
        },
        line: {
          subtle: rgb("graphite"), // hairline: card and table edges
          DEFAULT: rgb("slate"), // secondary borders
          control: rgb("steel"), // tags, ghost outlines, inputs (>= 3:1)
          strong: rgb("silver"), // hover on controls
        },
        ink: {
          primary: rgb("paper-white"), // headings, emphasis
          body: rgb("bone"), // default text
          secondary: rgb("mist"), // subdued body copy
          muted: rgb("fog"), // nav, descriptions, helper text
          subtle: rgb("steel"), // placeholders; on Obsidian/Onyx only
          disabled: rgb("ash"),
        },
        accent: rgb("copper"),
        "chart-mark": rgb("chart-mark"), // single-series bars only
        status: {
          success: rgb("success"),
          warning: rgb("warning"),
          danger: rgb("danger"),
        },
      },
      fontFamily: {
        display: ["var(--font-display)"],
        sans: ["var(--font-ui)"],
      },
      // DESIGN.md "Type Scale". `meta`, `ui` and `title` are sizes the export
      // lists for Inter (12, 14) and Ivy Presto (28) without naming them.
      fontSize: {
        meta: ["0.75rem", { lineHeight: "1rem" }], // 12
        eyebrow: ["0.8125rem", { lineHeight: "1", letterSpacing: "-0.02em" }], // 13
        ui: ["0.875rem", { lineHeight: "1.25rem" }], // 14 — buttons, nav, labels, table cells
        "body-xs": ["1rem", { lineHeight: "1.5", letterSpacing: "0px" }], // 16 — default body
        "body-sm": ["1.125rem", { lineHeight: "1.38", letterSpacing: "-0.36px" }], // 18
        body: ["1.25rem", { lineHeight: "1.38", letterSpacing: "-0.8px" }], // 20 — largest Inter body size
        subheading: ["1.5rem", { lineHeight: "1", letterSpacing: "-0.31px" }], // 24
        title: ["1.75rem", { lineHeight: "1.38", letterSpacing: "0.01em" }], // 28 — smallest serif size
        "heading-sm": ["var(--text-heading-sm)", { lineHeight: "1.38", letterSpacing: "0.01em" }], // 44
        heading: ["var(--text-heading)", { lineHeight: "1.13", letterSpacing: "0.01em" }], // 52
        "heading-lg": ["var(--text-heading-lg)", { lineHeight: "1.13", letterSpacing: "0.01em" }], // 64
        display: ["var(--text-display)", { lineHeight: "1", letterSpacing: "0.01em" }], // 88
      },
      borderRadius: {
        card: "var(--radius-cards)",
        pill: "var(--radius-full)",
        indicator: "var(--radius-nav)",
      },
      maxWidth: {
        content: "var(--page-max-width)",
      },
      width: {
        sidebar: "var(--sidebar-width)",
      },
      padding: {
        card: "var(--card-padding)",
      },
      backgroundImage: {
        gilded: "var(--gradient-gilded)",
      },
      boxShadow: {
        subtle: "var(--shadow-subtle)",
      },
    },
  },
  plugins: [],
} satisfies Config;
