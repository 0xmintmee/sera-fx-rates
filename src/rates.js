/**
 * Building an honest rate table from Sera's book.
 *
 * Three rules, each one a finding from probing the live API rather than a
 * design preference:
 *
 *   1. THE CANONICAL TOKEN FOR A CURRENCY IS EMPIRICAL, NOT HARDCODED.
 *      Sera's own worker sketch carries `ISO_TO_TOKEN = { USD:'USDC', EUR:'EURC' }`
 *      with a note asking someone to confirm whether EUR should be EURC or EUR0.
 *      It cannot be confirmed by hand: EUR has ten listed tokens and on 23 Aug 2026
 *      none of them quoted at all. The canonical token is whichever one prices at
 *      the smallest size right now, and when none of them price the answer is null.
 *
 *   2. A RATE IS DIRECTIONAL. USDC->MYRT priced while MYRT->USDC returned
 *      no_liquidity at every size on the ladder. Publishing one mid and letting
 *      clients invert it serves a rate with no order behind it, and it fails most
 *      confidently on exactly the thinnest pairs. Every rate here is stored and
 *      served for one direction only.
 *
 *   3. A RATE IS MEASURED WITH gas_mode 'pay_more', NOT THE API DEFAULT.
 *      This one is a correction. The API defaults to 'receive_less', which
 *      deducts the flat gas cost from the OUTPUT. Measured that way USDC->MYRT
 *      looks like it prices worse the smaller you go -- 0 at $1, 3.5486 at $10,
 *      3.9672 at $100 -- and it is tempting to call that a size penalty.
 *      It is not. Send gas_mode 'pay_more' and the same book quotes 4.013693 at
 *      $1, 4.013695 at $10 and 4.013695 at $100: the same rate to six figures
 *      across two orders of magnitude. The curve was the fixed cost being netted
 *      out of the output, exactly as documented, not the price moving.
 *      Measured 28 Aug 2026. Rates here are measured with 'pay_more' so the
 *      number means the price; the flat cost is reported separately, because a
 *      caller needs both and should never see them blended into one figure.
 *
 * When the book will not price something, this layer returns null and says why.
 * Never a fallback, never a last known value, never an inverted guess.
 */

import { fetchTokens, fetchMarkets, fetchQuote } from './sera.js';

export const DEFAULT_LADDER = [1, 10, 100, 1000];

/** Scale a human amount to raw integer units without floating point drift. */
export function toRaw(amount, decimals) {
  const s = String(amount);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new TypeError(`amount must be a non-negative decimal, got ${s}`);
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(`${whole}${padded}`.replace(/^0+(?=\d)/, '')).toString();
}

/** Convert raw integer units back to a human number. */
export function fromRaw(raw, decimals) {
  return Number(BigInt(raw)) / 10 ** decimals;
}

