// Admin proposal console — server side. (ADR-028)
//
// Three things the browser must NOT be trusted to do itself, which is exactly
// why this function exists rather than the page talking to PostgREST directly:
//
//   1. ACTION an approval. Approving a catalog KPI writes metric_catalog and
//      changes what the next ingestion collects. RLS can gate a row, but it
//      cannot express "an admin may set status='approved' and nothing else" —
//      column-level policies don't exist. So the client gets read + a narrow
//      update policy, and every consequential write happens here under the
//      service role.
//   2. Answer its own questions. proposal_messages has an RLS policy pinning
//      client inserts to role='admin'; assistant rows are written here, so a
//      browser can't forge a model answer into the permanent record.
//   3. Hold provider keys. The model waterfall needs OLLAMA/GROQ keys, which
//      cannot ship to a static page.
//
// Every request re-derives the caller's identity from their JWT and re-checks
// membership in `admins`. The anon key identifies the project, never the person.
//
// Deploy: supabase functions deploy admin
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OLLAMA_API_KEY, GROQ_API_KEY,
//          GITHUB_TOKEN, GITHUB_REPOSITORY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const GITHUB_REPO = Deno.env.get("GITHUB_REPOSITORY") ?? "Karthik-Velu/global-index-valuation-agent";

// Mirrors engine/proposals.py DATA_KINDS / CODE_KINDS. Kept in lockstep with it
// deliberately: getting this split wrong is the difference between "approved ->
// done" and a silent lie about what happened.
const DATA_KINDS = new Set(["catalog_kpi", "model_routing"]);
const TERMINAL = new Set(["declined", "actioned"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/** The caller's email, but only if they are a current admin. Null otherwise. */
async function authorize(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  const email = data?.user?.email;
  if (error || !email) return null;
  // Re-checked per request, not cached — revoking an admin must take effect now,
  // not whenever a session happens to expire.
  const { data: row } = await admin
    .from("admins").select("email").ilike("email", email).maybeSingle();
  return row ? email : null;
}

async function logEvent(
  proposalId: number, event: string, actor: string,
  detail = "", fromStatus?: string, toStatus?: string,
) {
  await admin.from("proposal_events").insert({
    proposal_id: proposalId, event, actor,
    detail: detail.slice(0, 2000), from_status: fromStatus, to_status: toStatus,
  });
}

// ---------------------------------------------------------------------------
// the model waterfall — a small echo of engine/llm.py
// ---------------------------------------------------------------------------

const CHAT_CHAIN = [
  { provider: "ollamacloud", model: "gpt-oss:120b" },
  { provider: "ollamacloud", model: "deepseek-v3.1" },
  { provider: "groq", model: "llama-3.3-70b-versatile" },
];

async function askModel(system: string, user: string): Promise<{ text: string; model: string }> {
  for (const tier of CHAT_CHAIN) {
    const key = Deno.env.get(tier.provider === "groq" ? "GROQ_API_KEY" : "OLLAMA_API_KEY");
    if (!key) continue;
    const url = tier.provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://ollama.com/api/chat";
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: tier.model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          stream: false,
          ...(tier.provider === "groq" ? { max_tokens: 900 } : {}),
        }),
      });
      if (!r.ok) continue;                       // rate-limited or down: next tier
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content ?? j.message?.content ?? "";
      if (text) return { text, model: `${tier.provider}:${tier.model}` };
    } catch { /* next tier */ }
  }
  // Degrading to an honest refusal beats inventing an answer about the system.
  throw new Error("every model tier was unavailable");
}

// ---------------------------------------------------------------------------
// actioning — the server-side half of engine/proposals.py::apply()
// ---------------------------------------------------------------------------

/** Recover a sub-sector the prose names but the payload doesn't carry.
 *
 * The legacy rows were free text — "propose for Industrial Materials: Capex
 * Intensity" — so the scope exists only in the sentence. Defaulting straight to
 * "all" silently applied a sector KPI market-wide on the first real approval
 * (proposal #9, 2026-08-02). Reading it back out of the prose is a guess, so it
 * is recorded in `notes` as inferred rather than presented as declared.
 */
function inferScope(proposal: string): string | null {
  const m = /\bfor\s+([A-Z][\w&/ -]{2,40}?)\s*[::]/.exec(proposal || "");
  return m ? m[1].trim() : null;
}

