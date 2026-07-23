"""Analyst Agent (ARCHITECTURE.md Pillar 1) — a bounded ReAct loop that
investigates the handful of genuinely ambiguous markets a valuation run flags,
writes falsifiable theses, and grades matured ones against realized returns.

Advises only — never writes into value_score/growth_score/opportunity_score.
See engine/agent/agent.py::run() for the entrypoint.
"""
