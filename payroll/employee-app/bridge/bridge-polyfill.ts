/*
 * bridge-polyfill.ts — runs INSIDE the hidden WebView, BEFORE the SDK IIFE.
 *
 * The privacy-cash SDK (via @solana/web3.js) references the `Buffer` Node global
 * unguarded at module-eval time. A browser WebView has no `Buffer`, so the SDK
 * IIFE throws before it can assign window.PrivacyCashSDK → "SDK bundle missing"
 * → balance never loads. This module installs the missing Node globals first.
 *
 * It is imported as the FIRST line of the generated sdk-entry.ts so esbuild
 * evaluates its side effects before any SDK module's top-level code runs.
 */
import { Buffer } from "buffer";

const g = globalThis as unknown as Record<string, unknown>;

if (typeof g.Buffer === "undefined") g.Buffer = Buffer;
if (typeof g.process === "undefined") {
  g.process = { env: { NODE_ENV: "production" }, versions: {} };
}
if (typeof g.global === "undefined") g.global = g;
