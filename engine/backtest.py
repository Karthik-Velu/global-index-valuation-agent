"""Walk-forward backtest — does the value/growth/GARP score predict forward returns?

At each historical rebalance date t (WEEKLY, see REBALANCE_FREQ below), scores the
whole stock universe using ONLY data knowable as of t (stockvaluation.score_frame ->
tierb.metrics_asof + prices <= t, no look-ahead), then measures each signal's
forward return at FIXED horizons (1/3/6/12 months) against price data already
sitting in Tier B — never fetched fresh for a specific horizon, which is an easy
way to open a look-ahead door by accident. Aggregates rank-IC (does the score
predict the return?), hit-rate (top quartile beat bottom quartile?), and decile
spread across all rebalance dates, with an IC-population guard (a period only
counts with enough cross-sectional breadth) and a lightweight significance check
(t-stat on the per-period IC series).

This is Pillar 2 / ROADMAP.md's "Initial (historical, walk-forward, point-in-time)"
backtest. Known gaps (documented, not silent):
  * No survivorship-bias control — our universe is CURRENT SEC filers, so a company
    that delisted before being ingested is simply absent from the whole backtest.
  * No transaction costs, no benchmark-relative Sharpe (needs an index-level price
    series over the same window — a documented follow-up, not built here).
  * The significance check is a simple one-sample t-stat on the period-IC series,
    not a formal Newey-West/autocorrelation-adjusted test (no scipy/statsmodels
    dependency yet) — treat `significant` as a rough gate, not a rigorous p-value.
  * REBALANCE_FREQ="W-FRI" (ADR-022, 2026-07-25): weekly, not monthly. Adjacent
    periods' forward-return windows overlap heavily (a 1m-forward return measured
    a week apart shares 3/4 of its window with the previous one; 3/6/12m horizons
    overlap even more, and already did at monthly cadence) — this makes the
    per-period IC series SERIALLY CORRELATED, which the t-stat/`significant` gate
    does NOT account for (it assumes independent samples). `n_periods` at weekly
    cadence is a count of overlapping windows, not independent trials — treat
    `significant: true` here as a WEAKER signal than it would be at true-monthly
    cadence with the same n_periods, not a stronger one just because n is bigger.
    Chosen anyway (over waiting ~3 months for organic monthly-period accumulation,
    or a paid data-tier upgrade) because it's free, immediate, and the existing
    gate was already not adjusting for autocorrelation at 3/6/12m horizons even
    at monthly cadence — this doesn't introduce a new class of problem, it makes
    an existing documented one quantitatively worse in exchange for more data to
    look at sooner. A real fix (Newey-West-adjusted effective-N) is future work.

  python -m engine.backtest run
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import db, stockvaluation, tierb
from .config import DATA_DIR

REPORT_PATH = DATA_DIR / "backtest_report.json"

# label -> forward-return lookahead in calendar days (~trading-day horizons
# 21/63/126/252 approximated the same way stockvaluation's momentum features are).
HORIZONS = {"1m": 30, "3m": 91, "6m": 182, "12m": 365}
SIGNALS = ("opportunity_score", "value_score", "growth_score", "momentum_score")
MIN_CROSS_SECTION = 20        # a rebalance date's IC only counts with this many names
PRICE_MATCH_SLACK_DAYS = 10   # how stale a "price near target date" may be
# Weekly (not monthly) — see the module docstring's ADR-022 note for why, and the
# real statistical tradeoff (overlapping-window serial correlation) this accepts.
REBALANCE_FREQ = "W-FRI"


def _spearman(a: np.ndarray, b: np.ndarray) -> float | None:
    if len(a) < 3:
        return None
    ra, rb = pd.Series(a).rank().values, pd.Series(b).rank().values
    if ra.std() == 0 or rb.std() == 0:
        return None
    return float(np.corrcoef(ra, rb)[0, 1])


def _price_near(con, security_ids: list[int], target_date, slack_days=PRICE_MATCH_SLACK_DAYS) -> pd.Series:
    """security_id -> close, for the latest trading day within
    [target_date - slack_days, target_date]. A security absent from the result
    had no qualifying price (delisted, or the window runs past stored history) —
    NaN downstream, never a stale guess from further back."""
    if not security_ids:
        return pd.Series(dtype=float)
    df = con.execute("""
        select security_id, close from prices
        where date <= ? and date >= ?::date - to_days(?)
          and security_id in (select unnest(?::bigint[]))
        qualify row_number() over (partition by security_id order by date desc) = 1
    """, [target_date, target_date, slack_days, security_ids]).df()
    return df.set_index("security_id")["close"] if not df.empty else pd.Series(dtype=float)


def _rebalance_dates(start: str, end: str) -> list[str]:
    return [d.date().isoformat() for d in pd.date_range(start=start, end=end, freq=REBALANCE_FREQ)]


def _default_window() -> tuple[str, str]:
    """Auto-detect a sane backtest window from what Tier B actually holds:
    start = the later of (earliest price, earliest FY filing) + a 90-day buffer;
    end = latest price date minus the longest horizon, so even the 12m forward
    return has real (not fabricated) price data to measure against."""
    st = tierb.stats()
    price_span, period_span = st.get("price_span"), st.get("period_span")
    if not price_span or not period_span:
        raise RuntimeError("backtest needs both prices and fundamentals in Tier B — "
                           "run engine.sources.prices ingest and engine.tierbsync export first")
    start = max(pd.Timestamp(price_span[0]), pd.Timestamp(period_span[0])) + pd.Timedelta(days=90)
    end = pd.Timestamp(price_span[1]) - pd.Timedelta(days=max(HORIZONS.values()))
    return start.date().isoformat(), end.date().isoformat()


def _evaluate_period(scored: pd.DataFrame, asof: str, con) -> dict:
    """One rebalance date -> {horizon: {signal: {n, rank_ic, hit_rate, spread}}}."""
    sids = scored["security_id"].tolist()
    by_sid = scored.set_index("security_id")
    out: dict = {}
    for h_label, h_days in HORIZONS.items():
        target = (pd.Timestamp(asof) + pd.Timedelta(days=h_days)).date().isoformat()
        fwd_price = _price_near(con, sids, target)
        merged = by_sid.join(fwd_price.rename("fwd_price"), how="inner")
        merged = merged[merged["price"] > 0]
        merged["fwd_ret"] = merged["fwd_price"] / merged["price"] - 1.0
        out[h_label] = {}
        for sig in SIGNALS:
            d = merged[[sig, "fwd_ret"]].dropna()
            if len(d) < MIN_CROSS_SECTION:
                continue
            ic = _spearman(d[sig].values, d["fwd_ret"].values)
            if ic is None:
                continue
            order = d[sig].sort_values()
            q = max(1, len(d) // 4)
            bottom_ret, top_ret = d.loc[order.index[:q], "fwd_ret"].mean(), d.loc[order.index[-q:], "fwd_ret"].mean()
            out[h_label][sig] = {"n": len(d), "rank_ic": round(ic, 4),
                                 "hit_rate": float(top_ret > bottom_ret),
                                 "top_q_ret": round(float(top_ret), 4),
                                 "bottom_q_ret": round(float(bottom_ret), 4),
                                 "spread": round(float(top_ret - bottom_ret), 4)}
    return out


def _aggregate(periods: list[dict]) -> dict:
    """Per (horizon, signal): mean rank-IC across rebalance dates, % positive,
    a rough t-stat (mean / (std/sqrt(n))), and the IC-population/significance
    gates ROADMAP.md and ARCHITECTURE.md's Phase-0 checklist call for."""
    summary: dict = {}
    for h_label in HORIZONS:
        summary[h_label] = {}
        for sig in SIGNALS:
            ics = [p[h_label][sig]["rank_ic"] for p in periods if h_label in p and sig in p[h_label]]
            hits = [p[h_label][sig]["hit_rate"] for p in periods if h_label in p and sig in p[h_label]]
            if not ics:
                summary[h_label][sig] = {"n_periods": 0}
                continue
            arr = np.array(ics)
            std = arr.std(ddof=1) if len(arr) > 1 else 0.0
            t_stat = float(arr.mean() / (std / np.sqrt(len(arr)))) if std > 0 else None
            summary[h_label][sig] = {
                "n_periods": len(ics),
                "mean_rank_ic": round(float(arr.mean()), 4),
                "pct_positive_ic": round(float((arr > 0).mean()), 3),
                "mean_hit_rate": round(float(np.mean(hits)), 3),
                "t_stat": round(t_stat, 2) if t_stat is not None else None,
                # rule of thumb, not a formal test: below |t|=2 with >=12 periods
                # we do NOT claim the signal predicts anything.
                "significant": bool(t_stat is not None and abs(t_stat) >= 2.0 and len(ics) >= 12),
            }
    return summary


