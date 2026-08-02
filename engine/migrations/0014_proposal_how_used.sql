-- Proposals must say how the thing will actually be USED, not just what it is.
--
-- Owner directive, 2026-08-02, after the first real approval: "along with
-- definition - a 'why' something is proposed and how it will be used going
-- forward is clearly added for all proposals going forward."
--
-- The 4-part format already carried `reason` (why it was raised — the problem)
-- and `expected_outcome` (what measurably improves). Neither answers the
-- question the admin actually asked while deciding: once this metric exists,
-- what consumes it? Does it feed a score? Show on the dashboard? Enter the
-- backtest? Without that, approving a KPI is approving a row in a table with no
-- stated consequence, which is exactly the "blind decision" the console was
-- built to eliminate.
--
-- Kept as a first-class column rather than another key in `payload` because it
-- is part of the fixed text a human reads, not agent-structured metadata.

alter table proposals add column if not exists how_used text;

comment on column proposals.how_used is
  'Plain English: what consumes this once it exists — which score, view, job or '
  'report changes behaviour, and from when. Distinct from expected_outcome '
  '(the measurable improvement) and reason (the problem that prompted it).';
