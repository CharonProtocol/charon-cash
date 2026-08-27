import React from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { theme, typography, s } from "./theme";

export function Card({ children, style }: { children: React.ReactNode; style?: any }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function MonoText({ children, style }: { children: React.ReactNode; style?: any }) {
  return (
    <Text
      style={[typography.mono, { color: theme.textSoft, fontFamily: "monospace" }, style]}
      numberOfLines={1}
    >
      {children}
    </Text>
  );
}

type BtnProps = {
  title: string;
  onPress: () => void;
  variant?: "primary" | "ghost" | "danger";
  loading?: boolean;
  disabled?: boolean;
  subtitle?: string;
};
export function Button({
  title,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  subtitle,
}: BtnProps) {
  const bg =
    variant === "primary"
      ? theme.accent
      : variant === "danger"
        ? theme.dangerSoft
        : theme.surfaceMuted;
  const fg = variant === "primary" ? "#0C0E12" : variant === "danger" ? theme.danger : theme.text;
  const border = variant === "ghost" ? theme.hairline : "transparent";
  const active = !disabled && !loading;
  return (
    <Pressable
      onPress={active ? onPress : undefined}
      disabled={!active}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderColor: border,
          opacity: pressed && active ? 0.85 : disabled ? 0.4 : 1,
          paddingVertical: 15,
          borderRadius: theme.radiusSm,
          alignItems: "center",
          borderWidth: 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={{ alignItems: "center" }}>
          <Text style={[typography.h2, { color: fg }]}>{title}</Text>
          {subtitle ? (
            <Text style={[typography.small, { color: fg, opacity: 0.7, marginTop: 2 }]}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = "default",
  autoCapitalize = "none",
  mono = false,
  right,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "numeric" | "number-pad" | "decimal-pad";
  autoCapitalize?: "none" | "sentences";
  mono?: boolean;
  right?: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={[typography.micro, { color: theme.textMuted, marginBottom: 8 }]}>{label}</Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: theme.bgElevated,
          borderWidth: 1,
          borderColor: theme.hairline,
          borderRadius: theme.radiusSm,
          paddingHorizontal: 14,
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.textMuted}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
          style={[
            typography.body,
            {
              color: theme.text,
              flex: 1,
              paddingVertical: 13,
              fontFamily: mono ? "monospace" : undefined,
            },
          ]}
        />
        {right}
      </View>
    </View>
  );
}

export function Pill({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "accent" | "amber" | "danger";
}) {
  const map = {
    muted: { bg: theme.surfaceMuted, fg: theme.textSoft },
    accent: { bg: theme.accentSoft, fg: theme.accent },
    amber: { bg: theme.amberSoft, fg: theme.amber },
    danger: { bg: theme.dangerSoft, fg: theme.danger },
  }[tone];
  return (
    <View style={[s.pill, { backgroundColor: map.bg }]}>
      <Text style={[typography.micro, { color: map.fg, letterSpacing: 0.8 }]}>{children}</Text>
    </View>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <View
      style={{
        backgroundColor: theme.dangerSoft,
        borderWidth: 1,
        borderColor: theme.danger,
        borderRadius: theme.radiusSm,
        padding: 13,
        marginBottom: 14,
      }}
    >
      <Text style={[typography.small, { color: theme.danger, flexShrink: 1 }]}>{message}</Text>
      {onDismiss ? (
        <Pressable onPress={onDismiss} hitSlop={8} style={{ marginTop: 6 }}>
          <Text style={[typography.micro, { color: theme.danger }]}>DISMISS</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
