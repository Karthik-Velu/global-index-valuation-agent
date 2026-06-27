"""Model-AGNOSTIC shared learning layer (the "common layer").

A small set of version-controlled Markdown playbooks in engine/context/ that get
injected into every agent's system prompt — so the SAME accumulated knowledge and
house rules apply no matter which model the waterfall selected. Because they live in
git, both local runs and CI read the identical instructions.

Kept deliberately distinct from engine/modelrouting.py, which holds MODEL-SPECIFIC
learning (routing reliability + per-family prompt packaging). Here: WHAT to know.
There: WHICH model to trust and HOW to package the prompt for it.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

CONTEXT_DIR = Path(__file__).parent / "context"

# Which playbooks each agent role loads. house_rules.md is shared by all.
ROLE_FILES = {
    "agent": ["house_rules.md"],
    "cheap": ["house_rules.md"],
    "smart": ["house_rules.md"],
    "source_discovery": ["house_rules.md", "source_discovery.md"],
    "sector_research": ["house_rules.md", "sector_kpis.md"],
    "quality_triage": ["house_rules.md", "data_quality.md"],
}


def _read(name: str) -> str:
    try:
        return (CONTEXT_DIR / name).read_text().strip()
    except Exception:
        return ""


def playbook(role: str) -> str:
    """The concatenated shared knowledge for a role (empty string if none)."""
    files = ROLE_FILES.get(role, ["house_rules.md"])
    parts = [t for t in (_read(f) for f in files) if t]
    return "\n\n---\n\n".join(parts)


def system_prompt(role: str, base: str) -> str:
    """Prepend the shared playbook to a task-specific system prompt."""
    pb = playbook(role)
    return f"{pb}\n\n---\n\n{base}" if pb else base


def append_lesson(role: str, lesson: str) -> bool:
    """Append a dated, learned lesson to the role's most-specific playbook.

    This is how the shared knowledge grows over time — called by a reflection pass
    or a human. Lessons accumulate under a '## Lessons (appended)' section so the
    curated rules at the top stay clean.
    """
    files = ROLE_FILES.get(role, ["house_rules.md"])
    target = CONTEXT_DIR / (files[-1] if len(files) > 1 else files[0])
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        prior = target.read_text() if target.exists() else f"# {target.stem}\n"
        if "## Lessons (appended)" not in prior:
            prior += "\n\n## Lessons (appended)\n"
        prior = prior.rstrip() + f"\n- ({stamp}) {lesson.strip()}\n"
        target.write_text(prior)
        return True
    except Exception:
        return False
