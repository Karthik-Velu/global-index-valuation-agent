# House rules (shared across all models)

These rules apply to **every** agent in this project, regardless of which model the
waterfall router selected. They are the project's model-agnostic "common layer."

- **"Growth" always means FUNDAMENTAL growth** — revenue and earnings growth of the
  underlying companies (plus forward analyst estimates) — **never** price momentum.
- **Output discipline:** when asked for JSON, return exactly ONE valid JSON object and
  nothing else — no markdown code fences, no prose before or after.
- **Never invent specifics you are unsure of** — API endpoints, ticker symbols, XBRL
  tags, CIKs, or license terms. If you don't know, omit it or mark confidence low.
- **License awareness:** prefer public-domain / redistribution-OK sources. Flag any
  source whose terms forbid commercial or public redistribution.
- **Point-in-time integrity:** treat fundamentals as as-reported with their filing date;
  never silently blend restatement vintages.
- **Be specific and decisive**, not hedged and generic. Name names; give numbers.
