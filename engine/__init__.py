"""Global Index Valuation Agent — engine package.

The engine is the deterministic, cost-free core: it sources data, computes
valuation/opportunity metrics, ranks markets, records predictions, and scores
past predictions against realized market outcomes. The LLM never touches raw
data — it only narrates the final aggregated scoreboard.
"""

__version__ = "0.1.0"
