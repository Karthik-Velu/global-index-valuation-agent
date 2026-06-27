# Data-quality playbook (shared)

- Compare like-for-like vintages: use the LATEST `filed_date` per
  (security, metric, period). Never flag a "jump" caused by comparing across
  restatement vintages.
- A real anomaly: a >50× period-over-period change, or a sign flip on a level metric.
- Surface: missing core fields (revenue, net income), stale filings, and
  cross-source disagreement on the same fact.
- Every issue should carry enough context (security, metric, period, the two values)
  for a human or a re-ingestion job to act without re-deriving it.
