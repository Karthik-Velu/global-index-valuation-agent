# Global Index Valuation Agent

Finds where the world's equity value and opportunity is, across **~90 indices**
(58 countries + US sectors, styles, regions and broad benchmarks), and surfaces the
handful of calls worth your attention — so you spend a minute, not an afternoon.

Everything is scored **within its peer group** (`kind`): countries rank against
countries, sectors against sectors. Adding US sectors never distorts the country
comparison. The dashboard's **Focus** control switches the whole view between
lenses (Countries / Sectors / Styles / Regions / Broad).

It is built as an **agent, not a report generator**: every run records a
prediction, and later runs grade those predictions against what the market
actually did. That market feedback — plus your own pin/dismiss/rating feedback —
is fed back into what gets surfaced.

---

## What it answers

1. **Sources every major index** (Phase 1: index level via consistent ETF proxies).
2. **Computes valuation** — P/E, P/B, P/S, P/CF, dividend & earnings yield.
3. **"Cheap and good value"** — a within-peer-group **Value score** (with value-trap guards).
4. **"High growth potential"** — a **Growth score** built from the *fundamentals*
   (revenue + earnings growth of each index's top holdings, blended with forward
   analyst estimates) — **not** stock-price momentum. Surfaced as a "high growth"
   tag and a **Value × Growth** map.
5. **"Cheap AND growing, not overvalued"** — a true-GARP **Opportunity score**
   (value 40% + fundamental growth 40% + momentum 12% + mean-reversion 8%) that
   gates out the richest cohort. The "💎 GARP" flag marks the sweet spot.

### How fundamental growth is measured (cheaply)
Index-level forward earnings growth isn't available free, and Yahoo's ETF
"3-yr earnings growth" field is empty for international ETFs. So instead of a
price-momentum proxy, the engine does a **bounded mini-bottom-up**: it takes each
index's **top ~10 cap-weighted holdings**, pulls each stock's revenue growth,
earnings growth, and forward analyst estimate, de-dupes across all indices (so each
stock is fetched once), winsorizes outliers, and weights back up to an index-level
growth number. Full top-1000 constituent growth lands in Phase 2.

---

## Cost model (why it's cheap)

The expensive thing in an AI product is putting a model in the data loop. We don't.

| Layer | Who does it | Cost |
|---|---|---|
| Fetch, parse, compute metrics, score, rank | **Deterministic Python** | ~free |
| Per-market one-line tag (high volume) | **Haiku** (cheap tier) | tiny |
| One top-level strategist brief per run | **Opus** (smart tier) | tiny |

The LLM only ever sees the final ≤50-row scoreboard. With no `ANTHROPIC_API_KEY`
set, the model layer is skipped entirely and deterministic fallbacks fill in — the
whole product still runs for **$0**. This is the "differential models" design:
cheap model for the cheap job, smart model for the one job that needs it.

---

## Quick start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 1. Build the data (fetch + score + write data/dashboard_data.json)
python -m engine.cli refresh --no-cache

