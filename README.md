# sera-fx-rates

**An FX rates layer over Sera's on-chain book that returns `null` when the book
won't price, instead of a rate nobody can fill.**

Sera's [FREE-FX-Rates](https://github.com/sera-cx/FREE-FX-Rates-by-Sera.CX) ships with
`LIVE_RATES_ENABLED = false`, a `topOfBook` whose body returns `null` with a TODO, and a
`loadRatesFromSera` that is commented out. Two functions and a flag. The repo's own notes
explain why the flag is off: the core API is a signed on-chain orderbook with no CORS, so
a server-side layer has to exist before a browser can read a rate at all.

That is the transport problem, and it is the easy half. The hard half is deciding what a
rate *means* when the book behind it is thin, one-directional, and spread across ten
tokens per currency. This repo is an answer to that, not to the plumbing.

## The correction that shaped this repo

I published a finding that the flat gas cost made Sera price worse for small
senders. **That was wrong, and it was wrong because of a parameter I had not
read.**

`POST /swap/quote` takes `gas_mode`, documented at
[docs.sera.cx/swaps](https://docs.sera.cx/swaps/). It defaults to
`receive_less`, which deducts the flat gas from your **output**. Measured that
way, the same book looks like it prices worse the smaller you go:

| you send | gas_mode | you receive | implied rate |
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
penalty. The curve I measured was a fixed cost being netted out of the output,
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

The general lesson, which I have now paid for three times: **a repeatable,
consistent wrong number is evidence of a systematic input error before it is
evidence of a broken system.**

## Three rules, each one a measurement rather than a preference

**1. A rate without a size attached is not a rate.**
The table above is the venue stating this itself. Every quote carries a 0.14% protocol fee
*and* a flat `gas_cost_usd` of $1.00, so the all-in cost is a curve: about 10.1% on a $10
transfer, 1.14% on $100, 0.24% on $1,000, 0.15% on $10,000. Quoting the 0.14% alone is
quoting a third of the answer. `/convert` returns the fee, the flat gas, and the all-in
percentage *for the amount you asked about*, plus the size the rate was measured at.

**2. A rate is directional.**
`USDC -> MYRT` prices. `MYRT -> USDC` returns `no_liquidity` at every size. Same pair. An
order book has bids and asks and there is no rule that both sides are populated. A service
that publishes one mid and lets clients invert it is serving an order that is not there —
and it will do that most confidently on exactly the thinnest pairs, because those are where
one side dries up first. `/latest?from=SGD` here returns a 400 explaining why, not an
inverted number.

**3. The canonical token for a currency is empirical.**
Sera's worker sketch carries `ISO_TO_TOKEN = { USD: 'USDC', EUR: 'EURC' }` with a comment
asking someone to confirm whether the euro should be `EURC` or `EUR0`. It cannot be
confirmed by hand. EUR has **ten** listed tokens — `EUR0, EURAU, EURC, EURE, EURI, EUROP,
EURQ, EURR, EURS, VEUR` — and not one of them returned a quote against USDC at any size on
a $1 / $10 / $100 / $1,000 ladder, on 23 or 26 August. A hardcoded `EURC` would have served
a rate for a pair that cannot fill. Here the canonical token is whichever one prices at the
smallest size right now, and when none of them do the answer is `null`.

## Endpoints

```
GET /health                      up, table age, and whether it has gone stale
GET /currencies                  every ISO code, and the token that actually prices it
GET /latest?from=USD             all outbound rates, nulls included with reasons
GET /convert?from=USD&to=SGD&amount=200
```

A currency the book will not price is **HTTP 200 with `rate: null` and a reason**. It is a
real answer. A currency that does not exist is a 404 and a malformed request is a 400, so a
caller can tell the three apart. Before the first measurement completes every data endpoint
returns 503 rather than inventing a table.

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

Those ladder figures are a real measurement of USD to SGD taken on 26 August 2026, and
they are the reason `/convert` does not serve one number. **The rate is picked from the
rung that applies to your amount**, not from whichever rung happened to price first: a
$200 transfer is quoted off the $100 rung, and quoting it off the $10 rung would have
understated the result by 9.2%.

An amount below the smallest rung that priced is answered with that rung and flagged
`belowSmallestMeasuredSize`. It is an upper bound on what you would receive, never an
extrapolation — the curve is steepest exactly there, so a guess would be worst precisely
where being wrong costs the most.

Two failure reasons that look alike and are not:

- `no_liquidity` — nothing will route this pair at any size on the ladder. Go elsewhere.
- `gas_exceeds_notional` — the pair routes fine, but the guaranteed output was zero at
  every size tried, because the flat gas ate the trade. **Send more.**

Collapsing the second into the first throws away the only actionable thing you could have
told the caller.

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
corridor that actually works would have been served to callers as `rate: 0` — worse than
`null`, because a caller checking for a number gets one and a caller checking truthiness
silently falls back to something else.

The fixtures had a realistic `minOutputAmount` in them because I wrote them from what I
expected the API to do. Twenty-two tests passed against my own assumptions. An offline
suite can only prove that the code agrees with your beliefs about the system; the venue is
the only thing that can test the beliefs.

Fixed in `measure()`: a non-positive floor is treated as unpriced **at that size**, the
ladder keeps climbing, and a pair that routes-but-guarantees-nothing at every rung reports
`gas_exceeds_notional` rather than `no_liquidity`. Regression tests encode the live shape,
including a fixture that returns HTTP 200 with a zero floor — the old fixture returned a
400 there, which is precisely why the bug survived.

Then a third pass found the real mistake, and it was not in the code. Every measurement
above had been taken without `gas_mode`, so the API applied its documented default and
netted the flat cost out of the output. I read the resulting curve as the venue pricing
small transfers worse, and published that. It is not what the numbers say — see [the
correction](#the-correction-that-shaped-this-repo) at the top. `measure()` still walks the
whole ladder, because a caller should be able to *see* that the rate holds across sizes
rather than trust me about it, but it now measures with `pay_more` by default.

**Read the request schema before you interpret the response.** Two rounds of careful
work on top of one unread parameter produced a confident, reproducible, wrong conclusion,
and reproducibility made it feel more true rather than less.

Reproducing a live run is awkward and the reason is the same wall that makes this layer
necessary: `api.sera.cx` sends **no** `access-control-allow-origin` header, on any
response, so a browser on any other origin cannot call it, and a general-purpose sandbox
usually cannot reach it either. The run behind these numbers was executed from a document
served by `api.sera.cx` itself, which is the one browser context where same-origin applies.
From a server this is a non-issue — which is the whole argument for a server-side layer.

## Design notes

**`no_liquidity` is data, not an error.** It arrives as an HTTP 400. A client that treats
every non-200 as a failure cannot tell an empty book from a broken deploy — so it will page
someone at 3am because a pair is thin, or worse, serve stale numbers through a real outage.
Here `no_liquidity` is returned as a result and everything else that fails throws.
`measure()` reports `upstream_error` separately for the same reason.

**Integer maths throughout.** Amounts scale with `BigInt`, never `amount * 10 ** decimals`,
which loses precision above 2^53 and quietly mis-scales 18-decimal tokens.

**Both legs of every market.** `counterpartsOf` matches the hub as base *or* quote. Filtering
one leg undercounts the book — it is how a first pass at the probe counted 27 markets when
the honest number was 39, missing `USDT`, which was one of the three that actually priced.

**Nothing reads the clock.** `buildTable` takes `asOf` from the caller, so a table is
reproducible and the tests are deterministic.

Related: [sera-liquidity-probe](https://github.com/0xmintmee/sera-liquidity-probe) is the
measurement tool the rules above came out of.

## Licence

MIT