def run(start: str | None = None, end: str | None = None,
       security_ids: list[int] | None = None) -> dict:
    print("== Stock backtest (walk-forward, point-in-time) ==")
    if not tierb.enabled():
        raise RuntimeError("backtest needs Tier B (prices + fundamentals) — none found")
    if not start or not end:
        auto_start, auto_end = _default_window()
        start, end = start or auto_start, end or auto_end
    dates = _rebalance_dates(start, end)
    print(f"   window {start} .. {end} — {len(dates)} rebalance dates ({REBALANCE_FREQ} cadence)")

    con = tierb.connect()
    periods: list[dict] = []
    for i, t in enumerate(dates, 1):
        scored = stockvaluation.score_frame(t, security_ids=security_ids)
        if scored.empty:
            continue
        scored = scored.dropna(subset=["price"])
        if len(scored) < MIN_CROSS_SECTION:
            continue
        ev = _evaluate_period(scored, t, con)
        if any(ev[h] for h in ev):
            periods.append({"asof": t, **ev})
        if i % 6 == 0:
            print(f"   evaluated {i}/{len(dates)} rebalance dates ({len(periods)} usable)")

    if len(periods) < 3:
        result = {"status": "insufficient_data", "window": [start, end], "usable_periods": len(periods),
                  "cadence": REBALANCE_FREQ,
                  "reason": f"only {len(periods)} rebalance date(s) had enough cross-sectional "
                           f"breadth (>= {MIN_CROSS_SECTION} names with both a score and a "
                           f"forward return) — need at least 3 to say anything about skill."}
        print(f"   {result['reason']}")
        _persist(result, start, end)
        return result

    summary = _aggregate([{k: v for k, v in p.items() if k != "asof"} for p in periods])
    result = {"status": "completed", "window": [start, end], "usable_periods": len(periods),
              "cadence": REBALANCE_FREQ,
              "significance_caveat": ("n_periods counts OVERLAPPING weekly windows, not "
                                      "independent trials — the t-stat/significant gate does not "
                                      "adjust for the resulting serial correlation. See ADR-022 / "
                                      "this module's docstring before treating significant=true "
                                      "as rigorous.") if REBALANCE_FREQ != "MS" else None,
              "summary": summary, "periods": periods}
    _persist(result, start, end)
    best = max(((h, s, summary[h][s]["mean_rank_ic"]) for h in HORIZONS for s in SIGNALS
               if summary[h][s].get("n_periods")), key=lambda x: x[2], default=None)
    if best:
        h, s, ic = best
        print(f"   strongest signal: {s} @ {h} — mean rank-IC {ic:.3f} over "
              f"{summary[h][s]['n_periods']} periods (significant={summary[h][s]['significant']})")
        if summary[h][s]["significant"] and result.get("significance_caveat"):
            print(f"   NOTE: {result['significance_caveat']}")
    return result


