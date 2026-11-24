// PaperDesk for iPhone on Cloudflare Workers: serves the app from ./public and answers /relay
// (the Yahoo price relay in functions/relay.js, shared with the Pages setup).
import { onRequestGet as relay } from '../functions/relay.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/relay') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return relay({ request, waitUntil: (p) => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },
};
