"""Sector-Intelligence Agent.

Keeps the sector taxonomy, per-stock tagging, and the per-sector KPI catalog good
and improving over time — so data collection is never static. Deterministic core
(SIC tagging + catalog validation) runs free; an optional LLM layer researches new
sub-sector KPIs and emerging industries.
"""
