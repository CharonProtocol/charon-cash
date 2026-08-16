import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Share,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Buffer } from "buffer";
import { useBridge } from "../bridge/BridgeContext";
import { useApp } from "../store";
import { Button, Card, MonoText, Pill } from "../ui/components";
import { theme, typography } from "../ui/theme";
import type { NoteLike } from "../lib/rpc";

// A note as returned by the bridge's getNotes(): the full SDK Note, which
// includes the `blinding` spending secret even though NoteLike omits it.
type FullNote = NoteLike & { blinding?: string };

function encodeNote(note: FullNote): string {
  return Buffer.from(JSON.stringify([note]), "utf-8").toString("base64");
}

// Accept either a base64 payment code or raw JSON (one note or an array).
function decodeNotes(code: string): FullNote[] {
  const trimmed = code.trim();
  try {
    const p = JSON.parse(trimmed);
    if (Array.isArray(p)) return p;
    if (p && typeof p === "object") return [p];
  } catch {
    /* not raw JSON  -  try base64 below */
  }
  const json = Buffer.from(trimmed.replace(/\s/g, ""), "base64").toString("utf-8");
  const p = JSON.parse(json);
  if (Array.isArray(p)) return p;
  if (p && typeof p === "object") return [p];
  throw new Error("Could not parse a payment note from the input");
}