async function applyCatalogKpi(
  target: string, payload: Record<string, unknown>, proposal = "",
) {
  const tags = (payload.xbrl_tags as string[]) ?? [];
  const inXbrl = tags.length > 0;
  const declared = (payload.applies_to as string) ?? (payload.sector as string) ??
                   (payload.proposed_for_sub_sector as string) ?? null;
  const inferred = declared ? null : inferScope(proposal);
  const scope = declared ?? inferred ?? "all";
  // New KPIs land as `computed` unless the proposal names real XBRL tags. An
  // unverified tag guess is how 7 catalog metrics got auto-demoted for returning
  // the wrong concept; we don't repeat that on a model's say-so.
  const { error } = await admin.from("metric_catalog").upsert({
    metric_code: target,
    label: (payload.label as string) ?? target.replace(/_/g, " "),
    definition: payload.definition ?? null,
    unit: (payload.unit as string) ?? "ratio",
    category: (payload.category as string) ?? "sector_kpi",
    applies_to: scope,
    in_xbrl: inXbrl,
    xbrl_tags: tags,
    source_if_not_xbrl: inXbrl ? null : "computed",
    importance: (payload.importance as string) ?? "medium",
    notes: "added via admin-approved agent proposal" +
      (inferred ? ` · scope "${inferred}" INFERRED from the proposal text, not declared` : "") +
      (!declared && !inferred ? " · no scope given — applied to all sectors" : ""),
  }, { onConflict: "metric_code" });
  if (error) throw new Error(`metric_catalog upsert failed: ${error.message}`);
  // Say which scope was written and where it came from — the admin approved a
  // sentence, so the confirmation has to name what the sentence turned into.
  const how = declared ? "declared" : inferred ? "inferred from the text" : "defaulted";
  return `metric_catalog upserted: ${target} — applies_to="${scope}" (${how}), in_xbrl=${inXbrl}`;
}

async function applyModelRouting(target: string, payload: Record<string, unknown>) {
  const role = (payload.role as string) ?? "agent";
  const chain = (payload.chain as string[]) ?? [];
  const line = chain.length
    ? `MODEL_${role.toUpperCase()}_CHAIN="${chain.join(", ")}"`
    : "(no chain given)";
  await admin.from("taxonomy_changes").insert({
    kind: "model_routing", target, change: line,
    reason: "admin-approved routing proposal", auto: false,
  });
  // Chains live in env vars, not the DB. Reporting this as a live change would
  // be false — it needs a redeploy, and the console says so.
  return `recorded; set in env to take effect: ${line}`;
}

async function fileIssue(p: Record<string, unknown>): Promise<string | null> {
  if (!GITHUB_TOKEN) return null;
  const ex = Array.isArray(p.worked_examples) ? p.worked_examples : [];
  const lines = [
    `**Approved agent proposal #${p.id}** — \`${p.kind}\` / \`${p.target}\``, "",
    "## Proposal", (p.proposal as string) || "(none)", "",
    "## Why it was raised", (p.reason as string) || "(not recorded)", "",
    "## Expected outcome", (p.expected_outcome as string) || "(not recorded)", "",
    "## How it gets used", (p.how_used as string) || "(not recorded)", "",
  ];
  if (ex.length) {
    lines.push("## Worked examples");
    for (const e of ex as Record<string, string>[]) {
      lines.push(`- **${e.situation ?? "case"}**`, `  - today: ${e.today ?? "?"}`,
                 `  - after: ${e.after ?? "?"}`);
    }
  }
  lines.push("", "---",
    "Approved by the admin in the review console. Picked up by the Builder agent " +
    "(`engine/builder.py`), which drafts a plain-English solution for review " +
    "before any code is pushed.");
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "giva-admin-console",
    },
    body: JSON.stringify({
      title: `[${p.kind}] ${p.target}`, body: lines.join("\n"),
      labels: ["agent-proposal", p.kind as string],
    }),
  });
  if (!r.ok) throw new Error(`GitHub issue creation failed: ${r.status}`);
  return (await r.json()).html_url ?? null;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

