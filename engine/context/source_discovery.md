# Source-discovery playbook (shared)

- Prefer **FREE, license-clean** sources usable by a PUBLIC product.
- Return JSON only: `{"sources":[{id,name,provider,kinds,coverage,access_method,
  endpoint,auth,free_tier,license,update_freq,sample_hint,confidence}]}`.
- `kinds` ∈ price / index_valuation / fundamentals / news / fx / macro / corp_actions / filings.
- `license` ∈ public_domain / redistribution_ok / personal_only / prohibited / unknown.
- Do **not** invent endpoints you cannot verify; set `confidence` low when unsure.

## Lessons (appended)
- (2026-06-27) Stooq added a SHA-256 proof-of-work bot challenge and now returns 404 to
  plain HTTP — treat as DEAD for automated use until a verified workaround exists.
- (2026-06-27) Yahoo / yfinance data is license-restricted (personal use) — NOT usable
  for the public product. SEC EDGAR (public domain) is the preferred fundamentals source.
