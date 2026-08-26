/**
 * The HTTP surface, shared by the Cloudflare Worker and the plain Node server so
 * the two can never drift apart.
 *
 * Endpoints:
 *   GET /health                     is the process up, and how old is the table
 *   GET /currencies                 every ISO currency, with the token that actually prices it
 *   GET /latest?from=USD            all rates from one currency
 *   GET /convert?from&to&amount     one conversion, with the all-in cost
 *
 * A currency the book will not price returns HTTP 200 with rate: null and a
 * reason. It is a real answer, not an error. A currency that does not exist is a
 * 404, and a malformed request is a 400, so a caller can tell the three apart.
 */

import { lookup, convert } from './rates.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=60',
};

const json = (body, status = 200) => ({
  status,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(body, null, 2),
});

/**
 * @param {{pathname: string, query: URLSearchParams}} req
 * @param {{table: object|null, ageSeconds: number|null, staleAfter: number}} state
 */
export function handle(req, state) {
  const { pathname, query } = req;
  const { table, ageSeconds, staleAfter = 900 } = state;

  if (pathname === '/health') {
    return json({
      ok: true,
      hasTable: !!table,
      asOf: table ? table.asOf : null,
      ageSeconds,
      stale: ageSeconds == null ? null : ageSeconds > staleAfter,
      currenciesPriced: table ? table.currenciesPriced : null,
      currenciesListed: table ? table.currenciesListed : null,
    });
  }

  if (!table) {
    return json({ ok: false, error: 'no_table_yet', detail: 'the first measurement has not completed' }, 503);
  }

  if (pathname === '/currencies') {
    const rows = Object.values(table.currencies).map((c) => ({
      currency: c.currency,
      canonical: c.canonical,
      candidates: c.candidates,
      priceable: !!c.canonical,
      reason: c.canonical ? undefined : c.reason,
      measuredAtSize: c.measuredAtSize ?? null,
    }));
    return json({
      asOf: table.asOf,
      hub: table.hub,
      listed: table.currenciesListed,
      priced: table.currenciesPriced,
      note: 'candidates is every token carrying that ISO code. canonical is the one that actually priced, at the smallest size. these are different numbers and conflating them is the whole point of this service.',
      currencies: rows,
    });
  }

  if (pathname === '/latest') {
    const from = (query.get('from') || table.hubCurrency).toUpperCase();
    if (from !== table.hubCurrency) {
      return json({
        ok: false, error: 'unsupported_direction',
        detail: `this table measured ${table.hubCurrency} outbound. a rate measured one way cannot be inverted, because liquidity is directional.`,
        supported: [table.hubCurrency],
      }, 400);
    }
    const rates = {};
    for (const iso of Object.keys(table.currencies)) {
      const r = lookup(table, from, iso);
      rates[iso] = r.ok
        ? { rate: r.rate, token: r.token, measuredAtSize: r.measuredAtSize, gasCostUsd: r.gasCostUsd }
        : { rate: null, reason: r.reason };
    }
    return json({ asOf: table.asOf, base: from, direction: 'outbound only', rates });
  }

  if (pathname === '/convert') {
    const from = (query.get('from') || '').toUpperCase();
    const to = (query.get('to') || '').toUpperCase();
    const amount = Number(query.get('amount'));
    if (!from || !to) return json({ ok: false, error: 'bad_request', detail: 'from and to are required' }, 400);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ ok: false, error: 'bad_request', detail: 'amount must be a positive number' }, 400);
    }
    if (!table.currencies[to] && to !== table.hubCurrency) {
      return json({ ok: false, error: 'unknown_currency', detail: `${to} is not in the registry` }, 404);
    }
    return json(convert(table, from, to, amount));
  }

  return json({ ok: false, error: 'not_found', endpoints: ['/health', '/currencies', '/latest', '/convert'] }, 404);
}

export { CORS };
