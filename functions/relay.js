// PaperDesk price relay (Cloudflare Pages Function, served at /relay).
// Yahoo Finance does not let web pages read its public chart data directly, so the phone app asks
// this relay instead. It only forwards Yahoo's public chart and spark endpoints, keeps no logs or
// accounts, and caches each answer for a few seconds so many refreshes cost Yahoo one request.
const UA = {
  'query1.finance.yahoo.com': 'Mozilla/5.0',
  'query2.finance.yahoo.com': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
const OK_PATH = /^\/v8\/finance\/(chart\/[^/]+|spark)$/;

function ttlFor(target) {
  if (target.pathname.endsWith('/spark')) return 20;
  const iv = target.searchParams.get('interval') || '';
  return /^(1d|1wk|1mo)$/.test(iv) ? 120 : 15;
}

export async function onRequestGet(context) {
  const { request } = context;
  let target;
  try { target = new URL(new URL(request.url).searchParams.get('u') || ''); } catch (e) {
    return new Response(JSON.stringify({ error: 'bad url' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (target.protocol !== 'https:' || !UA[target.hostname] || !OK_PATH.test(target.pathname)) {
    return new Response(JSON.stringify({ error: 'not allowed' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  const ttl = ttlFor(target);
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const key = new Request(target.toString());
  let hit = null;
  if (cache) { try { hit = await cache.match(key); } catch (e) { hit = null; } }
  let body; let status; let type;
  if (hit) {
    body = await hit.text(); status = hit.status; type = hit.headers.get('Content-Type');
  } else {
    let up;
    try {
      up = await fetch(target.toString(), { headers: { 'User-Agent': UA[target.hostname], Accept: 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'upstream unreachable' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    body = await up.text(); status = up.status; type = up.headers.get('Content-Type') || 'application/json';
    if (cache && up.ok) {
      const store = new Response(body, { status, headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=' + ttl } });
      const p = cache.put(key, store).catch(() => {});
      if (context.waitUntil) context.waitUntil(p);
    }
  }
  return new Response(body, { status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
