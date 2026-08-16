// Design tokens  -  aligned to the web app's dark palette (frontend/src/index.css
// `.dark`). Same deep ink ground, but the accent is the web's indigo-violet
// (#8b85f0) so the mobile app reads as the same product.

export const theme = {
  bg: "#0C0E12",
  bgElevated: "#141820",
  surface: "#141820",
  surfaceMuted: "#1A1F2A",
  hairline: "#2A3140",

  text: "#E8EAEF",
  textSoft: "#B4BAC8",
  textMuted: "#8B93A7",

  accent: "#8B85F0", // indigo-violet (web --primary)
  accentSoft: "rgba(139,133,240,0.16)",
  accentLine: "rgba(139,133,240,0.40)",
  amber: "#E8A24A",
  amberSoft: "rgba(232,162,74,0.14)",
  danger: "#F87171",
  dangerSoft: "rgba(248,113,113,0.12)",

  radius: 16,
  radiusSm: 12,
  space: (n: number) => n * 4,
} as const;

import { StyleSheet, type TextStyle } from "react-native";

// Typed as TextStyle so `fontWeight` stays a literal union member instead of
// widening to `string` (RN 0.86's TextStyle.fontWeight rejects plain strings).
export const typography: Record<string, TextStyle> = {
  hero: { fontSize: 34, lineHeight: 40, fontWeight: "800", letterSpacing: -0.8 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.4 },
  h2: { fontSize: 17, lineHeight: 23, fontWeight: "700" },
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
