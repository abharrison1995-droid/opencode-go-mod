import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { getUsage } from '../shared/usage.mjs'

const COOKIE = 'agent_bridge_dashboard'
const html = nonce => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Subscription Bridge</title>
<style nonce="${nonce}">
  :root{color-scheme:dark light;font:16px/1.45 system-ui,sans-serif}body{margin:0;background:#10141b;color:#eef2f7}main{max-width:860px;margin:0 auto;padding:28px 18px}h1{font-size:1.35rem}p,small{color:#9eacbd}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px}.card{border:1px solid #374252;border-radius:12px;padding:16px;background:#171e28}.row{display:flex;justify-content:space-between;gap:8px}.status{color:#8dd7a8}.stale{color:#f1c66d}.unavailable{color:#f28b82}.meter{height:8px;background:#303b4a;border-radius:8px;overflow:hidden;margin:7px 0}.fill{height:100%;background:#70c7a0}.window{border-top:1px solid #303b4a;margin-top:11px;padding-top:10px}.window:first-child{border:0;margin-top:0}.error{color:#f1c66d;font-size:.88rem}button{border:1px solid #566579;border-radius:7px;background:#263344;color:inherit;padding:8px 11px;cursor:pointer}button:disabled{opacity:.55}
</style><main><header class="row"><div><h1>Subscription usage</h1><p>Read-only provider readings. Percentages do not guarantee next-request availability.</p></div><button id="refresh">Refresh readings</button></header><p id="state" role="status"></p><section class="grid" id="providers"></section></main>
<script nonce="${nonce}">
const titles={'opencode-go':'OpenCode Go','codex-pro-1':'Codex Pro 1','codex-pro-2':'Codex Pro 2','google-ai-pro':'Google AI Pro'};
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
function show(providers){const root=document.querySelector('#providers');root.replaceChildren();for(const p of providers){const card=el('article',undefined,'card');const head=el('div',undefined,'row');head.append(el('strong',titles[p.provider]||p.provider));head.append(el('span',p.status,p.status==='available'?'status':p.status==='stale'?'stale':'unavailable'));card.append(head);if(p.accountId&&p.accountId!=='default')card.append(el('small',p.accountId));if(p.windows?.length){for(const w of p.windows){const block=el('div',undefined,'window');const label=[w.model,w.label].filter(Boolean).join(' · ')||'Quota';block.append(el('strong',label));if(w.percentRemaining!==undefined){block.append(el('div',undefined,'meter'));const bar=block.lastChild.appendChild(el('div',undefined,'fill'));bar.style.width=Math.max(0,Math.min(100,w.percentRemaining))+'%';block.append(el('small',Math.round(w.percentRemaining)+'% remaining'+(w.percentUsed!==undefined?' · '+Math.round(w.percentUsed)+'% used':'')));}else if(w.remaining!==undefined)block.append(el('div',String(w.remaining)+' remaining'));if(w.durationMins)block.append(el('small',w.durationMins+' minute window'));if(w.resetsAt)block.append(el('small','Resets '+new Date(w.resetsAt).toLocaleString()));card.append(block);}}else card.append(el('p',p.measurement==='provider-details'?'Connected; no structured quota value returned.':p.status==='stale'?'Last reading is stale.':'No server quota reading available.'));if(p.diagnostic)card.append(el('p',p.diagnostic,'error'));card.append(el('small','Source: '+(p.source||'Unavailable')));if(p.lastSuccessAt)card.append(el('small','Last successful refresh: '+new Date(p.lastSuccessAt).toLocaleString()));root.append(card);}}
async function load(force=false){const button=document.querySelector('#refresh');button.disabled=true;document.querySelector('#state').textContent=force?'Refreshing…':'Checking cached readings…';try{const response=force?await fetch('/api/refresh',{method:'POST'}):await fetch('/api/usage');if(!response.ok)throw new Error('Dashboard request failed ('+response.status+').');const data=await response.json();show(data.providers);document.querySelector('#state').textContent='Last checked '+new Date().toLocaleTimeString();}catch(error){document.querySelector('#state').textContent=error.message;}finally{button.disabled=false;}}
document.querySelector('#refresh').addEventListener('click',()=>load(true));load();setInterval(()=>load(false),300000);
</script></html>`

function equalToken(supplied, expected) {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}

function cookieValue(header) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === COOKIE) return rest.join('=')
  }
  return undefined
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

export async function startDashboard({ host = '127.0.0.1', port = 0, directory, readUsage = getUsage } = {}) {
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('The dashboard may only bind to the local computer.')
  const token = randomBytes(32).toString('base64url')
  let origin
  const server = createServer(async (req, res) => {
    const remote = req.socket.remoteAddress
    if (!isLoopback(remote)) return json(res, 403, { error: 'Local access only.' })
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: 'Invalid host.' })
    const path = new URL(req.url ?? '/', origin).pathname
    if (req.method === 'GET' && equalToken(path.slice(1), token)) {
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      return res.end()
    }
    const authenticated = equalToken(cookieValue(req.headers.cookie), token)
    if (!authenticated) return json(res, 401, { error: 'Open the one-time dashboard link printed by the local command.' })
    if (req.method === 'GET' && path === '/') {
      const nonce = randomBytes(18).toString('base64url')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
      })
      return res.end(html(nonce))
    }
    if (req.method === 'GET' && path === '/api/usage') {
      try { return json(res, 200, { providers: await readUsage(directory ? { directory } : {}) }) }
      catch { return json(res, 503, { error: 'Provider usage could not be read.' }) }
    }
    if (req.method === 'POST' && path === '/api/refresh') {
      if (req.headers.origin !== origin) return json(res, 403, { error: 'Same-origin refresh required.' })
      try { return json(res, 200, { providers: await readUsage(directory ? { directory, force: true } : { force: true }) }) }
      catch { return json(res, 503, { error: 'Provider usage could not be refreshed.' }) }
    }
    return json(res, 404, { error: 'Not found.' })
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not determine dashboard address.')
  const urlHost = host.includes(':') ? `[${host}]` : host
  origin = `http://${urlHost}:${address.port}`
  return { server, origin, url: `${origin}/${token}`, close: () => new Promise(resolvePromise => server.close(resolvePromise)) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let directory
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] === '--directory') directory = process.argv[++index]
  }
  const dashboard = await startDashboard({ directory })
  process.stdout.write(`Subscription usage dashboard is available on this computer: ${dashboard.url}\n`)
  process.stdout.write('The one-time link creates a local browser session and redirects away from the token. Press Ctrl+C to stop.\n')
  const close = () => { void dashboard.close().finally(() => process.exit(0)) }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
