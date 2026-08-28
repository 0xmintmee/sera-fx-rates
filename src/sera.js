/**
 * Client for the three PUBLIC endpoints on Sera's core API.
 *
 * No API key. GET /tokens, GET /markets and POST /swap/quote are all open, which
 * is what makes a server-side rates layer possible without credentials at all.
 * The authenticated orderbook endpoints (/orders, /fills, /balances) are not used
 * here and are not needed.
 */

export const DEFAULT_BASE = 'https://api.sera.cx/api/v1';

/** Taker/recipient used when asking for a price we never intend to fill. */
export const PROBE_ADDRESS = '0x0000000000000000000000000000000000000001';

export class SeraApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'SeraApiError';
    this.status = status;
    this.body = body;
  }
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) throw new SeraApiError(`GET ${url} failed`, { status: res.status, body });
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTokens(opts = {}) {
  const base = opts.base || DEFAULT_BASE;
  const { tokens } = await getJson(`${base}/tokens`, opts);
  if (!Array.isArray(tokens)) throw new SeraApiError('unexpected /tokens shape', { body: tokens });
  return tokens;
}

export async function fetchMarkets(opts = {}) {
  const base = opts.base || DEFAULT_BASE;
  const { markets } = await getJson(`${base}/markets`, opts);
  if (!Array.isArray(markets)) throw new SeraApiError('unexpected /markets shape', { body: markets });
  return markets;
}

/**
 * Ask the router for a quote. Public, keyless, and a pure read: nothing is
 * signed, nothing is submitted, no funds move.
 *
 * Returns { quoted: true, minOutputRaw, gasCostUsd, legCount }
 *      or { quoted: false, reason: 'no_liquidity' }
 *
 * no_liquidity arrives as HTTP 400 with { detail: { success:false, error:'no_liquidity' } }.
 * That is an answer about the book, not a transport failure, so it is returned
 * rather than thrown. Everything else that fails throws, so a broken deploy can
 * never be read as an empty book.
 */
export const DEFAULT_GAS_MODE = 'pay_more';

export async function fetchQuote({ fromToken, toToken, fromAmountRaw }, opts = {}) {
  const base = opts.base || DEFAULT_BASE;
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now ? opts.now() : Date.now();
  // gas_mode is documented at docs.sera.cx/swaps and it is NOT optional detail.
  // 'receive_less' (the API default) deducts the flat gas from the output;
  // 'pay_more' adds it to the input. Measuring a RATE means pay_more, because
  // receive_less mixes the price with a fixed cost and makes the rate look
  // size-dependent when it is not. See the README for what that cost me.
  const gasMode = opts.gasMode || DEFAULT_GAS_MODE;

  const res = await fetchImpl(`${base}/swap/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_token: String(fromToken).toLowerCase(),
      to_token: String(toToken).toLowerCase(),
      from_amount: String(fromAmountRaw),
      owner_address: PROBE_ADDRESS,
      recipient: PROBE_ADDRESS,
      expiration: Math.floor(now / 1000) + 3600,
      gas_mode: gasMode,
    }),
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!res.ok) {
    if (isNoLiquidity(body)) return { quoted: false, reason: 'no_liquidity' };
    throw new SeraApiError('POST /swap/quote failed', { status: res.status, body });
  }
  if (body && body.no_liquidity) return { quoted: false, reason: 'no_liquidity' };

  const rp = body && body.route_params;
  if (!rp || rp.minOutputAmount == null) {
    throw new SeraApiError('quote succeeded but carried no route_params.minOutputAmount', { body });
  }

  return {
    quoted: true,
    minOutputRaw: String(rp.minOutputAmount),
    gasCostUsd: body.fee_breakdown ? Number(body.fee_breakdown.gas_cost_usd) : null,
    legCount: body.route_metadata ? body.route_metadata.leg_count : null,
  };
}

export function isNoLiquidity(body) {
  if (!body) return false;
  const d = body.detail ?? body;
  if (typeof d === 'string') return d.includes('no_liquidity');
  return d && d.error === 'no_liquidity';
}
