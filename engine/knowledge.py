"""Model-AGNOSTIC shared knowledge layer (the curated "common layer").

Two things compose the system prompt for every agent call:
  1. the curated playbooks in engine/context/*.md (version-controlled, human-reviewed,
     promoted from semantic memory) — small, stable, always injected;
  2. the most relevant LEARNED lessons for the task, retrieved on demand from semantic
     memory (engine/memory.py) — the evolving long tail, bounded to top-k.

Because the playbooks live in git, local and CI read identical instructions, and every
model sees the same rules regardless of which tier the waterfall picked. Lessons that
graduate to high confidence are PROMOTED into these files (memory.apply_promotion ->
append_curated here), so the trusted core grows deliberately, not unboundedly.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

CONTEXT_DIR = Path(__file__).parent / "context"

# Which curated playbooks each role loads. house_rules.md is shared by all.
ROLE_FILES = {
    "agent": ["house_rules.md"],
    "cheap": ["house_rules.md"],
    "smart": ["house_rules.md"],
    "source_discovery": ["house_rules.md", "source_discovery.md"],
    "sector_research": ["house_rules.md", "sector_kpis.md"],
    "quality_triage": ["house_rules.md", "data_quality.md"],
    "analyst": ["house_rules.md", "analyst_playbook.md"],
}

# Which semantic-memory scopes are relevant to each role (LIKE patterns).
ROLE_SCOPES = {
    "agent": ["global"],
    "cheap": ["global"],
    "smart": ["global"],
    "source_discovery": ["global", "source_discovery", "source:%"],
    "sector_research": ["global", "sector_research", "sector_research:%"],
    "quality_triage": ["global", "quality", "data_quality"],
    "analyst": ["global", "analyst", "analyst:%"],
}

# Map a scope to the playbook a promoted lesson should be curated into.
_SCOPE_FILE = [
    ("source", "source_discovery.md"),
    ("sector_research", "sector_kpis.md"),
    ("quality", "data_quality.md"),
    ("data_quality", "data_quality.md"),
    ("analyst", "analyst_playbook.md"),
]


def _read(name: str) -> str:
    try:
        return (CONTEXT_DIR / name).read_text().strip()
    except Exception:
        return ""


def playbook(role: str) -> str:
    """The concatenated curated playbook(s) for a role (empty string if none)."""
    files = ROLE_FILES.get(role, ["house_rules.md"])
    parts = [t for t in (_read(f) for f in files) if t]
    return "\n\n---\n\n".join(parts)


def _learned_block(role: str, query: str | None, k: int = 6) -> str:
    """Top-k relevant learned lessons from semantic memory, as a prompt block."""
    try:
        from . import memory  # lazy: avoids knowledge<->memory<->llm import cycle
        scopes = ROLE_SCOPES.get(role, ["global"])
        rows = memory.retrieve(scopes, query=query, k=k)
    except Exception:
        rows = []
    if not rows:
        return ""
    lines = [f"- {r['claim']}" for r in rows]
    return "## Learned lessons (most relevant, may evolve)\n" + "\n".join(lines)


def system_prompt(role: str, base: str, query: str | None = None) -> str:
    """Curated playbook + retrieved learned lessons + the task-specific prompt."""
    blocks = [playbook(role), _learned_block(role, query), base]
    return "\n\n---\n\n".join(b for b in blocks if b)


def _file_for_scope(scope: str) -> str:
    for prefix, fname in _SCOPE_FILE:
        if (scope or "").startswith(prefix):
            return fname
    return "house_rules.md"


def append_curated(scope_or_role: str, text: str) -> bool:
    """Curate a promoted lesson into the matching playbook, under '## Lessons (appended)'.

    Called by memory.apply_promotion (human-in-loop). This is the ONLY path that writes
    to the .md core — agents/jobs capture into semantic memory, they never edit files.
    """
    target = CONTEXT_DIR / _file_for_scope(scope_or_role)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        prior = target.read_text() if target.exists() else f"# {target.stem}\n"
        if "## Lessons (appended)" not in prior:
            prior += "\n\n## Lessons (appended)\n"
        prior = prior.rstrip() + f"\n- ({stamp}) {text.strip()}\n"
        target.write_text(prior)
        return True
    except Exception:
        return False
