import React from "react";
import { View } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { theme } from "./theme";

/**
 * Privacy Cash mark  -  a Merkle tree of commitments (root -> 2 mid nodes -> 4
 * leaves), matching the web brand mark in frontend/src/components/NavBar.tsx
 * (BrandMark). Edges + root + mid nodes use the accent (web --primary
 * #8b85f0); the four leaf nodes are dimmed (web --muted-foreground #8b93a7).
 * Monochrome, no gradient  -  identical to the web mark.
 */
export function Logo({ size = 56 }: { size?: number }) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        {/* edges: root trunk, root -> mids, mids -> leaves */}
        <Path
          d="M12 3 V9 M12 9 L6 14 M12 9 L18 14 M6 14 L3 20 M6 14 L9 20 M18 14 L15 20 M18 14 L21 20"
          stroke={theme.accent}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* root + 2 mid nodes (primary) */}
        <Circle cx={12} cy={3} r={1.8} fill={theme.accent} />
        <Circle cx={6} cy={14} r={1.5} fill={theme.accent} />
        <Circle cx={18} cy={14} r={1.5} fill={theme.accent} />
        {/* 4 leaf nodes (muted) */}
        <Circle cx={3} cy={20} r={1.3} fill={theme.textMuted} />
        <Circle cx={9} cy={20} r={1.3} fill={theme.textMuted} />
        <Circle cx={15} cy={20} r={1.3} fill={theme.textMuted} />
        <Circle cx={21} cy={20} r={1.3} fill={theme.textMuted} />
      </Svg>
    </View>
  );
}

/** Lockup: mark + wordmark. */
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Logo size={size} />
    </View>
  );
}
