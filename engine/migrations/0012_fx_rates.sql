-- FX reference rates (Frankfurter — ECB daily rates, free, keyless), powering
-- the dashboard's optional display-currency conversion (Phase D, ADR-023).
-- Pure UX convenience: every SCORE the product computes (P/E, P/B, yield %) is
-- dimensionless and currency-agnostic; the only genuinely currency-denominated
-- fields are the Phase C investability panel's stock price/market_cap, which
-- are USD-native (the universe requires a US-listed ticker — see
-- universescan.py). The client (app.js) does the multiplication for display
-- only; nothing server-side is ever renormalized into another currency.
--
-- Small + low-churn (~17 currencies x 1 row/day), so this lives in Postgres
-- (Tier A) rather than Tier B, same reasoning as every other relational-state
-- table in this schema.

create table if not exists fx_rates (
  asof      date not null,
  currency  text not null,               -- ISO 4217, e.g. 'EUR'
  rate      double precision not null,   -- units of `currency` per 1 USD (Frankfurter base=USD)
  primary key (asof, currency)
);
create index if not exists ix_fx_rates_currency_asof on fx_rates(currency, asof desc);
