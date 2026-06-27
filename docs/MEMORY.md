# Memory architecture — how learnings persist (and don't get lost)

The project learns over time. A flat `.md` file is the right *trusted core* but the
wrong *whole memory*: it grows unboundedly, has no provenance/confidence, can't be
queried or retrieved-by-relevance, never decays stale facts, and corrupts under
concurrent CI/local writes. So memory is **three tiers with a lifecycle loop**.

```
  CURATED CORE     engine/context/*.md  — small, stable, git-versioned, human-reviewed,
  "the constitution"   always injected. The TRUSTED, promoted subset. ($0, offline.)
        ▲  promote (distil, human-in-loop)            │ retrieve top-k (relevance)
        │                                             ▼
  SEMANTIC MEMORY  Postgres `lessons` (+ `lesson_events`) — atomic facts with
  "what we learned"    provenance, confidence, status, dedup, history, embeddings.
        ▲  consolidate (dedup/merge) · verify/decay (re-test, time-decay)
        │  capture (candidate)
  EPISODIC LOG     model_invocations, source_evals, predictions, quality_issues,
  "raw experience"     taxonomy_changes — high-volume time-series. Already in Postgres.
```

## The lifecycle (this is what prevents loss & staleness)

| Step | Who | What |
|---|---|---|
| **capture** | agents + jobs (`memory.capture`) | learning → a *candidate* lesson; **never** writes `.md`. Re-capture **merges** by `dedup_key` (bumps evidence + confidence). |
| **consolidate** | pipeline job (`memory.consolidate`) | candidate → **active** once it earns trust (≥`MEM_ACTIVATE_EVIDENCE` or ≥`MEM_ACTIVATE_CONF`). |
| **verify / decay** | pipeline job (`memory.verify_decay`, `memory.contradict`) | confidence **decays** on a half-life over `last_confirmed`; contradicted/expired facts **retire**. Promoted facts need an explicit contradiction (stay in sync with `.md`). |
| **promote** | human-in-loop (`memory.apply_promotion`) | durable, high-confidence (≥`MEM_PROMOTE_CONF`) active lesson → curated into the matching `.md`, status **promoted**. The only path that edits a playbook. |
| **retrieve** | every LLM call (`memory.retrieve`) | inject curated core + **top-k relevant active lessons** — not the whole file. |

Statuses: `candidate → active → promoted`; `retired` / `superseded` are terminal.
Candidates are **not** injected (not yet trusted); promoted ones live in the `.md` and
are **excluded** from retrieval (so they're never double-injected).

## Tables (`engine/migrations/0007`, `0008`)

- **`lessons`** — `scope` ('global' | role | `sector_research:banks` | `source:stooq`),
  `kind`, `claim`, `dedup_key` (unique), `status`, `confidence`, `evidence_count`,
  `contradiction_count`, `origin`, `testable`/`test_hint`, `superseded_by`, timestamps,
  a generated `search` tsvector, and an optional `embedding vector(768)` (pgvector).
- **`lesson_events`** — append-only history of every state change. Powers
  `memory.belief_at(scopes, as_of)` → **point-in-time belief reconstruction**, so a
  backtest is scored against the knowledge the system actually had then, not today's.

## Retrieval — 3 modes, graceful

`memory.retrieve(scopes, query, k)` tries, in order:
1. **Semantic** — pgvector cosine search (needs an embedding model + the `embedding`
   column). `MODEL_EMBED` defaults to free local `ollama:nomic-embed-text` (dim 768).
2. **Lexical** — Postgres full-text (`tsvector`) on the claim.
3. **Scope / recency** — confidence × recency ordering.

No embedding model? It silently uses modes 2–3. No DB? `retrieve` returns `[]` and the
agent runs on the curated `.md` alone. Memory is always strictly optional.

> To light up semantic retrieval locally: `ollama pull nomic-embed-text` (then new
> captures embed automatically; back-fill existing rows by re-capturing).

## How it connects to the rest

- **Shared vs model-specific learning.** This is the *model-agnostic* shared layer
  (WHAT we know). Model reliability/packaging is the *model-specific* layer in
  [MODEL_ROUTING.md](MODEL_ROUTING.md) (`model_scorecard`, `model_profiles`).
- **In the prompt.** `engine/knowledge.py::system_prompt(role, base, query)` = curated
  playbook + retrieved lessons + task. `llm.call()` passes the user message as `query`,
  so retrieval is task-relevant.
- **In the pipeline.** `engine/datapipeline.py` runs `consolidate()` then
  `verify_decay()` right after the agents — anything just captured is consolidated the
  same pass.

## Inspect / operate

```bash
python -m engine.memory          # stats, run consolidate+decay, list promotion candidates
```
Tuning knobs (env, see `engine/config.py`): `MEM_ACTIVATE_EVIDENCE`, `MEM_ACTIVATE_CONF`,
`MEM_PROMOTE_CONF`, `MEM_RETIRE_CONF`, `MEM_DECAY_HALFLIFE_DAYS`, `MODEL_EMBED`, `EMBED_DIM`.

## Roadmap

- Promotion **agent** that drafts the `.md` diff as a PR for human approval (mechanism
  exists via `propose_promotions` + `apply_promotion`; the PR wrapper is next).
- Embedding back-fill job; fuzzy (vector) dedup at capture to merge paraphrases.
- Re-verification of `testable` lessons against live sources (closes the decay loop).