function fmtSol(lamports: number): string {
  return (lamports / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function SendNoteScreen({ onDone }: { onDone: () => void }) {
  const { call } = useBridge();
  const notes = useApp((s) => s.notes);
  const setNotes = useApp((s) => s.setNotes);
  const setToast = useApp((s) => s.setToast);

  const [mode, setMode] = useState<"generate" | "redeem">("generate");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [redeemInput, setRedeemInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unspent = useMemo(() => notes.filter((n) => !n.spent), [notes]);
  const selected = unspent.find((n) => n.id === selectedId) ?? null;
  const paymentCode = useMemo(
    () => (selected ? encodeNote(selected as FullNote) : ""),
    [selected],
  );

  async function shareCode() {
    if (!paymentCode) return;
    try {
      const r = await Share.share({ message: paymentCode });
      if (r.action === Share.sharedAction) {
        setToast("Payment code shared");
      }
    } catch {
      setError("Share failed");
    }
  }

  async function redeem() {
    setError(null);
    setBusy(true);
    try {
      const parsed = decodeNotes(redeemInput);
      const res = await call<{ count: number }>("importNotes", [
        JSON.stringify(parsed),
      ]);
      setRedeemInput("");
      try {
        const n = await call<NoteLike[]>("getNotes");
        setNotes(n);
      } catch {}
      setToast(
        `Redeemed ${res.count} note${res.count === 1 ? "" : "s"}  -  withdraw it anytime`,
      );
      onDone();
    } catch (e: any) {
      setError(e?.message ?? "Redeem failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, padding: 20, paddingTop: 16 }}>
        <Pressable onPress={onDone} hitSlop={8} style={{ alignSelf: "flex-start", marginBottom: 16 }}>
          <Text style={[typography.small, { color: theme.textMuted }]}>{"< Back"}</Text>
        </Pressable>

        <Text style={[typography.title, { color: theme.text }]}>Send / redeem a note</Text>
        <Text style={[typography.body, { color: theme.textSoft, marginTop: 8 }]}>
          Generate a private payment note from one of your unspent notes and share
          the code. The recipient redeems it here and withdraws whenever they like
           -  the handoff leaves no on-chain link back to you.
        </Text>

        {/* Generate / Redeem toggle */}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 20, marginBottom: 16 }}>
          {(["generate", "redeem"] as const).map((m) => (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              style={{
                flex: 1,
                paddingVertical: 11,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: mode === m ? theme.accentLine : theme.hairline,
                backgroundColor: mode === m ? theme.accentSoft : theme.bgElevated,
                alignItems: "center",
              }}
            >
              <Text
                style={[
                  typography.small,
                  {
                    color: mode === m ? theme.accent : theme.textSoft,
                    fontWeight: "700",
                  },
                ]}
              >
                {m === "generate" ? "Generate" : "Redeem"}
              </Text>
            </Pressable>
          ))}
        </View>

        {error ? (
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
            <Text style={[typography.small, { color: theme.danger }]}>{error}</Text>
            <Pressable onPress={() => setError(null)} hitSlop={8} style={{ marginTop: 6 }}>
              <Text style={[typography.micro, { color: theme.danger }]}>DISMISS</Text>
            </Pressable>
          </View>
        ) : null}

        {mode === "generate" ? (
          <>
            <View
              style={{
                backgroundColor: theme.amberSoft,
                borderWidth: 1,
                borderColor: theme.amber,
                borderRadius: theme.radiusSm,
                padding: 13,
                marginBottom: 16,
              }}
            >
              <Text style={[typography.small, { color: theme.amber, fontWeight: "700" }]}>
                Bearer note  -  share carefully
              </Text>
              <Text style={[typography.small, { color: theme.amber, marginTop: 4 }]}>
                Anyone holding this code can spend the note. It stays spendable from
                your wallet too until it is withdrawn  -  treat the code like cash.
              </Text>
            </View>

            <Text style={[typography.micro, { color: theme.textMuted, marginBottom: 10 }]}>
              Pick an unspent note
            </Text>
            {unspent.length === 0 ? (
              <Card>
                <Text style={[typography.body, { color: theme.textSoft }]}>
                  No unspent notes in memory.
                </Text>
                <Text style={[typography.small, { color: theme.textMuted, marginTop: 6 }]}>
                  Pull to refresh on the home screen first.
                </Text>
              </Card>
            ) : (
              unspent
                .slice()
                .sort((a, b) => Number(b.amount) - Number(a.amount))
                .map((n) => {
                  const active = selectedId === n.id;
                  return (
                    <Pressable
                      key={n.id}
                      onPress={() => setSelectedId(n.id)}
                      style={{
                        marginBottom: 10,
                        padding: 14,
                        borderRadius: theme.radius,
                        borderWidth: 1,
                        borderColor: active ? theme.accent : theme.hairline,
                        backgroundColor: theme.surface,
                        flexDirection: "row",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <View>
                        <Text style={[typography.h2, { color: theme.text }]}>
                          {fmtSol(Number(n.amount))} SOL
                        </Text>
                        <MonoText style={{ marginTop: 2 }}>leaf {n.index}</MonoText>
                      </View>
                      {active ? <Pill tone="accent">selected</Pill> : <Pill tone="muted">unspent</Pill>}
                    </Pressable>
                  );
                })
            )}

            {paymentCode ? (
              <View style={{ marginTop: 18 }}>
                <Text style={[typography.micro, { color: theme.textMuted, marginBottom: 8 }]}>
                  Payment code  -  share with the recipient
                </Text>
                <View
                  style={{
                    backgroundColor: theme.bgElevated,
                    borderWidth: 1,
                    borderColor: theme.hairline,
                    borderRadius: theme.radiusSm,
                    padding: 12,
                  }}
                >
                  <Text
                    selectable
                    style={[typography.mono, { color: theme.textSoft, fontFamily: "monospace" }]}
                  >
                    {paymentCode}
                  </Text>
                </View>
                <View style={{ marginTop: 12 }}>
                  <Button title="Share code" onPress={shareCode} />
                </View>
              </View>
            ) : null}
          </>
        ) : (
          <>
            <Text style={[typography.micro, { color: theme.textMuted, marginBottom: 8 }]}>
              Paste a payment code (or note JSON)
            </Text>
            <View
              style={{
                backgroundColor: theme.bgElevated,
                borderWidth: 1,
                borderColor: theme.hairline,
                borderRadius: theme.radiusSm,
                paddingHorizontal: 14,
                marginBottom: 16,
              }}
            >
              <TextInput
                value={redeemInput}
                onChangeText={setRedeemInput}
                placeholder="paste the payment code you received..."
                placeholderTextColor={theme.textMuted}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                style={[
                  typography.body,
                  {
                    color: theme.text,
                    fontFamily: "monospace",
                    paddingVertical: 13,
                    minHeight: 96,
                    textAlignVertical: "top",
                  },
                ]}
              />
            </View>
            <Button
              title={busy ? "Redeeming..." : "Redeem note"}
              onPress={redeem}
              loading={busy}
              disabled={!redeemInput.trim()}
            />
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
