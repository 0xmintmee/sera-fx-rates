import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { toRaw, fromRaw, groupByCurrency, counterpartsOf, measure, resolveCanonical, buildTable, lookup, convert } from '../src/rates.js';
import { handle } from '../src/http.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => JSON.parse(readFileSync(join(here, 'fixtures', n), 'utf8'));

const TOKENS = fx('tokens.json').tokens;
const MARKETS = fx('markets.json').markets;
const QUOTE_OK = fx('quote-ok.json');
const QUOTE_NOLIQ = fx('quote-noliq.json');
const QUOTE_ZERO_FLOOR = fx('quote-zero-floor.json');
const bySym = Object.fromEntries(TOKENS.map((t) => [t.symbol, t]));
const symbolOfAddress = Object.fromEntries(TOKENS.map((t) => [t.address.toLowerCase(), t.symbol]));

/**
 * Fetch double routed on WHICH TOKEN is being quoted, not on call order.
 *
 * `book` maps a symbol to the smallest size that prices, or null for a token the
 * router will not price at any size, or 'error' for a genuine upstream failure,
 * or 'routed-empty' for the live behaviour found on 26 Aug 2026: HTTP 200 with a
 * full route and `minOutputAmount: "0"` at every size.
 * Routing this way means a test says what the book looks like rather than
 * encoding the order the implementation happens to iterate in.
 *
 * Sizes BELOW a numeric floor return the zero-floor 200 rather than a 400,
 * because that is what the venue actually does for a pair it can route: the flat
 * gas eats the notional and the guarantee lands on zero. Encoding the real
 * behaviour is the whole point -- the previous fixture returned a 400 there, the
 * suite passed 22/22, and the layer still served `rate: 0` in production.
 */
function stubBook(book) {
  const calls = [];
  const res = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const impl = async (url, init) => {
    if (url.endsWith('/tokens')) return res({ tokens: TOKENS });
    if (url.endsWith('/markets')) return res({ markets: MARKETS });
    const body = JSON.parse(init.body);
    calls.push(body);
    const symbol = symbolOfAddress[body.to_token];
    const floor = book[symbol];
    if (floor === 'error') return res({ detail: 'upstream exploded' }, 500);
    if (floor === 'routed-empty') return res(QUOTE_ZERO_FLOOR);
    const size = Number(body.from_amount) / 10 ** bySym.USDC.decimals;
    if (floor != null && size >= floor) return res(QUOTE_OK);
    if (floor != null) return res(QUOTE_ZERO_FLOOR);
    return res(QUOTE_NOLIQ, 400);
  };
  impl.calls = calls;
  return impl;
}

const NOTHING_PRICES = { XSGD: null, EURC: null, EUR0: null };

test('toRaw scales without floating point drift', () => {
  assert.equal(toRaw(1, 6), '1000000');
  assert.equal(toRaw('0.1', 6), '100000');
  assert.equal(toRaw('1234567.123456', 18), '1234567123456000000000000');
});

test('toRaw rejects nonsense rather than scaling it', () => {
  assert.throws(() => toRaw('-1', 6), TypeError);
  assert.throws(() => toRaw('abc', 6), TypeError);
});

test('fromRaw inverts toRaw', () => {
  assert.equal(fromRaw(toRaw('12.5', 6), 6), 12.5);
});

test('counterpartsOf checks both legs, so a hub sitting on the base side is not missed', () => {
  const inverted = [{ symbol: 'USDC/XSGD', base_symbol: 'USDC', quote_symbol: 'XSGD' }];
  assert.deepEqual(counterpartsOf(inverted, 'USDC'), ['XSGD'], 'this is the denominator bug: filtering one leg undercounts the book');
  assert.deepEqual(counterpartsOf(MARKETS, 'USDC').sort(), ['EUR0', 'EURC', 'XSGD']);
});

test('groupByCurrency collects every token carrying an ISO code', () => {
  const g = groupByCurrency(TOKENS);
  assert.deepEqual(g.EUR.map((t) => t.symbol), ['EUR0', 'EURC']);
  assert.deepEqual(g.SGD.map((t) => t.symbol), ['XSGD']);
});

