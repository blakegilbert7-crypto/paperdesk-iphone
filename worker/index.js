// PaperDesk for iPhone on Cloudflare Workers: serves the app from ./public, answers /relay (the
// Yahoo price relay in functions/relay.js) and /sync (sync codes, functions/sync.js).
import { onRequestGet as relay } from '../functions/relay.js';
import { syncRoute, SyncBox } from '../functions/sync.js';

export { SyncBox };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/relay') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return relay({ request, waitUntil: (p) => ctx.waitUntil(p) });
    }
    if (url.pathname === '/sync' || url.pathname.startsWith('/sync/')) return syncRoute(request, env);
    return env.ASSETS.fetch(request);
  },
};