async function handleDecide(body: Record<string, unknown>, actor: string) {
  const id = Number(body.proposal_id);
  const decision = String(body.decision);
  if (!["approve", "decline", "park"].includes(decision)) {
    return json({ error: `unknown decision ${decision}` }, 400);
  }
  const { data: p } = await admin.from("proposals").select("*").eq("id", id).maybeSingle();
  if (!p) return json({ error: `proposal ${id} not found` }, 404);
  // Re-deciding a terminal proposal would make the audit log lie about what
  // happened, so it is refused rather than silently overwritten.
  if (TERMINAL.has(p.status)) {
    return json({ error: `proposal ${id} is already ${p.status} — cannot re-decide` }, 409);
  }

  const newStatus = { approve: "approved", decline: "declined", park: "parked" }[decision]!;
  await admin.from("proposals").update({
    status: newStatus, decided_at: new Date().toISOString(), decided_by: actor,
    decision_note: (body.note as string) || null,
    park_until: decision === "park" ? (body.park_until ?? null) : null,
    park_min_evidence: decision === "park" ? (body.park_min_evidence ?? null) : null,
  }).eq("id", id);
  await logEvent(id, "decided", actor, (body.note as string) ?? "", p.status, newStatus);

  if (newStatus !== "approved") {
    return json({ id, status: newStatus });
  }

  // "once that i have approved - get actioned immediately."
  try {
    if (DATA_KINDS.has(p.kind)) {
      const detail = p.kind === "catalog_kpi"
        ? await applyCatalogKpi(p.target, p.payload ?? {}, p.proposal ?? "")
        : await applyModelRouting(p.target, p.payload ?? {});
      await admin.from("proposals").update({
        status: "actioned", actioned_at: new Date().toISOString(), action_detail: detail,
      }).eq("id", id);
      await logEvent(id, "actioned", actor, detail, "approved", "actioned");
      return json({ id, status: "actioned", detail });
    }
    const url = await fileIssue(p);
    const detail = url
      ? `filed ${url}`
      : "no GITHUB_TOKEN — issue not filed, the Builder will pick this up from the DB";
    await admin.from("proposals").update({
      status: "queued_build", actioned_at: new Date().toISOString(),
      action_detail: detail, issue_url: url,
    }).eq("id", id);
    await logEvent(id, "actioned", actor, detail, "approved", "queued_build");
    return json({ id, status: "queued_build", detail, issue_url: url });
  } catch (e) {
    // Left as 'failed', which the daily pipeline's retry_failed() picks up. The
    // admin is told the truth now rather than shown a success that didn't happen.
    const detail = String(e).slice(0, 500);
    await admin.from("proposals").update({ status: "failed", action_detail: detail }).eq("id", id);
    await logEvent(id, "action_failed", actor, detail, "approved", "failed");
    return json({ id, status: "failed", error: detail }, 500);
  }
}

const CHAT_SYSTEM =
  "You are advising the non-engineer owner of a global equity valuation system, " +
  "who is deciding whether to approve one specific agent proposal. Answer their " +
  "question about it directly, in plain English, in at most 150 words. Ground " +
  "every claim in the record you are given. If the record does not contain what " +
  "they are asking about, say so plainly — do not speculate about code or data " +
  "you cannot see. If they ask whether to approve it, give a recommendation and " +
  "your reasoning, including the honest case against.\n" +
  "`how_used` states what actually consumes this once it exists. Use it to answer " +
  "'how will this be used?'. If it is null or empty, say plainly that the proposal " +
  "does not state a consumer — never invent one, and treat 'nothing reads it yet' " +
  "as a material fact the owner should weigh before approving.\n" +
  "You are also given `will_write` — precisely what approving writes to the " +
  "system. Prefer it over the prose whenever they conflict: the prose is the " +
  "agent's pitch, `will_write` is what actually happens. If they differ in a way " +
  "that matters (most importantly scope — a proposal that reads as sector-" +
  "specific but writes applies_to='all' affects every company), SAY SO UNPROMPTED. " +
  "That mismatch has already caused one wrongly-scoped approval.";

/** What approval will actually write. Same defaults as applyCatalogKpi, so the
 *  answer the admin reads and the row that gets created cannot drift apart. */