test('measure walks the whole ladder and returns the curve, not just the first rung', async () => {
  const fetchImpl = stubBook({ XSGD: 10 });
  const r = await measure(bySym.USDC, bySym.XSGD, { fetchImpl, ladder: [1, 10, 100], delayMs: 0 });
  assert.equal(r.quoted, true);
  assert.equal(r.measuredAtSize, 10, 'the headline rate is the smallest size that actually priced');
  assert.equal(r.gasPctOfNotional, 10, 'a flat $1 gas on a $10 trade is 10% of the trade');
  assert.deepEqual(r.rungs.map((x) => x.size), [10, 100], 'the $1 rung routed but guaranteed nothing');
  assert.equal(fetchImpl.calls.length, 3, 'every rung is measured, because the rate is different at each one');
});

test('lookup picks the rung that applies to the amount asked about', async () => {
  const table = await buildTable({ fetchImpl: stubBook({ XSGD: 10, EURC: null, EUR0: null }), ladder: [1, 10, 100], delayMs: 0, asOf: 'T' });
  const small = lookup(table, 'USD', 'SGD', 10);
  const large = lookup(table, 'USD', 'SGD', 500);
  assert.equal(small.measuredAtSize, 10);
  assert.equal(large.measuredAtSize, 100, 'a $500 transfer must not be priced off the $10 rung');
  assert.ok(Array.isArray(large.ladder), 'the whole curve is served so a caller can check the pick');
});

test('an amount below the smallest measured rung is answered as an upper bound, never extrapolated', async () => {
  const table = await buildTable({ fetchImpl: stubBook({ XSGD: 10, EURC: null, EUR0: null }), ladder: [1, 10, 100], delayMs: 0, asOf: 'T' });
  const r = lookup(table, 'USD', 'SGD', 2);
  assert.equal(r.measuredAtSize, 10);
  assert.equal(r.belowSmallestMeasuredSize, true);
  assert.match(r.detail, /upper bound/);
});

test('convert prices the amount off its own rung, so a big transfer is not quoted at the small-size rate', async () => {
  const table = await buildTable({ fetchImpl: stubBook({ XSGD: 10, EURC: null, EUR0: null }), ladder: [1, 10, 100], delayMs: 0, asOf: 'T' });
  const r = convert(table, 'USD', 'SGD', 500);
  assert.equal(r.measuredAtSize, 100);
  assert.equal(r.result, 500 * r.rate);
  assert.ok(r.cost.allInPct < 0.4, 'a flat $1 on $500 is 0.2%, so all-in is about 0.34%');
});

test('measure reports an empty book as an answer, not an exception', async () => {
  const r = await measure(bySym.USDC, bySym.EURC, { fetchImpl: stubBook(NOTHING_PRICES), ladder: [1, 10, 100], delayMs: 0 });
  assert.equal(r.quoted, false);
  assert.equal(r.reason, 'no_liquidity');
});

test('an upstream failure is distinguishable from an empty book', async () => {
  const r = await measure(bySym.USDC, bySym.XSGD, { fetchImpl: stubBook({ XSGD: 'error' }), ladder: [1], delayMs: 0 });
  assert.equal(r.quoted, false);
  assert.equal(r.reason, 'upstream_error', 'a broken deploy must never be readable as a thin book');
});

test('resolveCanonical picks the token that prices, not the one someone guessed', async () => {
  // Both EUR tokens are listed. EURC never prices; EUR0 prices at $100.
  const fetchImpl = stubBook({ XSGD: 1, EUR0: 100, EURC: null });
  const c = await resolveCanonical(bySym.USDC, TOKENS, MARKETS, { fetchImpl, ladder: [1, 10, 100], delayMs: 0 });
  assert.equal(c.EUR.canonical, 'EUR0', 'a hardcoded EURC would have served a rate for a pair that cannot fill');
  assert.deepEqual(c.EUR.candidates, ['EUR0', 'EURC'], 'both are still reported, because ten listings and one fill is the finding');
  assert.equal(c.SGD.canonical, 'XSGD');
  assert.equal(c.USD.isHub, true);
});

test('resolveCanonical prefers the token that prices at the SMALLEST size', async () => {
  const fetchImpl = stubBook({ XSGD: 1, EUR0: 100, EURC: 1 });
  const c = await resolveCanonical(bySym.USDC, TOKENS, MARKETS, { fetchImpl, ladder: [1, 10, 100], delayMs: 0 });
  assert.equal(c.EUR.canonical, 'EURC', 'reachable at $1 beats reachable at $100');
  assert.equal(c.EUR.measuredAtSize, 1);
});

