# Jobs vs Agents — what runs, what's intelligent, and at what cadence

**Terminology (deliberate):**
- **Job** = deterministic Python (no LLM). Does the work, runs frequently, ~free.
- **Agent** = LLM-powered, *intelligent* review. **Improves the jobs** (proposes new
  rules/KPIs/sources/checks), runs **infrequently**, costs a little.

> The agents are the *developers*; the jobs are the *workers*. An agent does not sit
> in the hot path of every run — it periodically reviews how the jobs are doing and
> evolves their rules/config (and, eventually, their code). This keeps the frequent
> work free and the intelligent work rare. **Today there are 0 active agents** (no
> model configured) and several jobs.

---

## Jobs (deterministic — running now, no LLM)

| Job | What it does | Cadence | Entry point |
|---|---|---|---|
| **Valuation / scoring** | Score ~90 indices, surface insights, grade past calls, publish the dashboard snapshot | weekly | `engine.cli refresh` · `refresh.yml` |
| **Data pipeline** | Sequenced: ① probe sources ② ingest fundamentals (EDGAR) ③ tag securities (SIC) ④ validate + auto-fix the KPI catalog ⑤ data-quality checks ⑥ recalibration check | daily | `engine.datapipeline` · `data-pipeline.yml` |

Validation (steps ④⑤⑥) runs **right after ingestion**, in the same job — not as
separate crons. EDGAR (and any future source) ingestion is part of the data-pipeline
job's role.

---

## Agents (LLM — to be set up later)

Each below is wired as a dormant hook; it activates when a model is configured (an
API key today, or a self-hosted model via the provider abstraction — see
[ARCHITECTURE.md](ARCHITECTURE.md#2-the-model-routing-strategy-the-cost-lever)). The
model tier follows the frequency × stakes routing (cheap/owned for frequent, frontier
for rare).

| Agent | Expected work (improves which job) | Model tier | Cadence | Hook |
|---|---|---|---|---|
| **Source-Discovery** | Research new/better data sources for coverage gaps the data-pipeline flags; propose adapters to build | T1 cheap (Qwen/GLM/DeepSeek) | monthly | `dataagent/discover.py` |
| **Sector-KPI Research** | For new/emerging or thin-coverage sub-sectors, research the KPIs that drive them; propose catalog additions + sub-sector tag refinements | T1→T2 | monthly | `sectoragent/research.py` |
| **Quality-Triage** | Read the data-quality warnings; explain root causes, propose fixes and **new deterministic checks** to add | T1 cheap | on findings | (to build) |
| **Analyst** | Investigate the handful of markets the scoring job flags; fetch news/fill gaps via tools; write falsifiable theses; self-grade (reflection) | T2 | per valuation run | (Pillar 1, to build) |
| **Strategist brief** | The 1-paragraph headline read on the scoreboard | T3 frontier | weekly | `llm.smart_brief` |
| **Model-Upgrade** | Eval a candidate model vs champion; promote if better/cheaper | — | monthly | (Pillar 5, to build) |

**The meta-loop:** an agent's output is a *proposal* (a new KPI + its XBRL tag, a new
source, a new quality check). A human or a follow-up step turns the proposal into a
deterministic rule/adapter/check that the jobs then run cheaply, forever. So
intelligence is spent *once* to improve a job, not *every time* the job runs.

---

## Differential frequency (right-sized to how fast each thing changes)
- **Per-ingestion (hot path):** tag new stocks, validate new data — inside the data-pipeline job.
- **Daily:** data pipeline (ingest new filings + validate).
- **Weekly:** valuation/scoring + recalibration check + strategist brief.
- **Monthly:** the LLM research/discovery agents (taxonomy, sources, KPIs) + model-upgrade.

## Setting up the LLM later (checklist)
1. Configure a model — `ANTHROPIC_API_KEY` (frontier) and/or a self-hosted/owned model
   (Qwen/DeepSeek/GLM via the provider abstraction, Pillar 5) for the cheap tiers.
2. Schedule each agent at its cadence (the hooks already exist / are stubbed).
3. Route each agent to its tier in `config/models.yaml` (Pillar 5).
4. Agents emit proposals → jobs stay deterministic.
