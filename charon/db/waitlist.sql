-- Marketing waitlist. Run once against the Charon Postgres database.
-- Supabase: SQL editor, or `psql "$DATABASE_URL" -f db/waitlist.sql`

create extension if not exists pgcrypto;

create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  wallet text,
  created_at timestamptz not null default now(),
  consent_at timestamptz not null,
  source text not null default 'landing',
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer text,
  constraint waitlist_email_unique unique (email)
);

-- Optional Solana public key. Safe to re-run on a table created before this column existed.
alter table waitlist add column if not exists wallet text;