test('a currency where nothing prices resolves to null, never to a fallback', async () => {
  const c = await resolveCanonical(bySym.USDC, TOKENS, MARKETS, { fetchImpl: stubBook(NOTHING_PRICES), ladder: [1], delayMs: 0 });
  assert.equal(c.EUR.canonical, null);
  assert.equal(c.EUR.reason, 'no_liquidity');
  assert.deepEqual(c.EUR.candidates, ['EUR0', 'EURC']);
});

test('lookup refuses to invert a rate, because liquidity is directional', async () => {
  const table = await buildTable({ asOf: 'T', fetchImpl: stubBook({ XSGD: 1 }), ladder: [1], delayMs: 0 });
  const r = lookup(table, 'SGD', 'USD');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsupported_direction');
  assert.equal(r.rate, null, 'USDC->MYRT priced and MYRT->USDC did not; one over the other is an order that is not there');
});

test('convert states the all-in cost as a curve, not a rate', async () => {
  const table = await buildTable({ asOf: 'T', fetchImpl: stubBook({ XSGD: 1 }), ladder: [1], delayMs: 0 });
  const small = convert(table, 'USD', 'SGD', 10);
  const large = convert(table, 'USD', 'SGD', 10000);
  assert.equal(small.cost.flatGasUsd, 1);
  assert.ok(small.cost.allInPct > 10, 'a flat $1 on a $10 transfer is over 10% all-in');
  assert.ok(large.cost.allInPct < 0.2, 'the same flat $1 nearly vanishes at $10,000');
  assert.ok(small.cost.allInPct > large.cost.allInPct * 50, 'quoting one percentage for both sizes is the mistake this field exists to stop');
});

test('convert on an unpriceable currency returns null with a reason, not a number', async () => {
  const table = await buildTable({ asOf: 'T', fetchImpl: stubBook(NOTHING_PRICES), ladder: [1], delayMs: 0 });
  const r = convert(table, 'USD', 'EUR', 100);
  assert.equal(r.ok, false);
  assert.equal(r.rate, null);
  assert.equal(r.reason, 'no_liquidity');
  assert.deepEqual(r.candidates, ['EUR0', 'EURC']);
});

test('/health reports staleness so a caller can tell a fresh table from an abandoned one', () => {
  const res = handle({ pathname: '/health', query: new URLSearchParams() }, { table: { asOf: 'T', currenciesPriced: 1, currenciesListed: 3 }, ageSeconds: 1200, staleAfter: 900 });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).stale, true);
});

test('every endpoint 503s rather than inventing a table before the first measurement', () => {
  for (const p of ['/latest', '/currencies', '/convert']) {
    const res = handle({ pathname: p, query: new URLSearchParams() }, { table: null, ageSeconds: null });
    assert.equal(res.status, 503, `${p} must not answer without a table`);
  }
});

test('/latest serves null with a reason rather than omitting a thin currency', async () => {
  const table = await buildTable({ asOf: 'T', fetchImpl: stubBook({ XSGD: 1, EUR0: null, EURC: null }), ladder: [1], delayMs: 0 });
  const b = JSON.parse(handle({ pathname: '/latest', query: new URLSearchParams('from=USD') }, { table, ageSeconds: 5 }).body);
  assert.equal(b.rates.EUR.rate, null);
  assert.ok(b.rates.EUR.reason, 'a missing rate must say why, or a client cannot tell it from a gap');
  assert.ok(b.rates.SGD.rate > 0);
  assert.equal(b.direction, 'outbound only');
});

test('/latest refuses a reversed base instead of inverting it', async () => {
  const table = await buildTable({ asOf: 'T', fetchImpl: stubBook({ XSGD: 1 }), ladder: [1], delayMs: 0 });
  const res = handle({ pathname: '/latest', query: new URLSearchParams('from=SGD') }, { table, ageSeconds: 5 });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, 'unsupported_direction');
});

