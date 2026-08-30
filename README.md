# sera-fx-rates

**A server-side FX rates layer over Sera's public, keyless quote endpoint. It measures
rates instead of assuming them, and serves the rate and the cost as two separate numbers.**

Sera lists a full rates engine on its own public roadmap under the name `sera-fx-rates`.
This repo is a community implementation of the same idea, built in the open against the
public endpoints, and offered to whoever ships the official one.

Everything here runs with no API key and no funded wallet, because
`POST /swap/quote`, `GET /tokens` and `GET /markets` are all public.

## The correction that shaped this repo

I published a finding that the flat gas cost made Sera price differently for small
senders. **That was wrong, and it was wrong because of a parameter I had not read.**

`POST /swap/quote` takes `gas_mode`, documented at
[docs.sera.cx/swaps](https://docs.sera.cx/swaps/). It defaults to
`receive_less`, which deducts the flat gas from your **output**. Measured that
way, the ratio of output to input changes with size:

| you send | gas_mode | you receive | output ÷ input |
|---|---|---|---|
| $1 | `receive_less` | 0 MYRT | — |
| $10 | `receive_less` | 35.485784 | 3.5486 |
| $100 | `receive_less` | 396.718309 | 3.9672 |

Send `pay_more` instead — the flat cost is added to your input rather than taken
out of your output — and the same book, in the same minute, answers:

| you want | gas_mode | you send up to | rate you get |
|---|---|---|---|
| $1 | `pay_more` | 2 USDC | **4.013693** |
| $10 | `pay_more` | 11 USDC | **4.013695** |
| $100 | `pay_more` | 101 USDC | **4.013695** |

**The same rate to six figures across two orders of magnitude.** There is no size
penalty. The curve in the first table is a fixed cost being netted out of the output,
exactly as the docs say it will be — not the price moving.

Measured live on 28 August 2026. `USDC -> XSGD` behaves identically: 1.265798 at
$1, 1.265799 at $100.

Two things follow, and they are why this layer exists:

- **Gas is real on any chain, and Sera prices it into the quote before you sign.**
  `fee_breakdown` itemises it, and you never need to hold ETH. A rail that shows
  you the fixed component is doing something most of the industry does not.
- **A rate and a cost are different numbers and must never be served blended.**
  This layer measures with `pay_more` so the rate means the price, and reports
  the flat cost separately, because a caller needs both.

The general lesson, which I have now paid for three times: **read the request schema
before you interpret the response.** A repeatable, consistent wrong number is evidence
of a systematic input error before it is evidence of anything else.

## Three rules, each one a measurement rather than a preference

**1. A cost is a curve, and a rate is not.**
Every quote carries a 0.14% protocol fee *and* a flat `gas_cost_usd` of $1.00, so the
all-in cost depends on the notional: 1.14% on $100, 0.24% on $1,000, 0.15% on $10,000,
converging on the proportional component as the flat one becomes noise. Quoting the 0.14%
alone is quoting part of the answer, and quoting any single percentage without its
notional is quoting a number that is true at exactly one transfer size.

Done properly the comparison is a strong one: on this pricing a 3% retail bank conversion
is beaten above roughly $35, and the World Bank's 6.36% global average remittance cost is
beaten above roughly $16. `/convert` returns the fee, the flat gas, and the all-in
percentage *for the amount you asked about*, plus the size the rate was measured at.

**2. A rate is directional.**
A quote answers a directed question: what this token buys of that token, at this size, in
this mode. Publishing one mid per pair and letting clients invert it assumes a symmetry the
quote never asserted, and the client several layers away has no idea an inversion happened.
This layer stores and serves rates only in the direction it measured, and names the
direction it has rather than synthesising the one it does not.

**3. The canonical token for a currency is empirical.**
An ISO code does not map cleanly onto one token — the euro alone has ten symbols listed —
and a hardcoded map is correct on the day it is typed and drifts silently afterwards.
Here the canonical token for a currency is resolved by asking: quote each listed candidate
at a small size and keep whichever prices, recording which one was chosen and when. The
requests are free and keyless, so the map is accurate as of the run rather than as of the
commit.

## Endpoints

```
GET /health                      up, table age, and whether it has gone stale
GET /currencies                  every ISO code, and the token measured for it
GET /latest?from=USD             all measured outbound rates
GET /convert?from=USD&to=SGD&amount=200
```

Every answer is machine-readable about its own status. Where the layer has a measured
rate it returns it with the size it was measured at; where it does not, it returns
HTTP 200 with `rate: null` and a `reason` field naming which case applies, so a caller
can branch on it rather than guess. A currency that is not listed at all is a 404 and a
malformed request is a 400, so those three are distinguishable. Before the first
measurement completes, every data endpoint returns 503 rather than inventing a table.
The `reason` enumeration lives in `src/rates.js`.

```jsonc
// GET /convert?from=USD&to=SGD&amount=200
{
  "ok": true, "from": "USD", "to": "SGD",
  "rate": 1.252405, "token": "XSGD", "measuredAtSize": 100,
  "amount": 200, "result": 250.481,
  "ladder": [
    { "size": 10,   "rate": 1.137253 },
    { "size": 100,  "rate": 1.252405 },
    { "size": 1000, "rate": 1.263920 }
  ],
  "cost": {
    "protocolFeePct": 0.14, "flatGasUsd": 1, "allInPct": 0.64,
    "note": "gas is a flat USD amount, so all-in cost is a curve rather than a rate."
  }
}
```

Those ladder figures are a real measurement of USD to SGD taken on 26 August 2026 in the
default gas mode, which is why they vary — see the correction above. **The rate is picked
from the rung that applies to your amount**, not from whichever rung was measured first,
and the whole ladder is returned so a caller can see the shape rather than trust it.

An amount below the smallest rung measured is answered with that rung and flagged
`belowSmallestMeasuredSize`. It is an upper bound on what you would receive, never an
extrapolation.

## Running it

```bash
npm test          # 29 offline tests, no network
npm run dev       # plain node server on :8787
```

Or as a Cloudflare Worker: `wrangler.toml` is included, with a KV namespace bound as
`RATES` and an hourly cron. The table is measured on the schedule and cached — never
rebuilt per request. A full measurement is a couple of hundred quote calls against a public
endpoint, and doing that per request would be both slow for the caller and rude to Sera.

The Worker and the Node server share one handler in `src/http.js`, so the two cannot drift.

## What the live run found

**The layer was wrong on its first contact with the live API, and the offline suite was
green while it was wrong.** That is worth writing down rather than quietly fixing.

The quote client guarded with `if (rp.minOutputAmount == null) throw`. `"0"` is not null,
so a zero floor passed straight through and the rate came out as `0 / 1 = 0`. Every
corridor would have been served to callers as `rate: 0` — worse than `null`, because a
caller checking for a number gets one and a caller checking truthiness silently falls back
to something else.

The fixtures had a realistic `minOutputAmount` in them because I wrote them from what I
expected the API to do. Twenty-two tests passed against my own assumptions. An offline
suite can only prove that the code agrees with your beliefs about the system; the venue is
the only thing that can test the beliefs.

Fixed in `measure()`: a non-positive floor is treated as unpriced **at that size** and the
ladder keeps climbing, and the reason returned distinguishes "the amount was below the
size where this quote clears its fixed cost — send more" from every other case, because
only one of those is actionable. Regression tests encode the live shape, including a
fixture that returns HTTP 200 with a zero floor.

Then a third pass found the real mistake, and it was not in the code. Every measurement
had been taken without `gas_mode`, so the API applied its documented default and netted
the flat cost out of the output. I read the resulting curve as a size effect and published
that — see [the correction](#the-correction-that-shaped-this-repo) at the top. `measure()`
still walks the whole ladder, because a caller should be able to *see* that the rate holds
across sizes rather than trust me about it, but it now measures with `pay_more` by default.

**Two rounds of careful work on top of one unread parameter produced a confident,
reproducible, wrong conclusion, and reproducibility made it feel more true rather than
less.**

The live run behind these numbers was executed from a document served by `api.sera.cx`
itself, so that every request was same-origin. The API is built to be called from a
server, which is exactly what this layer is.

## Design notes

**A missing measurement is data, not an error.** The layer returns it as a result with a
reason, and reserves thrown errors for things that actually went wrong, so a caller can
tell a case it should handle from a case it should page someone about. `measure()` reports
`upstream_error` separately for the same reason.

**Integer maths throughout.** Amounts scale with `BigInt`, never `amount * 10 ** decimals`,
which loses precision above 2^53 and quietly mis-scales 18-decimal tokens.

**Both legs of every market.** `counterpartsOf` matches the hub as base *or* quote.
Filtering one leg undercounts the book — it is how a first pass counted 27 markets when
the honest either-leg number was 39, missing `USDT`.

**Nothing reads the clock.** `buildTable` takes `asOf` from the caller, so a table is
reproducible and the tests are deterministic.

Related: [sera-liquidity-probe](https://github.com/0xmintmee/sera-liquidity-probe) is the
measurement tool the rules above came out of.

## Licence

MIT
