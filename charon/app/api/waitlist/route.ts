import { db } from "@/lib/db";
import { isSolanaAddress } from "@/lib/solana";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WINDOW_MS = 60_000;
const LIMIT = 8;

const hits = new Map<string, { n: number; reset: number }>();

function limited(ip: string) {
  const now = Date.now();
  const row = hits.get(ip);
  if (!row || row.reset < now) {
    hits.set(ip, { n: 1, reset: now + WINDOW_MS });
    return false;
  }
  row.n += 1;
  return row.n > LIMIT;
}

function clip(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 120);
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object") throw new Error("body");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "That request could not be read." }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) {
    return Response.json({ error: "Enter a real email address." }, { status: 400 });
  }
  if (body.consent !== true) {
    return Response.json({ error: "Consent is required." }, { status: 400 });
  }

  const wallet = typeof body.wallet === "string" && body.wallet.trim() ? body.wallet.trim() : null;
  if (wallet && !isSolanaAddress(wallet)) {
    return Response.json({ error: "That is not a Solana address." }, { status: 400 });
  }

  const sql = db();
  if (!sql) {
    return Response.json({ error: "The list is not open yet." }, { status: 503 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(ip)) {
    return Response.json({ error: "Slow down a moment, then try again." }, { status: 429 });
  }

  await sql`
    insert into waitlist (email, wallet, consent_at, source, utm_source, utm_medium, utm_campaign, referrer)
    values (
      ${email},
      ${wallet},
      now(),
      'landing',
      ${clip(body.utm_source)},
      ${clip(body.utm_medium)},
      ${clip(body.utm_campaign)},
      ${clip(body.referrer)}
    )
    on conflict (email) do nothing
  `;

  return Response.json({ ok: true, message: "You're on the list." });
}
