# Disclaimer

**Please read this before using the Global Index Valuation Agent or relying on any of
its output.**

## Not investment advice

This software and its output (scores, rankings, "value", "growth", "GARP" and
"opportunity" labels, briefs, and any other content) are provided for **informational
and educational purposes only**. They are **not**:

- investment, financial, legal, tax, or accounting advice;
- a recommendation, solicitation, or offer to buy, sell, or hold any security, fund,
  index, or other financial instrument;
- a personalized assessment of suitability for any individual's circumstances.

Nothing here should be construed as advice to act. **Do your own research** and consult a
licensed financial professional before making any investment decision.

## Experimental and unvalidated

The methodology is **experimental**. A first out-of-sample, point-in-time walk-forward
backtest of the stock-level scores has run against real market data (2026-07-22, ~9
monthly rebalance periods) — see `docs/STATUS.md` for the full results. Early results are
directionally encouraging for the combined opportunity score, but **no signal has yet
cleared the significance gate** (too few periods so far), and the backtest window itself
is short. There is **not yet sufficient evidence** that the rankings predict future
returns. The "track record" / accuracy metrics, where shown, are early-stage and may be
statistically insignificant.

## Data limitations

The system relies on **free, third-party data** that may be **incomplete, delayed,
inaccurate, or wrong**, and on **proxies** (e.g. ETFs standing in for indices) that do not
perfectly represent the underlying markets. Coverage is uneven, especially outside the US.
Bugs, outages, and data errors are expected.

## No warranty; no liability

This software is provided **"as is", without warranty of any kind** (see [LICENSE](LICENSE)).
The authors and contributors accept **no liability** for any loss or damage arising from
its use, including any investment losses. **You use it entirely at your own risk.**

## Data licensing is the operator's responsibility

Different data sources have different terms — some prohibit redistribution or commercial
use. When deploying or sharing this software or its output, **you** are responsible for
complying with each upstream source's terms of service and license (see the license notes
in `engine/sources/seed_catalog.json` and the data-ingestion agent).

## Markets are risky

The value of investments can go down as well as up, and you may get back less than you
invested. Past performance is not indicative of future results.

## Currency conversion is indicative only

The optional display-currency selector converts USD-native figures (stock price, market
cap) using **daily reference rates** (Frankfurter/ECB), for **readability only**. These are
**not** live, tradable, or execution rates, do not include any spread, fee, or slippage a
broker would apply, and may be stale by up to a day. Every score, ranking, and ratio (P/E,
P/B, dividend yield, etc.) is computed in the underlying USD figures regardless of the
currency displayed — converting the display currency **never** changes a score. Do not use
these figures to price a trade.

## Accounts, watchlists, and your data

Signing in and saving a personal watchlist are **optional** and **not required** to use the
dashboard. If you sign in, your email and watchlist selections are stored by our
authentication and database provider, [Supabase](https://supabase.com), under its own terms
of service and privacy policy. A saved watchlist is a personal organizational tool only —
it is **not** a recommendation, disclosed holding, or any form of investment advice, and
carries no obligation on our part to notify you of anything about the markets you save.

## "How to invest" is route information, not advice or a recommendation

Each market on the scoreboard is tracked via a **US-listed ETF proxy**, and the drawer
shows that proxy's ticker, its issuer (where we have confirmed it), and a plain-language
description of the **access route** an India-based investor would use — the RBI Liberalised
Remittance Scheme (LRS). This is provided so you can understand *how a position of this
kind would be established*, and is **not**:

- a recommendation to buy, sell, or hold that ETF or any other instrument;
- an endorsement of, or affiliation with, any fund issuer, broker, or platform. We
  deliberately name **no** broker or investing platform. Any SEBI-registered platform
  offering US equity investing under LRS could execute such a trade; choosing among them,
  and the diligence that requires, is entirely yours;
- an offer or solicitation in any jurisdiction, or a statement that any listed instrument
  is suitable, available, or lawful for you to purchase.

Issuer links point to the **issuer's home page only** — we do not deep-link to individual
fund pages, and we do not host, mirror, or vouch for issuer content. The ETF proxy is our
*measurement instrument* for a market's valuation, chosen for methodological consistency;
its appearance here is not a judgement that it is the best, cheapest, or most suitable
vehicle for that exposure.

**Regulatory and tax points are general, time-sensitive, and may be out of date.** LRS
limits, TCS rates and thresholds, capital-gains treatment of foreign assets, ITR
(Schedule FA) reporting duties, and US estate-tax exposure on US-situs assets all change,
and their application depends on your individual circumstances and residency. Nothing here
is tax, legal, or financial advice. **Confirm current rules with a qualified adviser before
acting.**
