import React, { useEffect, useRef } from "react";
import { Animated, StyleProp, ViewStyle } from "react-native";

/**
 * Entrance animation: fades + slides content up once on mount. Pure JS
 * Animated (useNativeDriver) - no native module, works on the current
 * Android build. Stack with `delay` for a stagger.
 */
export function FadeIn({
  delay = 0,
  duration = 380,
  style,
  children,
}: {
  delay?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, {
      toValue: 1,
      duration,
      delay,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      useNativeDriver: true,
    }).start();
  }, [v, delay, duration]);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: v,
          transform: [
            { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
