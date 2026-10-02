import React from "react";
import { View, Image } from "react-native";

/**
 * Charon mark - the hooded ferryman emblem, same art as the launcher icon.
 * Shipped as a bundled image so the header mark is pixel-identical to the
 * app icon instead of a redrawn SVG approximation.
 */
const MARK = require("./charon-mark.png");

export function Logo({ size = 56 }: { size?: number }) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Image source={MARK} style={{ width: size, height: size, resizeMode: "contain" }} />
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