/** Group tokens by their ISO currency. The registry carries `currency`, so nothing is hardcoded. */
export function groupByCurrency(tokens) {
  const out = {};
  for (const t of tokens) {
    if (!t.currency) continue;
    (out[t.currency] ||= []).push(t);
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

/** Every symbol trading against `hub`, checking BOTH legs of each market. */
export function counterpartsOf(markets, hub) {
  const set = new Set();
  for (const m of markets) {
    if (m.quote_symbol === hub) set.add(m.base_symbol);
    if (m.base_symbol === hub) set.add(m.quote_symbol);
  }
  set.delete(hub);
  return [...set];
}

/**
 * Measure one direction. Climbs the ladder and stops at the first size that
 * prices, because the question is the entry size, not the depth.
 *
 * A ZERO FLOOR IS NOT A PRICE, and it is not a fault either. Under gas_mode
 * 'receive_less' a $1 swap returns HTTP 200 with `minOutputAmount: "0"`: the
 * flat gas equals the notional, so nothing is left to guarantee. That is honest
 * arithmetic, disclosed in fee_breakdown before anything is signed, and it goes
 * away entirely under 'pay_more', which is what this layer sends.
 *
 * The guard stays because a caller may override gasMode, and serving `rate: 0`
 * would be worse than serving null: a caller that checks for a number gets one,
 * and a caller that checks truthiness silently falls back. So a non-positive
 * floor is treated as unpriced AT THAT SIZE and the ladder keeps climbing.
 *
 * I originally read that zero as the venue penalising small senders and said so
 * publicly. It was a parameter I had not read. Kept here as the reason the
 * default is 'pay_more'.
 */
export async function measure(from, to, { ladder = DEFAULT_LADDER, delayMs = 120, ...opts } = {}) {
  let routedButEmpty = false;
  const rungs = [];
  for (const size of ladder) {
    let r;
    try {
      r = await fetchQuote(
        { fromToken: from.address, toToken: to.address, fromAmountRaw: toRaw(size, from.decimals) },
        opts,
      );
    } catch (err) {
      if (rungs.length) break; // keep what was measured rather than discarding it
      return { quoted: false, reason: 'upstream_error', detail: err.message };
    }
    if (r.quoted && BigInt(r.minOutputRaw) <= 0n) {
      routedButEmpty = true;
      if (delayMs) await sleep(delayMs);
      continue;
    }
    if (r.quoted) {
      const out = fromRaw(r.minOutputRaw, to.decimals);
      const gas = r.gasCostUsd;
      rungs.push({
        size,
        rate: out / size,
        gasCostUsd: gas,
        gasPctOfNotional: gas != null ? (gas / size) * 100 : null,
        legCount: r.legCount,
      });
    }
    if (delayMs) await sleep(delayMs);
  }
  if (rungs.length) {
    // The whole ladder is still measured and served. Under 'pay_more' the rungs
    // agree to six figures, which is the point: a caller can SEE that the price
    // does not move with size rather than taking it on trust. Under a caller's
    // own 'receive_less' the rungs differ by the fixed cost, and lookup()/
    // convert() then pick the rung that applies to their amount.
    const first = rungs[0];
    return {
      quoted: true,
      rate: first.rate,
      measuredAtSize: first.size,
      gasCostUsd: first.gasCostUsd,
      gasPctOfNotional: first.gasPctOfNotional,
      legCount: first.legCount,
      rungs,
    };
  }
  if (routedButEmpty) {
    const top = ladder[ladder.length - 1];
    return {
      quoted: false,
      reason: 'gas_exceeds_notional',
      detail: `a route exists, but the guaranteed output was zero at every size up to ${top}. this is a different fact from no_liquidity and a caller should say so: the pair is tradeable, the trade is just too small to survive the flat gas.`,
    };
  }
  return { quoted: false, reason: 'no_liquidity' };
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Resolve which token actually represents each currency, by measurement.
 * Returns { [ISO]: { canonical, candidates, ...measurement } | { canonical: null, ... } }
 */
export async function resolveCanonical(hubToken, tokens, markets, opts = {}) {
  const reachable = new Set(counterpartsOf(markets, hubToken.symbol));
  const grouped = groupByCurrency(tokens);
  const out = {};

  for (const [iso, list] of Object.entries(grouped)) {
    const candidates = list.map((t) => t.symbol);
    if (iso === hubToken.currency) {
      out[iso] = { currency: iso, canonical: hubToken.symbol, candidates, isHub: true, rate: 1, measuredAtSize: 0, gasCostUsd: 0, gasPctOfNotional: 0 };
      continue;
    }
    const tradeable = list.filter((t) => reachable.has(t.symbol));
    const floor = (opts.ladder || DEFAULT_LADDER)[0];
    let best = null;
    let lastReason = null;
    let lastDetail = null;
    for (const t of tradeable) {
      const m = await measure(hubToken, t, opts);
      if (!m.quoted) { lastReason = m.reason; lastDetail = m.detail; }
      if (m.quoted && (best === null || m.measuredAtSize < best.measuredAtSize)) {
        best = { ...m, symbol: t.symbol };
      }
      // Nothing can beat the smallest rung, so stop asking. A currency with ten
      // listed tokens would otherwise cost ten ladders every rebuild, against a
      // public endpoint, to re-learn something already known.
      if (best && best.measuredAtSize === floor) break;
    }
    out[iso] = best
      ? { currency: iso, canonical: best.symbol, candidates, ...best }
      : {
          currency: iso,
          canonical: null,
          candidates,
          quoted: false,
          // Carry the measured reason rather than flattening everything to
          // no_liquidity: "there is no market" and "there is a market that
          // guarantees nothing at this size" are different answers, and the
          // second one is actionable -- send more.
          reason: tradeable.length ? lastReason || 'no_liquidity' : 'no_market',
          ...(tradeable.length && lastDetail ? { detail: lastDetail } : {}),
        };
    delete out[iso].symbol;
  }
  return out;
}

/**
 * Build the served table. `asOf` must be supplied by the caller so the result is
 * deterministic and testable; nothing in here reads the clock.
 */
export async function buildTable({ hub = 'USDC', asOf, ...opts } = {}) {
  const [tokens, markets] = await Promise.all([fetchTokens(opts), fetchMarkets(opts)]);
  const bySymbol = Object.fromEntries(tokens.map((t) => [t.symbol, t]));
  const hubToken = bySymbol[hub];
  if (!hubToken) throw new Error(`hub token ${hub} not in the registry`);

  const currencies = await resolveCanonical(hubToken, tokens, markets, opts);
  const priced = Object.values(currencies).filter((c) => c.canonical).length;

  return {
    asOf,
    hub: hubToken.symbol,
    hubCurrency: hubToken.currency,
    direction: `${hubToken.currency} -> quoted currency`,
    tokensListed: tokens.length,
    currenciesListed: Object.keys(currencies).length,
    currenciesPriced: priced,
    currencies,
  };
}

/**
 * Look up one rate. Always returns a shape the caller can act on: either a rate
 * with the size it was measured at, or null with a reason.
 */
export function rungFor(currency, amount) {
  const rungs = currency.rungs;
  if (!rungs || !rungs.length) {
    return { rate: currency.rate, size: currency.measuredAtSize, gasCostUsd: currency.gasCostUsd, gasPctOfNotional: currency.gasPctOfNotional };
  }
  if (amount == null) return { ...rungs[0], size: rungs[0].size };
  let pick = null;
  for (const r of rungs) if (r.size <= amount) pick = r;
  if (pick) return { ...pick };
  // Asked about less than the smallest size that priced. Answer with the
  // smallest measured rung and say so, rather than extrapolating downward --
  // the cost curve is steepest exactly there, so a guess would be worst
  // precisely where it is most expensive to be wrong.
  return { ...rungs[0], belowSmallestMeasuredSize: true };
}

export function lookup(table, from, to, amount) {
  if (from === to) return { ok: true, from, to, rate: 1, measuredAtSize: 0, gasCostUsd: 0 };
  if (from !== table.hubCurrency) {
    return { ok: false, from, to, rate: null, reason: 'unsupported_direction', detail: `this table only serves ${table.hubCurrency} as the source currency, because a rate measured one way cannot be inverted` };
  }
  const c = table.currencies[to];
  if (!c) return { ok: false, from, to, rate: null, reason: 'unknown_currency' };
  if (!c.canonical) return { ok: false, from, to, rate: null, reason: c.reason || 'no_liquidity', candidates: c.candidates };
  const r = rungFor(c, amount);
  return {
    ok: true, from, to,
    rate: r.rate,
    token: c.canonical,
    measuredAtSize: r.size,
    gasCostUsd: r.gasCostUsd,
    gasPctOfNotional: r.gasPctOfNotional,
    ...(r.belowSmallestMeasuredSize ? { belowSmallestMeasuredSize: true, detail: `nothing priced below ${r.size}, so this is the ${r.size} rung and your size is smaller. treat it as an upper bound on what you would receive.` } : {}),
    ...(c.rungs ? { ladder: c.rungs.map((x) => ({ size: x.size, rate: x.rate })) } : {}),
  };
}

/**
 * Convert an amount, and state the all-in cost honestly.
 * Gas is flat, so its share of the trade falls as the trade grows. A caller that
 * only ever sees a percentage will misprice small transfers badly.
 */
export function convert(table, from, to, amount) {
  const r = lookup(table, from, to, amount);
  if (!r.ok) return r;
  const protocolFeePct = 0.14;
  const gas = r.gasCostUsd ?? 0;
  const allInPct = amount > 0 ? protocolFeePct + (gas / amount) * 100 : null;
  return {
    ...r,
    amount,
    result: amount * r.rate,
    cost: {
      protocolFeePct,
      flatGasUsd: gas,
      allInPct,
      note: 'gas is a flat USD amount, so all-in cost is a curve rather than a rate. quote it with the size it applies to.',
    },
  };
}
