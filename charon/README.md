# Charon

Landing page for Charon Protocol. This folder does not import the privacy-cash app, the SDK, or the program. To move it into the future frontend repo, copy `charon/` and keep the same `DATABASE_URL`.

## Run

```bash
cd charon
cp .env.example .env   # set DATABASE_URL to the Supabase Postgres URI
psql "$DATABASE_URL" -f db/waitlist.sql
bun install
bun run dev            # http://localhost:3000
```

`DATABASE_URL` is read only by the waitlist route. The page never receives a database key.

The table is the marketing record: email, consent time, source, and campaign fields. Export it from the Supabase table view when you are ready to send. This page does not send mail.
