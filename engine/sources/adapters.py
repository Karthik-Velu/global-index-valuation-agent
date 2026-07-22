"""Registry of adapter instances the agent can probe/use today.

Discovered leads in the catalog become candidates here once an adapter is written
for them (the agent flags which leads are worth adapting next).
"""
from __future__ import annotations

from .base import SourceAdapter
from .edgar import EdgarAdapter
from .simfin import SimFinAdapter
from .yahoo import YahooAdapter

ADAPTERS: dict[str, SourceAdapter] = {
    a.id: a for a in [YahooAdapter(), SimFinAdapter(), EdgarAdapter()]
}


def active_adapter(need_id: str, default: str | None = None) -> SourceAdapter | None:
    """The adapter the ingestion agent has chosen for a need (decisions take effect
    here). Falls back to `default` or the first adapter serving the need's kind."""
    from . import registry
    needs = {n["id"]: n for n in registry.list_needs()}
    need = needs.get(need_id)
    chosen = (need or {}).get("active_source_id") or default
    if chosen and chosen in ADAPTERS:
        a = ADAPTERS[chosen]
        if a.available():
            return a
    # fall back to any available adapter serving the need's kind
    if need:
        for a in adapters_for(need["kind"]):
            if a.available():
                return a
    return ADAPTERS.get(default) if default else None


def get(source_id: str) -> SourceAdapter | None:
    return ADAPTERS.get(source_id)


def all_adapters() -> list[SourceAdapter]:
    return list(ADAPTERS.values())


def adapters_for(kind: str) -> list[SourceAdapter]:
    return [a for a in ADAPTERS.values() if kind in [k.value for k in a.kinds]]