test('/convert separates a bad request, an unknown currency and a thin book', async () => {
  const table = await buildTable({ asOf: 'T', fetchImpl: stubBook(NOTHING_PRICES), ladder: [1], delayMs: 0 });
  assert.equal(handle({ pathname: '/convert', query: new URLSearchParams('from=USD&to=EUR&amount=-5') }, { table, ageSeconds: 5 }).status, 400);
  assert.equal(handle({ pathname: '/convert', query: new URLSearchParams('from=USD&to=ZZZ&amount=5') }, { table, ageSeconds: 5 }).status, 404);
  const thin = handle({ pathname: '/convert', query: new URLSearchParams('from=USD&to=EUR&amount=5') }, { table, ageSeconds: 5 });
  assert.equal(thin.status, 200, 'a thin book is a real answer, not an error');
  assert.equal(JSON.parse(thin.body).rate, null);
});

test('/currencies reports listed and priced as separate numbers', async () => {
  const table = await buildTable({ asOf: 'T', fetchImpl: stubBook({ XSGD: 1, EUR0: null, EURC: null }), ladder: [1], delayMs: 0 });
  const b = JSON.parse(handle({ pathname: '/currencies', query: new URLSearchParams() }, { table, ageSeconds: 5 }).body);
  assert.equal(b.listed, 3);
  assert.equal(b.priced, 2, 'the USD hub plus SGD. EUR has two listings and no fills');
  const eur = b.currencies.find((c) => c.currency === 'EUR');
  assert.equal(eur.priceable, false);
  assert.equal(eur.candidates.length, 2);
});

test('CORS is set so a browser client can actually use this', () => {
  const res = handle({ pathname: '/health', query: new URLSearchParams() }, { table: null, ageSeconds: null });
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('an unknown path lists the endpoints rather than failing silently', () => {
  const res = handle({ pathname: '/nope', query: new URLSearchParams() }, { table: {}, ageSeconds: 1 });
  assert.equal(res.status, 404);
  assert.ok(JSON.parse(res.body).endpoints.includes('/latest'));
});

test('a 200 that guarantees zero output is not a price, and the ladder keeps climbing', async () => {
  // The live shape: USDC->XSGD at $1 returns HTTP 200, a full route, a permit,
  // a deadline, leg_count 1 -- and minOutputAmount "0". Anything that reads a
  // 200 as a price serves rate 0 to every caller on the only corridors that work.
  const fetchImpl = stubBook({ XSGD: 10 });
  const r = await measure(bySym.USDC, bySym.XSGD, { fetchImpl, ladder: [1, 10, 100], delayMs: 0 });
  assert.equal(r.quoted, true);
  assert.equal(r.measuredAtSize, 10, 'the $1 rung routed but guaranteed nothing, so it is not the answer');
  assert.ok(r.rate > 0, 'a rate of exactly zero is never a measurement');
});

test('a pair that routes but guarantees nothing at every size says so, and not no_liquidity', async () => {
  const r = await measure(bySym.USDC, bySym.XSGD, { fetchImpl: stubBook({ XSGD: 'routed-empty' }), ladder: [1, 10], delayMs: 0 });
  assert.equal(r.quoted, false);
  assert.equal(r.reason, 'gas_exceeds_notional', 'tradeable-but-too-small is actionable; no market is not');
  assert.match(r.detail, /route exists/);
});

test('resolveCanonical surfaces gas_exceeds_notional rather than flattening it to no_liquidity', async () => {
  const c = await resolveCanonical(bySym.USDC, TOKENS, MARKETS, {
    fetchImpl: stubBook({ XSGD: 'routed-empty', EURC: null, EUR0: null }), ladder: [1, 10], delayMs: 0,
  });
  assert.equal(c.SGD.canonical, null);
  assert.equal(c.SGD.reason, 'gas_exceeds_notional');
  assert.equal(c.EUR.reason, 'no_liquidity', 'a currency with no route at all is still a different answer');
});

test('lookup passes the specific reason through, so a client can tell "send more" from "no market"', async () => {
  const table = await buildTable({
    fetchImpl: stubBook({ XSGD: 'routed-empty', EURC: null, EUR0: null }), ladder: [1, 10], delayMs: 0, asOf: 'T',
  });
  const r = lookup(table, 'USD', 'SGD');
  assert.equal(r.ok, false);
  assert.equal(r.rate, null);
  assert.equal(r.reason, 'gas_exceeds_notional');
});
