"""Pluggable data sources for the ingestion agent.

A `SourceAdapter` wraps one way of getting one or more `DataKind`s (an API, a bulk
file, an RSS feed, or a scrape). The ingestion agent (engine/dataagent) probes
adapters for quality and rewires which source feeds each `data_need`.
"""
