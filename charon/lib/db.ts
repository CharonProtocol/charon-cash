import postgres from "postgres";

const globalForSql = globalThis as unknown as {
  sql?: ReturnType<typeof postgres>;
};

/** One pooled client for the waitlist writer. Null when DATABASE_URL is unset. */
export function db() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!globalForSql.sql) {
    globalForSql.sql = postgres(url, { max: 1, prepare: false });
  }
  return globalForSql.sql;
}