# 2. Launch the dashboard
uvicorn engine.api:app --port 8000
# open http://localhost:8000
```

Optional — turn on the LLM narrative (Haiku tags + Opus brief):

```bash
cp .env.example .env   # then paste your ANTHROPIC_API_KEY
python -m engine.cli refresh --no-cache   # now with_llm by default
```

CLI extras:

```bash
python -m engine.cli accuracy                       # model track record so far
python -m engine.cli feedback market brazil pin     # record feedback from the terminal
```

---

## The two feedback loops

- **Market feedback** (`engine/ledger.py`): each run writes a prediction
  (value/opportunity score + the proxy's price) to SQLite. Later runs compute the
  realized forward return per market and score the ranking with a Spearman rank-IC
  and a top-vs-bottom-quartile hit rate. Shown live in the header as "track record".
  Accuracy accrues automatically as you re-run over days/weeks.
- **User feedback**: pin / dismiss / 👍 / 👎 on insights and markets writes to the
  same ledger and nudges what surfaces next time (`engine/surfacing.py`).
- **Auto-tuning** (`engine/tuning.py`): each run measures the rank-IC of every
  opportunity component (value / momentum / mean-reversion) against realized forward
  returns and shifts the weights toward what actually worked — blended 70/30 with the
  priors so it adapts without overfitting. Safe by construction: a no-op until there
  are ≥ 4 graded runs, with the effective weights pinned in `data/weights.json` and
  shown in the dashboard header ("⚙ auto-tuned"). Feed it with a weekly refresh:

  ```bash
  # scripts/weekly_refresh.sh re-fetches, scores, grades, and re-tunes.
  crontab -e   # then (use this repo's absolute path):
  0 7 * * 1 /path/to/Agent/scripts/weekly_refresh.sh >> /path/to/Agent/data/cron.log 2>&1
  ```

---

## Hosting (GitHub + Vercel)

The dashboard is a **static site** (no build step), so it deploys to Vercel as-is.
The Python engine never runs on Vercel — it would need a long-lived server and the
multi-minute data fetch can't run on a serverless request. Instead:

- The site serves a **published snapshot**, `dashboard/dashboard_data.json`, which is
  committed to the repo. The dashboard tries the local engine API first
  (`/api/dashboard`) and falls back to this static file when there's no API.
- `vercel.json` serves `dashboard/` statically; `.vercelignore` keeps the engine,
  data, and tooling out of the deploy.
- Feedback still works on the hosted site — it persists to `localStorage` (the
  authoritative feedback loop + auto-tuning run in the local engine / CI).
- **Data stays fresh automatically**: `.github/workflows/refresh.yml` re-runs the
  engine every Monday, commits the new snapshot, and (optionally) pings a Vercel
  deploy hook. This is the cloud version of `scripts/weekly_refresh.sh`.

For auto-redeploy on each weekly commit, either connect the GitHub repo in the Vercel
dashboard, or create a Vercel **Deploy Hook** and add it as the repo secret
`VERCEL_DEPLOY_HOOK`.

## Architecture

```
engine/
  universe.py    # the markets (index -> liquid ETF proxy). Add rows to expand toward 100.
  datasource.py  # free Yahoo data, normalised + cached in SQLite (the dumb fetch layer)
  metrics.py     # value / momentum / mean-reversion / opportunity scores, ranked WITHIN kind
  surfacing.py   # picks the few insights worth surfacing (per kind); honours user feedback
  ledger.py      # prediction ledger + market-feedback scoring + user feedback
  tuning.py      # feedback-driven auto-tuning of the opportunity weights
  llm.py         # differential model router (Haiku tags, Opus brief) — optional
  pipeline.py    # orchestration -> writes data/dashboard_data.json
  api.py         # FastAPI: serves dashboard + JSON + feedback writes
  cli.py         # refresh / accuracy / feedback
dashboard/       # single-page UI (no build step): focus lens, insights, value×momentum
                 #   map, regional heatmap, scoreboard, drill-down, feedback
scripts/
  weekly_refresh.sh  # cron/launchd entry point that feeds the auto-tuner
data/            # SQLite ledger + cache + dashboard_data.json (gitignored)
```

`data/dashboard_data.json` is the single contract between engine and UI.

---

## Phases

- **Phase 1 (done): index level.** ~50 markets via single-methodology ETF proxies
  so valuations are truly comparable across countries. Growth signal = momentum +
  mean-reversion (forward EPS isn't reliably free at index level).
- **Phase 2: full bottom-up.** Replace each index's `proxy` with its constituent
  list (top ~1000 stocks, ≤5 indices/country), compute per-stock fundamentals, and
  aggregate (median + cap-weighted) behind the *same* `Index` interface — nothing
  downstream changes. This unlocks true forward-growth/PEG opportunity scoring and
  stock-level drill-down.

### Notes / honesty

- ETF "Price/X" fields from Yahoo are stored as reciprocals; we invert them. Spot-
  checked against known levels (US ~27, China ~10, Brazil ~13) — sane.
- Scores are **relative within each run's universe**, which is the right frame for
  an allocation call but means they shift as the universe expands.
- Free Yahoo data is unofficial and occasionally rate-limits; the SQLite cache makes
  re-runs resilient.
