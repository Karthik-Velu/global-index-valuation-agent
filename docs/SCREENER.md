# Screener, AI screen builder, charts, watchlists and alerts

The TradingView-style layer on top of the scores (ADR-037). This page covers how to use it,
the filter language every part of it shares, the field list, how alerts work, and who can
see what (the licensing gate). Design and rejected alternatives are in
[DECISIONS.md](DECISIONS.md) ADR-037.

**Where it lives:** tabs under the header — **Overview** (the existing page), **Screener**
(`#/screener`), **Watchlists** (`#/lists`), **Alerts** (`#/alerts`). Deep links:
`#/stock/<TICKER>`, `#/market/<key>`, `#/screener?s=<share code>`, `#/screener?id=<saved id>`.
The header symbol search jumps to any market or stock.

---

## 1. Using the screener

**Scope switch: Markets | Stocks.**
- **Markets** screens the ~133-row public scoreboard (`dashboard_data.json`) in your
  browser. It works for everyone, signed in or not, and offline once the page has loaded.
- **Stocks** screens the whole scored stock universe (~3,120 names). It is limited to the
  owner (see §6). Everyone else sees a short explanation, and Markets keeps working. The
  universe is a daily snapshot from the data pipeline, not live quotes.

**Building a screen.**
- **Presets** (one click): see §4.
- **Filter chips**: *Add filter* opens a field picker grouped as in §3. Pick an operator
  and a value. Click a chip to edit it, or × to remove it. All conditions are ANDed.
- **AI screen builder**: type a sentence (see §2). The result shows up as chips you
  confirm before it runs.
- **Columns**: the column picker adds/removes result columns. Your choice is remembered
  per scope in this browser and saved with the screen.
- **Results**: sortable columns, a sticky symbol column, score bars and strategy pills.
  The count line reads "Showing 100 of 742 matches". Click a row for its chart drawer.
  The star adds it to a watchlist.

**Hidden rows.** By default a screen hides rows that fail the data checks (`data_ok`).
These are the same rules the dashboard's Top picks use (`engine/picks.py`
`exclusion_reasons`):
- implausible P/E or P/S;
- below the minimum market cap;
- foreign listing (ADR ratios not ingested);
- non-USD reporter;
- under 3 years of history;
- an open data-quality flag (`quality:<check>`).

The line under the results says how many are hidden and why. A stock can have several
reasons, so the counts overlap. *Include rows with data issues* shows them anyway, marked
⚠.

**Saving and sharing.**
- *Save* stores the screen (name + alerts toggle). Signed in, it goes to your account
  (`saved_screens`, up to 50). Signed out, it stays in this browser (up to 10, no alerts).
- *Share link* copies `#/screener?s=…`: the filter only, base64url. A link never contains
  a sentence and never calls the AI.
- *CSV* downloads the visible rows. It is offered only to trusted viewers for Stocks.
  Cells starting with `= + - @` get a leading `'` so a spreadsheet can't run them as
  formulas.
- From Overview, *Open in Screener* turns the scoreboard's current filters into a
  markets screen.

---

## 2. The AI screen builder

Type what you want in plain English; the box turns **one sentence into a filter**. It never
answers questions, writes prose or recommends anything.

Every sentence is read in two steps:
1. **Built-in rules** (`ScreenDSL.ruleParse`, in your browser, free, instant). This is
   the answer when you are signed out, when your account isn't approved for AI, when
   the daily AI limit is reached, and when every AI model fails.
2. **AI** (`POST /api/screen-builder`), only for signed-in, approved (trusted)
   accounts. A free model proposes a filter, and the server and the browser both
   re-validate it. If it is invalid, or it breaks the growth rule below, the next model
   is tried, and after the last one the rules answer stands.

The **source badge** says which answer you're looking at. Possible badges:
`AI · groq/llama-3.3-70b-versatile`, `rules`, `rules · sign in for AI`,
`rules · AI limited to approved accounts`, `rules · daily AI limit reached`.
Phrases neither reader could use are listed as "not understood". Notes explain any
substitution.

