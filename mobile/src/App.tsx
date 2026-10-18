import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Dimensions, Animated } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { WalletProvider, useWallet } from "./wallet/WalletProvider";
import { BridgeProvider } from "./bridge/BridgeContext";
import { SdkWebView, type SdkBridgeHandle } from "./bridge/SdkWebView";
import { ConnectScreen } from "./screens/ConnectScreen";
import { HomeScreen, type Action } from "./screens/HomeScreen";
import { ActionScreen } from "./screens/ActionScreen";
import { theme } from "./ui/theme";
import type { BridgeMethod } from "./lib/rpc";
import { CharonProver } from "../modules/charon-prover/src";

type Nav = "home" | Action;

/** Fade + slide wrapper re-mounted on every nav change, so screens glide. */
function ScreenTransition({ navKey, children }: { navKey: string; children: React.ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    v.setValue(0);
    Animated.timing(v, {
      toValue: 1,
      duration: 240,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      useNativeDriver: true,
    }).start();
  }, [navKey, v]);
  return (
    <Animated.View
      key={navKey}
      style={{ flex: 1, opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}
    >
      {children}
    </Animated.View>
  );
}

function Root() {
  const { connected } = useWallet();
  const insets = useSafeAreaInsets();
  const [nav, setNav] = useState<Nav>("home");
  const [asset, setAsset] = useState("SOL");

  let screen: React.ReactNode;
  if (!connected) {
    screen = <ConnectScreen />;
  } else if (nav === "home") {
    screen = <HomeScreen asset={asset} onAsset={setAsset} onAction={setNav} />;
  } else {
    screen = <ActionScreen action={nav} initialAsset={asset} onDone={() => setNav("home")} />;
  }

  // The root is pinned to the window height explicitly instead of relying on
  // flex:1 up the provider chain -- on some devices flex:1 was not expanding,
  // leaving every screen bunched in the top half. An explicit height guarantees
  // ALL pages fill the screen. win tracks rotation/keyboard.
  const [win, setWin] = useState(Dimensions.get("window"));
  useEffect(() => {
    const sub = Dimensions.addEventListener("change", ({ window }) => setWin(window));
    return () => sub.remove();
  }, []);

  return (
    <View
      style={{
        height: win.height,
        width: win.width,
        backgroundColor: theme.bg,
        paddingTop: Math.max(insets.top, 24),
        paddingBottom: Math.max(insets.bottom, 16),
      }}
    >
      <ScreenTransition navKey={(connected ? "in:" : "out:") + nav}>{screen}</ScreenTransition>
    </View>
  );
}

export default function App() {
  const bridgeRef = useRef<SdkBridgeHandle>(null);

  // Parse the circuit in the background so the first proof doesn't wait on it.
  useEffect(() => {
    CharonProver?.warmup().catch(() => {});
  }, []);

  const call = useCallback(
    <T,>(method: BridgeMethod, args: unknown[] = []): Promise<T> => {
      if (!bridgeRef.current) throw new Error("SDK bridge is not ready yet");
      return bridgeRef.current.call<T>(method, args);
    },
    [],
  );

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <WalletProvider>
        <BridgeProvider call={call}>
          <Root />
          {/* hidden: hosts the SDK (WASM + Web Crypto) and talks back over RPC */}
          <SdkWebView ref={bridgeRef} />
        </BridgeProvider>
      </WalletProvider>
    </SafeAreaProvider>
  );
}
