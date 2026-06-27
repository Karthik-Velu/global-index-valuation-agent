"""Registry of adapter instances the agent can probe/use today.

Discovered leads in the catalog become candidates here once an adapter is written
for them (the agent flags which leads are worth adapting next).
"""
from __future__ import annotations

from .base import SourceAdapter
from .stooq import StooqAdapter
from .yahoo import YahooAdapter

ADAPTERS: dict[str, SourceAdapter] = {a.id: a for a in [YahooAdapter(), StooqAdapter()]}


def get(source_id: str) -> SourceAdapter | None:
    return ADAPTERS.get(source_id)


def all_adapters() -> list[SourceAdapter]:
    return list(ADAPTERS.values())


def adapters_for(kind: str) -> list[SourceAdapter]:
    return [a for a in ADAPTERS.values() if kind in [k.value for k in a.kinds]]
