// Runs bench/prover.html in headless Chrome and prints the timings.
// Needs the Vite dev server (`npm run dev` in frontend/) and Chrome.
//   node frontend/bench/run-browser-bench.mjs [runs] [threads]
// Env: BENCH_URL (default http://localhost:5173), CHROME (binary path).
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const runs = Number(process.argv[2] ?? 5)
// Optional thread cap; `1` measures the single-threaded build on the same page.
const threads = process.argv[3]
const base = process.env.BENCH_URL ?? 'http://localhost:5173'
const chrome =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const port = 9333
const profile = mkdtempSync(path.join(process.env.BENCH_TMP ?? tmpdir(), 'pc-bench-'))

const proc = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(200)
  }
  throw new Error('chrome did not expose a debugging target')
}

try {
  const ws = new WebSocket((await target()).webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  let id = 0
  const waiting = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Target.attachedToTarget') {
      // Workers (the prover and its rayon threads) get their own sessions.
      const sessionId = msg.params.sessionId
      for (const [method, params] of [
        ['Runtime.enable', {}],
        ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
      ]) {
        ws.send(JSON.stringify({ id: ++id, sessionId, method, params }))
      }
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      console.error('page exception:', d.exception?.description ?? d.text)
    } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      console.error(`page console.${msg.params.type}:`, msg.params.args.map((a) => a.value ?? a.description).join(' '))
    }
    waiting.get(msg.id)?.(msg)
    waiting.delete(msg.id)
  }
  const send = (method, params = {}) =>
    new Promise((r) => {
      const n = ++id
      waiting.set(n, r)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value

  await send('Runtime.enable')
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  const query = `runs=${runs}${threads ? `&threads=${threads}` : ''}`
  await send('Page.navigate', { url: `${base}/bench/prover.html?${query}` })
  const deadline = Date.now() + Number(process.env.BENCH_TIMEOUT_MS ?? 5 * 60_000)
  let result
  while (!(result = await evaluate('window.__bench'))) {
    if (Date.now() > deadline) {
      throw new Error(`bench timed out; page shows: ${await evaluate("document.getElementById('out')?.textContent")}`)
    }
    await sleep(500)
  }
  console.log(JSON.stringify(result, null, 2))
  ws.close()
  if (result.error) process.exitCode = 1
} finally {
  proc.kill()
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
}
