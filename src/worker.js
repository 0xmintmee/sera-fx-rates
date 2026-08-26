/**
 * Cloudflare Worker entry point.
 *
 * The table is rebuilt on a cron trigger and cached in KV, not rebuilt per
 * request: a full measurement is a few dozen quote calls, and serving that on
 * every request would be rude to a public endpoint and slow for the caller.
 *
 * wrangler.toml needs a KV namespace bound as RATES and a cron trigger, e.g.
 *   [triggers]
 *   crons = ["*\/15 * * * *"]
 */

import { buildTable } from './rates.js';
import { handle } from './http.js';

const KEY = 'table:v1';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
    }
    const raw = env.RATES ? await env.RATES.get(KEY) : null;
    const table = raw ? JSON.parse(raw) : null;
    const ageSeconds = table ? Math.round((Date.now() - Date.parse(table.asOf)) / 1000) : null;

    const res = handle({ pathname: url.pathname, query: url.searchParams }, {
      table,
      ageSeconds,
      staleAfter: Number(env.STALE_AFTER_SECONDS || 900),
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },

  async scheduled(event, env) {
    const table = await buildTable({
      hub: env.HUB || 'USDC',
      asOf: new Date(event.scheduledTime).toISOString(),
      base: env.SERA_BASE || undefined,
      delayMs: Number(env.DELAY_MS || 120),
    });
    await env.RATES.put(KEY, JSON.stringify(table));
  },
};
