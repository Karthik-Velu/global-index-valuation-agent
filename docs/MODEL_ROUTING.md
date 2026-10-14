# Model routing — waterfall + shared/model-specific learning

How the project uses LLMs across many providers without lock-in, stays cheap/free,
and gets better over time. Everything in the engine goes through **one place**,
`engine/llm.py` (`call(role, system, user, …)`). Two request-time callers outside the
engine carry their own hard-coded chains instead. They are listed under
[Out-of-engine callers](#out-of-engine-callers) below.

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

## Out-of-engine callers

Two callers outside `engine/` talk to models directly. They run at request time on hosts
that can't import Python (a Supabase Edge Function, a Vercel function), so each carries a
**hard-coded copy** of a chain:

| Caller | What it does | Chain (free tiers) | Keys live in |
|---|---|---|---|
| `supabase/functions/admin/index.ts` | answers questions in the proposal review console (ADR-028) | Ollama Cloud `gpt-oss:120b` → `deepseek-v3.1` → Groq `llama-3.3-70b-versatile` | Supabase function secrets |
| `api/screen-builder.js` (`screen_builder`) | the **AI screen builder**: one sentence → one Screen DSL filter (ADR-037) | Groq `llama-3.3-70b-versatile` → Ollama Cloud `gpt-oss:120b` (`https://ollama.com/v1`) → OpenRouter `meta-llama/llama-3.3-70b-instruct:free` (only if `OPENROUTER_API_KEY` is set) | Vercel env, **Production only** |

What that means:
- **Not graded.** Their calls never reach `model_invocations` / `model_scorecard`, so
  `ADAPTIVE_ROUTING` can't reorder them and the Model-Upgrade agent can't see or propose
  changes to them. Changing a model id or the order means editing that file by hand.
  Mirror deliberate changes to `engine/config.py` there.
- **`screen_builder` is Groq-first on purpose.** `config.py` puts Ollama Cloud first for
  the batch agents, where quality matters more than speed. The screen builder has a 24 s
  budget for the whole request, with 9 s per tier, and Groq is the fastest 70B.
- **Separate keys.** The Vercel keys are separate provider accounts from the GitHub
  Actions secrets. Groq limits are per organisation, so a public endpoint sharing a key
  could starve the pipeline's agents. They are scoped to Vercel *Production* only, so
  preview deployments, including fork PRs on this public repo, never receive them.
- **The screen builder's guardrails.** The rule-based parser (`ScreenDSL.ruleParse`)
  always runs first and is the answer on any failure.
  - The model is called only for trusted callers, under a server-side quota
    (`ai_quota_take()`; `public.ai_config`: 40 per user per day, 150 per day globally).
  - The system prompt quotes the growth rule verbatim from `context/house_rules.md`, and
    a test fails if the two drift apart.
  - Output must be JSON `{filter, ignored}` that passes `ScreenDSL.validate` and
    `ScreenDSL.growthGuard`. Anything else falls through to the next tier.
  - No model prose is returned to the user.
- **Privacy.** The user's sentence goes to the provider and nothing else does (no email,
  no user id). Logs carry only status codes and the provider name. The UI and
  `DISCLAIMER.md` say this. Some OpenRouter `:free` providers log prompts, so leave
  `OPENROUTER_API_KEY` unset unless the disclosure is updated to name them.
