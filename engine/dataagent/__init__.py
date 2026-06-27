"""The Data-Ingestion Agent.

Its sole job: keep the product's data ingestion as good as possible. It probes
sources for coverage/cleanliness/freshness/latency (deterministic, free), discovers
and tests new candidates, scores them, and rewires which source feeds each data
need — continuously, on a schedule.
"""