function willWrite(p: Record<string, unknown>) {
  const pay = (p.payload ?? {}) as Record<string, unknown>;
  if (p.kind === "catalog_kpi") {
    const tags = (pay.xbrl_tags as string[]) ?? [];
    const declared = (pay.applies_to as string) ?? (pay.sector as string) ??
                     (pay.proposed_for_sub_sector as string) ?? null;
    const inferred = declared ? null : inferScope(String(p.proposal ?? ""));
    return {
      table: "metric_catalog",
      metric_code: p.target,
      applies_to: declared ?? inferred ?? "all",
      applies_to_source: declared ? "declared in the proposal"
        : inferred ? `inferred from the proposal text ("${inferred}")`
        : "NOT SPECIFIED — defaults to every sector",
      collected_via: tags.length ? `XBRL tags ${tags.join(", ")}`
        : "computed — no XBRL tags given, so nothing is collected until a formula is written",
      definition: pay.definition ?? null,
    };
  }
  if (p.kind === "model_routing") {
    return { table: "taxonomy_changes (record only)", role: pay.role ?? "agent",
             chain: pay.chain ?? [],
             takes_effect: "NOT until someone sets the env var and redeploys" };
  }
  return { writes_nothing_yet: true,
           what_happens: "files a GitHub issue; the Builder drafts a plain-English " +
                         "plan which the admin must approve before any code is written" };
}

async function handleChat(body: Record<string, unknown>, actor: string) {
  const id = Number(body.proposal_id);
  const message = String(body.message ?? "").trim();
  if (!message) return json({ error: "empty message" }, 400);

  const { data: p } = await admin.from("proposals").select("*").eq("id", id).maybeSingle();
  if (!p) return json({ error: `proposal ${id} not found` }, 404);

  await admin.from("proposal_messages")
    .insert({ proposal_id: id, role: "admin", body: message, author: actor });

  const { data: history } = await admin.from("proposal_messages")
    .select("role, body").eq("proposal_id", id).order("ts", { ascending: true }).limit(20);

  const ctx = JSON.stringify({
    proposal: {
      kind: p.kind, target: p.target, source_agent: p.source_agent,
      proposal: p.proposal, reason: p.reason, expected_outcome: p.expected_outcome,
      how_used: p.how_used,
      worked_examples: p.worked_examples, evidence_count: p.evidence_count,
      first_seen: p.first_seen, last_seen: p.last_seen, status: p.status,
      is_code_change: !DATA_KINDS.has(p.kind),
      // The agent's structured output — sector, XBRL tags, unit, definition.
      // Omitting it is why "does this apply only to certain segments?" got
      // answered with "the record doesn't say" when the record did say.
      payload: p.payload ?? {},
    },
    will_write: willWrite(p),
    conversation: history ?? [],
    question: message,
  }).slice(0, 12000);

  try {
    const { text, model } = await askModel(CHAT_SYSTEM, ctx);
    await admin.from("proposal_messages")
      .insert({ proposal_id: id, role: "assistant", body: text, model_id: model });
    await logEvent(id, "message", actor, `q&a via ${model}`);
    return json({ reply: text, model });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 503);
  }
}

async function handleSolution(body: Record<string, unknown>, actor: string) {
  const sid = Number(body.solution_id);
  const verdict = String(body.verdict);
  if (!["push_ok", "revising"].includes(verdict)) {
    return json({ error: `unknown verdict ${verdict}` }, 400);
  }
  const { data: s } = await admin.from("proposal_solutions")
    .select("id, proposal_id, status, revision").eq("id", sid).maybeSingle();
  if (!s) return json({ error: `solution ${sid} not found` }, 404);
  if (["pushed", "merged"].includes(s.status)) {
    return json({ error: `solution ${sid} is already ${s.status}` }, 409);
  }

  await admin.from("proposal_solutions").update({
    status: verdict, feedback: (body.feedback as string) || null,
    updated_at: new Date().toISOString(),
  }).eq("id", sid);
  await logEvent(s.proposal_id, `solution_${verdict}`, actor,
    verdict === "push_ok"
      ? `revision ${s.revision} approved for push`
      : `revision ${s.revision} sent back: ${(body.feedback as string) ?? ""}`.slice(0, 500));
  // The Builder runs on a schedule; the console is explicit that this is queued
  // rather than instant, because pretending otherwise is the same lie as above.
  return json({ id: sid, status: verdict, note: "the Builder picks this up on its next run" });
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const actor = await authorize(req);
  if (!actor) return json({ error: "not an admin" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  switch (String(body.action)) {
    case "decide":   return await handleDecide(body, actor);
    case "chat":     return await handleChat(body, actor);
    case "solution": return await handleSolution(body, actor);
    default:         return json({ error: `unknown action ${body.action}` }, 400);
  }
});
