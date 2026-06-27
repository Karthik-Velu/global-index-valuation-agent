# Model routing — waterfall + shared/model-specific learning

How the project uses LLMs across many providers without lock-in, stays cheap/free,
and gets better over time. All of this lives in **one place**, `engine/llm.py`
(`call(role, system, user, …)`); nothing else in the codebase talks to a model.

## Three layers

```
                    ┌──────────────────────────────────────────────┐
   call(role, …) ──▶│  WATERFALL ROUTER  (engine/llm.py)            │
                    │  tier1 → tier2 → tier3, skip on 429/cooldown  │
                    └───────────────┬──────────────────────────────┘
                                    │ injects
              ┌─────────────────────┴──────────────────────┐
              ▼                                             ▼
   SHARED knowledge (model-AGNOSTIC)          MODEL-SPECIFIC learning
   engine/context/*.md                        engine/modelrouting.py + DB
   • house_rules, sector_kpis,                • reliability scorecard → reorder
     source_discovery, data_quality          • per-family prompt packaging
   • same rules for every model               • learned from outcome metrics
```

## 1. The waterfall (reliability)

Each **role** has an ordered **chain** of `scheme:model` candidates, configured in
`engine/config.py` and overridable per-env:

| Role | Default tier-1 → fallbacks | Used by |
|---|---|---|
| `agent` / `source_discovery` / `sector_research` | Ollama Cloud `gpt-oss:120b` → Groq 70B → OpenRouter DeepSeek → local Qwen | the LLM agents |
| `cheap` | Groq 70B → OpenRouter Llama → local Qwen | per-market dashboard tags |
| `smart` | Anthropic Opus → Groq 70B → Ollama Cloud | the weekly strategist brief |

`call()` walks the chain: it **skips** any model with no key / unreachable endpoint,
tries the first usable one, and on failure **classifies the error** and falls through:

- `rate_limit` (HTTP 429) → 90s cooldown, next tier
- `auth` (401/403) → 1h cooldown (misconfigured — don't hammer it), next tier
- `server` (5xx) / `timeout` → 20s cooldown, next tier

If every tier is exhausted it raises, and callers fall back to **free deterministic
text** — so the product always works, even at $0.

**Reorder by editing `.env`**, no code change:
```bash
MODEL_AGENT_CHAIN="groq:llama-3.3-70b-versatile, ollama:gpt-oss:120b-cloud, ollama:qwen2.5"
```

## 2. Shared learning — model-AGNOSTIC (`engine/context/*.md`)

The *knowledge* is version-controlled Markdown playbooks, prepended to every agent's
system prompt by `engine/knowledge.py`. Because they live in git, **local and CI read
the identical instructions**, and **every model sees the same rules** regardless of
which tier answered. This is the "common layer."

- `house_rules.md` — applies to all roles (e.g. *growth = fundamentals, not momentum*; JSON discipline; no invented endpoints).
- `sector_kpis.md`, `source_discovery.md`, `data_quality.md` — role-specific.

Each grows a `## Lessons (appended)` section. `knowledge.append_lesson(role, text)`
adds a dated lesson — called by a human (PR) or a periodic reflection pass — so the
shared knowledge compounds without touching any model's weights.

## 3. Model-SPECIFIC learning (`engine/modelrouting.py` + Postgres)

Some things genuinely differ per model and **cannot** live in a model-agnostic file:

- **Reliability / quality for a role.** Every `call()` logs the outcome to
  `model_invocations` (`ok`, `error_kind`, `json_ok`, `latency_ms`, `attempt`). The
  `model_scorecard` view aggregates this into success rate, clean-JSON rate, p50
  latency, and 429 count per (role, model). With `ADAPTIVE_ROUTING=true` the waterfall
  **reorders the chain by learned reliability** (off by default, so your explicit tier
  order stays authoritative until the evidence is in). Inspect with
  `python -m engine.modelrouting`.
- **Prompt packaging quirks.** `model_profiles` (keyed by family: llama/qwen/gpt-oss/
  claude/…) records whether a family supports JSON mode and whether it needs a hard
  "JSON only" nudge. The prompt *content* is shared; only the *wrapper* is per-family.

**The split in one line:** *what to know* is shared (`context/*.md`); *which model to
trust for what, and how to package the prompt for it* is model-specific (`scorecard`
+ `profiles`). The router consults both on every call.

## Adding a provider

It's already OpenAI-compatible-routed. To add one: give it a `scheme` in
`engine/llm.py::_conf()` (base URL + key from `config`), then reference
`scheme:model` in any chain. Anthropic is the one special-cased path (native SDK).
