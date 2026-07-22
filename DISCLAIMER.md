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
