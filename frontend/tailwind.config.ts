import type { Config } from "tailwindcss";

export const klawpenBranding = {
  colors: {
    ink: "#0b0c10",
    coal: "#111217",
    graphite: "#222223",
    panel: "#111827",
    mist: "#f6f8fb",
    paper: "#ffffff",
    steel: "#254260",
    ocean: "#31577d",
    cyan: "#12b5cb",
    ice: "#8bd6e6",
    slate: "#64748b",
  },
  spacing: {
    shell: "clamp(1rem, 3vw, 3rem)",
    section: "clamp(4rem, 8vw, 8rem)",
    compact: "clamp(0.75rem, 1.4vw, 1.25rem)",
  },
  borderRadius: {
    soft: "1rem",
    panel: "1.5rem",
    hero: "2rem",
    pill: "999px",
  },
  fontFamily: {
    sans: ["Suisse", "Segoe UI", "sans-serif"],
    display: ["XSpace", "Suisse", "Segoe UI", "sans-serif"],
    mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
  },
};

const config = {
  theme: {
    extend: {
      colors: {
        klawpen: klawpenBranding.colors,
      },
      spacing: {
        "klawpen-shell": klawpenBranding.spacing.shell,
        "klawpen-section": klawpenBranding.spacing.section,
        "klawpen-compact": klawpenBranding.spacing.compact,
      },
      borderRadius: {
        "klawpen-soft": klawpenBranding.borderRadius.soft,
        "klawpen-panel": klawpenBranding.borderRadius.panel,
        "klawpen-hero": klawpenBranding.borderRadius.hero,
        "klawpen-pill": klawpenBranding.borderRadius.pill,
      },
      fontFamily: {
        "klawpen-sans": klawpenBranding.fontFamily.sans,
        "klawpen-display": klawpenBranding.fontFamily.display,
        "klawpen-mono": klawpenBranding.fontFamily.mono,
      },
    },
  },
} satisfies Config;

export default config;

