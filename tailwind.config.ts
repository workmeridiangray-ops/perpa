import type { Config } from "tailwindcss";

// Palette from the scope brief (section 19): warm white, grey surfaces, charcoal, one deep blue.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      white: "#FFFFFF",
      canvas: "#F7F8FA",
      ink: "#17212F",
      muted: "#526174",
      line: "#D9DFE7",
      brand: "#244B78",
      danger: "#A32020",
    },
    fontFamily: { sans: ["Inter", "system-ui", "sans-serif"] },
    borderRadius: { none: "0", md: "8px", lg: "12px" },
    extend: {},
  },
  plugins: [],
};

export default config;
