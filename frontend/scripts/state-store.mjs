// Backend state on disk, with an optional S3-compatible copy (AWS S3,
// Cloudflare R2, ...): the chain mirror snapshot plus the small user data
// the chain doesn't hold. Disk survives a reboot; the bucket survives
// losing the VM. Writes are atomic (tmp + rename), gzip-compressed.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { S3Client } from "bun"

/**
 * @param {{ file: string, log?: (s: string) => void }} opts
 * S3 is on when S3_BUCKET is set (plus S3_ENDPOINT for R2, S3_ACCESS_KEY_ID,
 * S3_SECRET_ACCESS_KEY, optional S3_KEY).
 *
 * Hard monthly caps on bucket operations, far inside R2's free tier (1M
 * writes, 10M reads, 10 GB): past a cap the copy stops for the rest of the
 * month and the disk copy carries on. The counts persist next to the state
 * file. S3_MAX_WRITES_PER_MONTH (500k), S3_MAX_READS_PER_MONTH (100k),
 * S3_MAX_OBJECT_BYTES (200 MB).
 */
export function createStateStore({ file, log = console.log }) {
  const env = process.env
  const caps = {
    writes: Number(env.S3_MAX_WRITES_PER_MONTH ?? 500_000),
    reads: Number(env.S3_MAX_READS_PER_MONTH ?? 100_000),
    bytes: Number(env.S3_MAX_OBJECT_BYTES ?? 200 * 1024 * 1024),
  }
  const usageFile = `${file}.s3usage.json`
  const month = () => new Date().toISOString().slice(0, 7)
  let usage = { month: month(), writes: 0, reads: 0 }
  try {
    const u = JSON.parse(readFileSync(usageFile, "utf8"))
    if (u.month === usage.month) usage = u
  } catch {}
  const capped = new Set()
  /** Count `n` operations of `kind`; false (and no operation) once the month's cap is reached. */
  function spend(kind, n) {
    if (usage.month !== month()) usage = { month: month(), writes: 0, reads: 0 }
    if (usage[kind] + n > caps[kind]) {
      if (!capped.has(kind + usage.month)) log(`state: remote ${kind} cap (${caps[kind]}/month) reached, remote copy paused until next month`)
      capped.add(kind + usage.month)
      return false
    }
    usage[kind] += n
    try {
      mkdirSync(path.dirname(usageFile), { recursive: true })
      writeFileSync(usageFile, JSON.stringify(usage), { mode: 0o600 })
    } catch {}
    return true
  }
  const s3 = env.S3_BUCKET
    ? new S3Client({
        bucket: env.S3_BUCKET,
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION ?? "auto",
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      }).file(env.S3_KEY ?? path.basename(file))
    : null

  const decode = (buf) => JSON.parse(Buffer.from(Bun.gunzipSync(buf)).toString("utf8"))
  const encode = (obj) => Bun.gzipSync(Buffer.from(JSON.stringify(obj)))

  return {
    remote: !!s3,
    /** Disk first, then the bucket; null when neither has a usable copy. */
    async load() {
      if (existsSync(file)) {
        try {
          return decode(readFileSync(file))
        } catch (e) {
          log(`state: disk copy unreadable (${e.message}), trying remote`)
        }
      }
      if (!s3 || !spend("reads", 2)) return null
      try {
        if (!(await s3.exists())) return null
        const obj = decode(new Uint8Array(await s3.arrayBuffer()))
        log("state: restored from remote copy")
        return obj
      } catch (e) {
        log(`state: remote copy unreadable (${e.message})`)
        return null
      }
    },
    saveDisk(obj) {
      mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, encode(obj), { mode: 0o600 })
      renameSync(tmp, file)
    },
    async saveRemote(obj) {
      if (!s3) return
      const body = encode(obj)
      if (body.length > caps.bytes) {
        log(`state: snapshot ${body.length} B exceeds S3_MAX_OBJECT_BYTES, not uploaded`)
        return
      }
      if (spend("writes", 1)) await s3.write(body)
    },
    usage: () => ({ ...usage, caps }),
  }
}
