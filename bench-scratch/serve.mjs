import { file } from 'bun'
const root = process.argv[2]; const out = process.argv[3]
Bun.serve({ port: 8977, async fetch(req) {
  const u = new URL(req.url)
  const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
  if (u.pathname === '/result') { await Bun.write(out, await req.text()); return new Response('ok', {headers: h}) }
  const f = file(root + (u.pathname === '/' ? '/index.html' : u.pathname))
  if (!(await f.exists())) return new Response('404', {status: 404, headers: h})
  const ct = u.pathname.endsWith('.wasm') ? 'application/wasm' : u.pathname.endsWith('.mjs') || u.pathname.endsWith('.js') ? 'text/javascript' : undefined
  return new Response(f, { headers: { ...h, ...(ct ? {'content-type': ct} : {}) } })
}})
console.log('serving', root)
