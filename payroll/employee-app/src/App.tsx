import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Dimensions } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { WalletProvider, useWallet } from "./wallet/WalletProvider";
import { BridgeProvider } from "./bridge/BridgeContext";
import { SdkWebView, type SdkBridgeHandle } from "./bridge/SdkWebView";
import { ConnectScreen } from "./screens/ConnectScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { WithdrawScreen } from "./screens/WithdrawScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { theme } from "./ui/theme";
import type { BridgeMethod } from "./lib/rpc";

type Nav = "home" | "withdraw" | "settings";

function Root() {
  const { connected } = useWallet();
  const insets = useSafeAreaInsets();
  const [nav, setNav] = useState<Nav>("home");

  let screen: React.ReactNode;
  if (nav === "settings") {
    screen = <SettingsScreen onBack={() => setNav("home")} />;
  } else if (nav === "withdraw") {
    screen = <WithdrawScreen onDone={() => setNav("home")} onBack={() => setNav("home")} />;
  } else if (connected) {
    screen = (
      <HomeScreen
        onClaim={() => setNav("withdraw")}
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
      {screen}
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