**Follow-ups refine the current screen.** Some examples:
- "make it p/e under 15" replaces the P/E condition.
- "remove dividend yield" or "without dividend yield" drops that condition.
- "top 10" and "sort by growth score" replace the limit and the sort.
- "start over" clears the screen.

Each turn shows what changed: +added / −removed / ~changed.

**Examples** (what the built-in rules produce today):

| Sentence | Scope | Chips |
|---|---|---|
| cheap tech stocks with revenue growth over 10% | stocks | Rev growth 1y > 10% · Value ≥ 70 · Sector: Technology |
| profitable large cap industrials, dividend yield 2-5%, sort by value score | stocks | Yield 2%–5% · Profitable ≥ 80% of years · Mkt cap ≥ $10B · Sector: Industrials · Sorted by Value ↓ |
| consistent growth, p/e under 20, top 25 | stocks | P/E < 20 · Revenue up ≥ 80% of years · Top 25 |
| growth | stocks | Rev CAGR > 0% · Earnings CAGR > 0% · Sorted by Growth ↓ |
| growth | markets | Growth ≥ 60 · Sorted by Growth ↓ |
| emerging markets on sale | markets | Quality on sale · Dev.: Emerging |
| healthcare sectors with pe below 25 | markets | P/E < 25 · Type: Sector · Name contains "Health" |
| below its 5 year average | stocks | Below its long-run average · Avg window ≥ 5 years (+ a note: stock prices cover ~2 years, so no stock matches yet) |
| strong momentum stocks | stocks | *(nothing)* — "momentum" is reported as not understood: price momentum is not a screen field |

