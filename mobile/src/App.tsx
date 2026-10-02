import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Dimensions, Animated } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { WalletProvider, useWallet } from "./wallet/WalletProvider";
import { BridgeProvider } from "./bridge/BridgeContext";
import { SdkWebView, type SdkBridgeHandle } from "./bridge/SdkWebView";
import { ConnectScreen } from "./screens/ConnectScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { TransferScreen } from "./screens/TransferScreen";
import { SendNoteScreen } from "./screens/SendNoteScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { theme } from "./ui/theme";
import type { BridgeMethod } from "./lib/rpc";

type Nav = "home" | "transfer" | "sendnote" | "settings";

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

  let screen: React.ReactNode;
  if (nav === "settings") {
    screen = <SettingsScreen onBack={() => setNav("home")} />;
  } else if (nav === "transfer") {
    screen = <TransferScreen onDone={() => setNav("home")} />;
  } else if (nav === "sendnote") {
    screen = <SendNoteScreen onDone={() => setNav("home")} />;
  } else if (connected) {
    screen = (
      <HomeScreen
        onSend={() => setNav("transfer")}
        onSendNote={() => setNav("sendnote")}
        onOpenSettings={() => setNav("settings")}
      />
    );
  } else {
    screen = <ConnectScreen onOpenSettings={() => setNav("settings")} />;
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
