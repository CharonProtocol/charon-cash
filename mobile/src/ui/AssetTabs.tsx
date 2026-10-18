import React from "react";
import { View, Text, Pressable } from "react-native";
import type { Asset } from "../lib/assets";
import { theme, typography } from "./theme";

/** Segmented picker between the app's assets (SOL, USDC, ...). */
export function AssetTabs({
  assets,
  value,
  onChange,
}: {
  assets: Asset[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: theme.surfaceMuted,
        borderRadius: 999,
        padding: 3,
        alignSelf: "flex-start",
      }}
    >
      {assets.map((a) => {
        const on = a.key === value;
        return (
          <Pressable
            key={a.key}
            onPress={() => onChange(a.key)}
            hitSlop={4}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 7,
              borderRadius: 999,
              backgroundColor: on ? theme.accent : "transparent",
            }}
          >
            <Text style={[typography.small, { color: on ? "#0C0E12" : theme.textSoft, fontWeight: "700" }]}>
              {a.symbol}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
