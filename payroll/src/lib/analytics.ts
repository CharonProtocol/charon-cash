import posthog from "posthog-js"

// PostHog product analytics. Enabled only when VITE_POSTHOG_KEY is set at
// build time (.env.local) — without it everything here is a silent no-op, so
// local dev and forked builds stay telemetry-free unless opted in.

const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com"

let enabled = false

export function initAnalytics(): void {
  if (!key) return
  try {
    posthog.init(key, {
      api_host: host,
      // SPA: the router re-renders without reloads, so pageviews are
      // captured manually on route change (see App).
      capture_pageview: false,
      capture_pageleave: true,
    })
    enabled = true
  } catch {
    enabled = false
  }
}

export function capturePage(path: string): void {
  if (!enabled) return
  posthog.capture("$pageview", { $current_url: window.location.href, path })
}

export function captureEvent(name: string, props?: Record<string, unknown>): void {
  if (!enabled) return
  posthog.capture(name, props)
}

/** Attribute the session to an employer wallet (no PII beyond the pubkey). */
export function identifyWallet(wallet: string): void {
  if (!enabled) return
  if (posthog.get_distinct_id() !== wallet) posthog.identify(wallet)
}
