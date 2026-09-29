// Design tokens - aligned to the web app's crisp minimalist fintech light
// system (payroll/src/index.css). Pure white canvas, zinc hairlines, obsidian
// type, black primary actions, emerald = verified, amber = warning, rose =
// danger. Same tokens, same product, on mobile.

export const theme = {
  bg: "#FFFFFF",
  bgElevated: "#FFFFFF",
  surface: "#FFFFFF",
  surfaceMuted: "#F4F4F5", // zinc-100
  hairline: "#E4E4E7", // zinc-200
  hairlineStrong: "#D4D4D8", // zinc-300

  text: "#09090B", // zinc-950
  textSoft: "#52525B", // zinc-600
  textMuted: "#71717A", // zinc-500

  accent: "#09090B", // primary action: solid obsidian
  accentSoft: "rgba(9,9,11,0.05)",
  accentLine: "rgba(9,9,11,0.16)",

  ok: "#059669", // emerald-600 (verified)
  okSoft: "rgba(16,185,129,0.12)",
  amber: "#B45309", // amber-700 (warning, readable on light)
  amberSoft: "rgba(245,158,11,0.12)",
  danger: "#E11D48", // rose-600 (critical)
  dangerText: "#BE123C", // rose-700
  dangerSoft: "rgba(244,63,94,0.10)",

  radius: 12, // cards: rounded-xl
  radiusSm: 8, // inputs/buttons: rounded-lg
  space: (n: number) => n * 4,
} as const;

import { StyleSheet, type TextStyle } from "react-native";

// Typed as TextStyle so `fontWeight` stays a literal union member instead of
// widening to `string` (RN 0.86's TextStyle.fontWeight rejects plain strings).
export const typography: Record<string, TextStyle> = {
  hero: { fontSize: 34, lineHeight: 40, fontWeight: "700", letterSpacing: -0.9 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.5 },
  h2: { fontSize: 17, lineHeight: 23, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 22, fontWeight: "400" },
  small: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  mono: { fontSize: 13, lineHeight: 18 },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: "600", letterSpacing: 1.2, textTransform: "uppercase" },
};

export const s = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  scroll: {
    flexGrow: 1,
    padding: 20,
    paddingTop: 16,
  },
  card: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.hairline,
    padding: 18,
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: theme.surfaceMuted,
  },
});