**The growth rule.** "Growth" always means *fundamental* growth: revenue and earnings,
their multi-year record, and analyst estimates for markets. It never means price
momentum or returns. The rule is enforced in code by `ScreenDSL.growthGuard`. A sentence
about growth must give a screen with at least one growth field (§3, marked **growth**).
It may contain a **price signal** field only if you named it yourself ("on sale", "below
average", "turning up", "price"…). Price returns (`ret_*`) and momentum are not fields
at all.

**Privacy.** For approved accounts the sentence, plus the conditions of the screen being
refined, is sent to a third-party model provider (Groq, then Ollama Cloud, optionally
OpenRouter). A screen holding a ticker list you built (e.g. a watchlist) is never sent:
it is refined by the rules only, and so is a request too large for the 2 KB limit.
Nothing else about you (email, user id, other lists) is sent. Don't type personal details
into it. The built-in rules never leave your browser.

---

## 3. Filter language (the DSL) — reference

A filter is plain JSON. The same object is used by the browser (`dashboard/screen-dsl.js`),
the AI screen builder (`api/screen-builder.js`) and the alert job (`engine/screens.py`).
Nothing in it is ever executed as code.

```json
{ "v": 1, "scope": "stocks",
  "where": [ {"field": "pe", "op": "<=", "value": 20},
             {"field": "sector", "op": "in", "value": ["Industrials", "tech"]},
             {"field": "rev_up_ratio", "op": ">=", "value": 0.8},
             {"field": "dividend_yield", "op": "between", "value": [0.02, 0.06]},
             {"field": "strategies", "op": "contains", "value": "on_sale"},
             {"field": "on_sale", "op": "is_true"} ],
  "sort": {"field": "value_score", "dir": "desc"},
  "limit": 100,
  "include_flagged": false,
  "columns": ["pe", "rev_cagr", "discount_long"] }
```

| Key | Meaning |
|---|---|
| `v` | Always `1`. |
| `scope` | `"stocks"` or `"markets"`. (`"portfolio"` is reserved for the My portfolio PR and rejected today.) |
| `where` | Conditions, **AND** only, at most **12**. |
| `sort` | `{field, dir: "asc"\|"desc"}` or `null`. Empty values sort last in both directions; ties keep their order. |
| `limit` | 1–500, default 100. The match count (`total`) is reported before the limit. |
| `include_flagged` | `false` (default) adds an implicit `data_ok is_true`. |
| `columns` | Optional, ≤ 20 field keys to display. Ignored by evaluation and alerts. |

**Operators by field type:**

| Type | Operators | Value |
|---|---|---|
| number, percent, money | `<` `<=` `>` `>=` `=` `!=` `between` | a number; `between` takes `[low, high]` (inclusive) |
| enum | `=` `!=` `in` `not_in` | a value, or a list for `in`/`not_in` (≤ 500) |
| text | `=` `!=` `contains` `in` `not_in` | text ≤ 80 chars; `contains` is a case-insensitive substring |
| text list (`strategies`, `data_flags`) | `contains` | one tag |
| bool | `is_true` `is_false` | none |

**Rules `validate()` applies:**
- Unknown fields and operators are rejected, as are fields outside the scope, and keys
  like `__proto__` or `constructor`.
- **Percent fields are fractions:** 8% is `0.08` and −10% is `-0.10`. A value outside
  the field's range is an error (e.g. a dividend yield of `4`). The parser converts
  "8%" for you.
- Numeric strings are coerced (`"5"` → 5). Anything else non-numeric is an error.
- Enum values match case-insensitively through synonyms (`tech`, `IT`, `information
  technology` → `Technology`; `health care`, `pharma` → `Healthcare`). An unknown value
  is rejected with the three closest valid ones.
- An empty value (null/NaN) never matches a numeric comparison, `!=` included.

`ScreenDSL.validate(filter, scope)` returns `{ok, filter (normalised), errors[]}`.
`evaluate(filter, rows)` returns `{rows, total}`. `describe(filter)` returns the chip
texts. The error strings are identical in JS and Python.

### Fields

**growth** = counts as fundamental growth for the growth rule. **price signal** = a
price-based field a growth sentence can't introduce on its own. *price-derived* (stocks) =
computed from licensed stock prices, so it is behind the trusted gate (§6).

#### Valuation

| Key | Label | Type | Scopes | Notes |
|---|---|---|---|---|
| `pe` | P/E (price / earnings) | number | both | Price divided by the latest annual net income; empty when earnings are negative. — *price-derived* |
| `pb` | P/B (price / book) | number | both | Price divided by book value (shareholders' equity). — *price-derived* |
| `ps` | P/S (price / sales) | number | both | Price divided by the latest annual revenue. — *price-derived* |
| `pcf` | P/CF (price / cash flow) | number | both | Price divided by the latest annual operating cash flow. — *price-derived* |
| `value_score` | Value score (0-100, vs peers) | number | both | How cheap vs its peer group (stocks: same sector; markets: same type), from P/E, P/B, P/S, P/CF and yield. 100 = cheapest. |
| `opportunity_score` | Opportunity score (blend) | number | both | Blend: value + fundamental growth + 12% price momentum + 8% mean-reversion — **not** a growth measure. — **price signal** |
| `market_cap` | Market cap (USD) | money | stocks | Share price × shares outstanding, in US dollars. — *price-derived* |

#### Growth record (fundamentals)

| Key | Label | Type | Scopes | Notes |
|---|---|---|---|---|
| `rev_growth` | Revenue growth (latest year) | percent | both | Latest fiscal year revenue vs the year before. Markets: holdings-weighted. — **growth** |
| `earnings_growth` | Earnings growth (latest year) | percent | both | Latest fiscal year net income vs the year before. Markets: holdings-weighted. — **growth** |
| `rev_cagr` | Revenue growth per year (multi-year CAGR) | percent | stocks | Compound annual revenue growth over up to the last six fiscal years (EDGAR). — **growth** |
| `ni_cagr` | Earnings growth per year (multi-year CAGR) | percent | stocks | Compound annual net-income growth over up to the last six fiscal years (EDGAR). — **growth** |
| `fwd_growth` | Forward earnings growth (analyst estimates) | percent | markets | Analysts' expected earnings growth for the index's holdings. — **growth** |
| `growth_score` | Growth score (0-100, fundamentals vs peers) | number | both | Revenue and earnings growth ranked within peers (stocks: multi-year record weighted most). Never price momentum. — **growth** |

#### Quality & consistency

| Key | Label | Type | Scopes | Notes |
|---|---|---|---|---|
| `rev_up_ratio` | Revenue up (share of years) | percent | stocks | Share of the last (up to six) fiscal years in which revenue grew. — **growth** |
| `ni_up_ratio` | Earnings up (share of years) | percent | stocks | Share of the last (up to six) fiscal years in which net income grew. — **growth** |
| `ni_pos_ratio` | Profitable (share of years) | percent | stocks | Share of the last (up to seven) fiscal years with positive net income. — **growth** |
| `consistency_score` | Consistency score (0-100, vs peers) | number | stocks | How steadily revenue and earnings grew (up-years, profitable years, low volatility), ranked within sector. — **growth** |
| `hist_years` | Years of reported history | number | stocks | Number of yearly changes in the cleaned annual series (up to six). |

#### Price position

| Key | Label | Type | Scopes | Notes |
|---|---|---|---|---|
| `price` | Share price (USD) | money | stocks | Latest split-adjusted close. — **price signal**, *price-derived* |
| `discount_long` | vs long-run average | percent | both | Price vs its own long-run average close: up to 5 years, or all the price history on file if shorter. −0.10 = 10% below. — **price signal**, *price-derived* |
| `long_avg_years` | Long-run average window (years) | number | both | Years of prices behind that average (markets: 5; stocks: ~2 until more price history is on file). — *price-derived* |
| `turning_up` | Turning up (price recovering) | bool | both | Quality on sale AND up over the last month and off its 52-week low. — **price signal**, *price-derived* |
| `value_trap` | Value trap (price falling) | bool | both | Cheap but deeply down and still falling — a price-only flag. — **price signal**, *price-derived* |

#### Dividends

| Key | Label | Type | Scopes | Notes |
|---|---|---|---|---|
| `dividend_yield` | Dividend yield | percent | both | Trailing-12-month dividends per share / price. 0 = pays no dividend. — *price-derived* |

#### Classification

| Key | Label | Type | Scopes | Notes |
|---|---|---|---|---|
| `ticker` | Ticker | text | stocks | US listing symbol. |
| `key` | Market id | text | markets | Internal market id, e.g. `sec_tech`. |
| `symbol` | ETF symbol | text | markets | Ticker of the ETF used as the market's price proxy. |
| `name` | Name | text | both | Company or market name. |
| `sector` | Sector | enum | stocks | From the company's SEC industry code (not GICS): Technology, Healthcare, Communication Services, Consumer Discretionary, Consumer Staples, Energy, Financials, Industrials, Materials, Real Estate, Utilities, Unknown. |
| `kind` | Market type | enum | markets | Country, Sector, Style, Region, Broad. |
| `region` | Region | enum | markets | North America, Latin America, Europe, Emerging Europe, Africa/MEA, Asia-Pacific, Global. |
| `development` | Development | enum | markets | Developed, Emerging, Frontier, Global. |
| `country` | Country | enum | both | Stocks: country of main operations (EDGAR). Markets: the index's country; Global/Regional/Europe for multi-country indices. |

#### Strategies

| Key | Label | Type | Scopes | Notes |
|---|---|---|---|---|
| `on_sale` | Quality on sale | bool | both | Fundamentally strong, plausible data, and at least 10% below its long-run average price. |
| `deep_value_intact` | Deep discount, fundamentals intact | bool | both | Quality on sale, at least 20% below its long-run average, and value score 60+. |
| `fundamentally_strong` | Fundamentally strong | bool | both | Profitable, growing (a multi-year record where available), growth at least median vs peers, not expensive. — **growth** |
| `steady_compounder` | Steady compounder | bool | stocks | Revenue and earnings up in at least 80% of years, profitable every year, low volatility, CAGR ≥ 3%. — **growth** |
| `garp` | GARP (cheap + high fundamental growth) | bool | both | Value score 55+, growth score 75+, not in the expensive cohort. — **growth** |
| `strategies` | Strategy tags | text list | both | Tags the row qualifies for: `on_sale`, `deep_value_intact`, `turning_up`, `steady_on_sale`. |

#### Data quality

| Key | Label | Type | Scopes | Notes |
|---|---|---|---|---|
| `data_ok` | Passes data checks | bool | both | Stocks: plausible ratios, US-domiciled, USD reporter, enough history, no open data-quality flag. Markets: `data_sane` is not false. |
| `data_flags` | Data flags | text list | stocks | Why a row is hidden: `implausible_pe`, `implausible_ps`, `below_min_mcap`, `foreign_listing`, `non_usd_reporter`, `short_history`, `quality:<check>`. |
| `growth_cov` | Growth coverage (share of holdings) | percent | markets | Share of the index's holdings with fundamental growth data. |

The authoritative list is `dashboard/screen_fields.json`. Its tests check every stock key
against the real `score_frame()` columns and every market key against the scoreboard.

---

## 4. Presets

| Scope | Preset | Filter |
|---|---|---|
| stocks | Quality on sale | `on_sale` · sort `discount_long` asc |
| stocks | Steady compounders | `steady_compounder` · sort `consistency_score` desc |
| stocks | Deep value intact | `deep_value_intact` · sort `value_score` desc |
| stocks | Cheap + growing | `value_score ≥ 60`, `growth_score ≥ 60`, `rev_cagr > 0` · sort `value_score` desc |
| stocks | High dividend | `dividend_yield ≥ 0.04`, `ni_pos_ratio ≥ 0.8` · sort `dividend_yield` desc |
| markets | Quality on sale | `on_sale` · sort `discount_long` asc |
| markets | Deep value intact | `deep_value_intact` · sort `value_score` desc |
| markets | Cheap + growing | `garp` · sort `value_score` desc |
| markets | High dividend | `dividend_yield ≥ 0.03` · sort `dividend_yield` desc |
| markets | Cheapest | no conditions · sort `value_score` desc · top 25 |

None uses `opportunity_score` (it contains price terms).

---

## 5. Alerts, charts and watchlists

### How alerts work
Turn on **Alerts** when saving a screen to your account. A deterministic job (not an
agent, no LLM) then re-runs the screen and records what **entered** and **left** it.

- **When:**
  - Stock screens: daily, after the data pipeline (`engine/datapipeline.py` step 7b).
  - Market screens: weekly, on the Monday refresh (`engine/pipeline.py`), over the exact
    scoreboard rows the dashboard shows.
- **What counts:** the screen's *full* match set (sort and top-N are ignored) with the
  data checks applied. Being 101st in a top-100 screen is not an exit.
- **First run = baseline.** The first evaluation, and the first after you edit the filter
  or switch scope, records the current matches and alerts nothing.
- **Data issues aren't exits.** A name that left only because it started failing the data
  checks is listed separately ("hidden by a data issue").
- **Safety guards** (no alerts that day):
  - a thin data day (price or P/E coverage collapsed, or far fewer rows than last time);
  - a universe under 90% of the screen's last one;
  - a screen already evaluated for that date.

  A missed day is caught up the next day.
- **Limits:** each alert lists up to 50 names per side (true counts shown). Alerts older
  than 120 days are pruned.
- **Where they appear:** the **Alerts** tab. Unseen alerts come first, and the tab badge
  shows the unseen count. *Mark seen* / *Mark all seen*. Alerts are in-app only: no
  email or push in v1.
- **Stock screens alert only for trusted owners.** Trust is checked at run time. If
  access is withdrawn, the screen is skipped and left untouched.

### Charts (the drawer)
- **Owner view** (trusted, stock):
  - daily **closes only** (no candles or volume, for licence reasons), with ranges
    1M · 3M · 6M · 1Y · All, where All is labelled with the real span;
  - a crosshair legend and 50/200-day averages;
  - a *Compare* overlay in percentage mode, labelled "Price change" (never growth);
  - the long-run average the "on sale" call used, as a horizontal line over exactly
    its window and labelled with its real length (e.g. "2-year average price… 5 years
    not on file yet");
  - the **Growth record** below it: annual revenue and net income bars from the cleaned
    EDGAR series the growth fields use, with gaps where a year wasn't reported as a full
    year.
- **Everyone else, and all markets:** TradingView's free Advanced Chart widget for the
  ticker or the market's ETF proxy. It shows their data with their attribution and runs
  in a sandboxed frame. Offline it shows "chart unavailable".

### Watchlists
- One star everywhere (drawers, screener rows, list rows) opens a list picker.
- **Starred markets** is the existing `user_watchlist`. Starred stocks go to an
  auto-created "Starred stocks" list. Custom lists can hold both kinds.
- Limits: 20 lists, 500 items each.
- The list table shows Symbol, Name, P/E, Value, Growth (fundamental), Opportunity,
  vs long-run average (with its window) and flags. Price is shown only to trusted
  viewers.
- Rows come from the latest snapshot, not live quotes. *Screen this list* opens the
  screener on it.

---

## 6. Who sees what — the licensing gate

Stock prices come from Massive on an individual plan: raw bars may never be republished,
and the derived-data clause hasn't been reviewed yet (ADR-017). Market prices come from
Yahoo, which is personal use only. So:

| Surface | Signed out | Signed in | Trusted |
|---|---|---|---|
| Markets screener, presets, share links | ✅ | ✅ | ✅ |
| AI screen builder | rules only | rules only | AI + rules (quota) |
| Stocks screener (`screener_snapshots`) | — | — | ✅ |
| Save screens / alerts | this browser, ≤10, no alerts | markets screens + alerts | markets + stocks |
| Stock CSV export | — | — | ✅ |
| Charts | TradingView widget | TradingView widget | own close chart + Growth record, TradingView tab |
| Watchlists | — (sign in) | lists; stock rows show only fields `dashboard_data.json` already publishes | full snapshot fields + price |

**Trusted** = `public.is_trusted()`. It requires all of:
- a **confirmed** email in `auth.users` (not the JWT claim);
- a non-anonymous session;
- that email in `admins`, or in `app_allowlist` with `can_view_prices = true`.

Row-level security enforces it in Postgres. The UI only mirrors it.

To add another of the **owner's own** addresses:
```sql
insert into app_allowlist (email, can_view_prices) values ('<lowercase address>', true);
```
Never add a third party. Granting `can_view_prices` to anyone else redistributes licensed
data and needs a Massive business plan and a non-Yahoo market price source (table comment,
ADR-037).

**What this gate does not cover:** pre-existing public exposure that this feature did
not create and did not change. It is listed in ADR-037 §8, and the owner's decisions are
in STATUS "00.".

---

## 7. For developers

**Files**

| File | Role |
|---|---|
| `dashboard/screen_fields.json` | Field registry, limits, operators, presets |
| `dashboard/screen-dsl.js` | `ScreenDSL`: validate, evaluate, describe, ruleParse, growthGuard |
| `engine/screens.py` | Python mirror (stdlib only), used by the alert job |
| `api/screen-builder.js` | AI screen builder |
| `engine/screenjobs.py` | Daily snapshot, chart cache and alerts; weekly market alerts |
| `dashboard/screenbox.js` | The widget |
| `dashboard/screener.js`, `charts.js`, `lists.js` | The three views |
| `engine/migrations/0015_screener.sql` | Schema + RLS |

**Tests:**
```bash
node scripts/test_screens.js          # DSL: parity vectors, parser, growth guard, registry checks
python tests/test_screens.py          # same vectors in Python (stdlib only)
node scripts/test_screen_builder.js   # AI screen builder, stubbed fetch, no network
python tests/test_screenjobs.py       # jobs (pandas/numpy; no DB)
psql "$LOCAL_OR_BRANCH_DB_URL" -v ON_ERROR_STOP=1 -f tests/rls_0015.sql   # manual; BEGIN…ROLLBACK
```
CI (`.github/workflows/screens-tests.yml`) runs the first three on every PR that touches
them. Run `tests/rls_0015.sql` only against a local Supabase stack or a branch database,
never production.

**Adding a field:**
1. Add the column to `score_frame()` (or the scoreboard).
2. Add a registry entry with `key, label, short, type, scopes, group, source, help,
   synonyms`, plus `min/max/unit` where they apply.
3. Mark it `growth: true` only if it measures revenue or earnings, and
   `price_signal: true` if it is built from prices.
4. Add parity vectors.

The registry tests fail if a key doesn't exist in the real data.

**Operating:**
- Kill switch for the daily step: env `SCREENS_DAILY=0`. Time limit:
  `SCREENS_MAX_ELAPSED_MIN` (default 240).
- AI limits are rows in `public.ai_config` (`per_user_daily` 40, `global_daily` 150),
  not env vars.
- Migration 0015 is frozen once applied. Changes go in 0016.