def _persist(result: dict, start: str, end: str) -> None:
    report = {"generated_at": datetime.now(timezone.utc).isoformat(), **result}
    REPORT_PATH.write_text(json.dumps(report, indent=2, default=str))
    print(f"   wrote {REPORT_PATH}")
    if not db.have_db():
        return
    # metrics carries both the aggregate summary AND the per-period detail so
    # a real run is fully introspectable from Postgres alone — CI artifact
    # downloads are one more thing that can be unreachable (this session's
    # sandboxed egress blocks them outright), so backtest_runs is the
    # source of truth, not a convenience mirror of the JSON report.
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select id from data_versions order by ts desc limit 1")
        row = cur.fetchone()
        cadence = result.get("cadence", "MS")
        cur.execute(
            """insert into backtest_runs (data_version_id, window_start, window_end, status, metrics, note)
               values (%s,%s,%s,%s,%s,%s)""",
            (row[0] if row else None, start, end, result["status"],
             json.dumps({"summary": result.get("summary", {}),
                        "periods": result.get("periods", []),
                        "cadence": cadence,
                        "significance_caveat": result.get("significance_caveat")}, default=str),
             f"stock-level walk-forward backtest, {result.get('usable_periods', 0)} periods "
             f"({cadence} cadence)"))
        conn.commit()


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(prog="engine.backtest", description="Walk-forward stock backtest")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run the walk-forward backtest")
    r.add_argument("--start", help="ISO date, default: auto-detected from Tier B coverage")
    r.add_argument("--end", help="ISO date, default: auto-detected from Tier B coverage")
    a = p.parse_args()
    if a.cmd == "run":
        run(start=a.start, end=a.end)
