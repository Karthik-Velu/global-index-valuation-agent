// Proposal review console (ADR-028).
//
// The reader here is the product owner, not an engineer. So the page is built
// around one question per screen — "should this change happen?" — and everything
// that doesn't help answer it is left out.
//
// Two rules shape the whole UI:
//
//   * Never claim more than happened. Approving a DATA proposal changes the
//     system now; approving a CODE proposal only starts a build. Those get
//     different words and different colours, because "approved" quietly meaning
//     two things is the exact failure this feature exists to fix.
//   * Decisions go through the Edge Function, never straight to the table. The
//     client holds a read policy and a narrow update policy; every consequential
//     write is server-side under the service role. See supabase/functions/admin.
//
// No build step — same constraint as the rest of dashboard/.

const App = (() => {
  let sb = null, user = null, fnUrl = null;
  let rows = [], sel = null, tab = 'pending', authError = null;
  // Survives the reload-and-redraw that follows a decision. Without it the
  // confirmation is destroyed by the very refresh that proves it worked, and
  // the card also leaves the current tab — so you click Approve and are told
  // nothing at all.
  let outcome = null;   // {id, ok, text}

  const $ = id => document.getElementById(id);
  const r_ = v => typeof v === 'string' && v.trim().length > 0;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Tabs are ordered by what needs attention first. 'Building' is separate from
  // 'Decided' because those still need the admin — a solution is waiting to be read.
  const TABS = [
    { key: 'pending', label: 'To review', statuses: ['pending'] },
    { key: 'building', label: 'Building', statuses: ['queued_build', 'approved', 'failed'] },
    { key: 'parked', label: 'Parked', statuses: ['parked'] },
    { key: 'decided', label: 'Decided', statuses: ['actioned', 'declined'] },
  ];

  const KIND_LABEL = {
    catalog_kpi: 'New metric', quality_check: 'Data-quality check',
    source_adapter: 'New data source', model_routing: 'Model routing',
  };
  // Which kinds take effect immediately vs need code written. Mirrors
  // engine/proposals.py DATA_KINDS.
  const IS_DATA = k => k === 'catalog_kpi' || k === 'model_routing';

  const STATUS_STYLE = {
    pending: 'bg-slate-500/15 text-slate-300', approved: 'bg-accent/15 text-accent',
    actioned: 'bg-cheap/15 text-cheap', queued_build: 'bg-warn/15 text-warn',
    declined: 'bg-rich/15 text-rich', parked: 'bg-slate-500/15 text-slate-400',
    failed: 'bg-rich/20 text-rich',
  };

  // ------------------------------------------------------------------ auth

  async function boot() {
    let cfg = null;
    try {
      const meta = await (await fetch('dashboard_data.json', { cache: 'no-store' })).json();
      cfg = meta?.meta?.supabase;
    } catch { /* handled below */ }

    if (!cfg?.url || !cfg?.anon_key || typeof window.supabase === 'undefined') {
      // Same config source as the main dashboard, so this lights up on the same
      // pipeline run rather than needing a key pasted into the repo.
      $('gateMsg').innerHTML =
        'Sign-in isn\'t configured yet. The published data has no Supabase settings, ' +
        'so there\'s nothing to sign in against. This page will work after the next ' +
        'pipeline run publishes them.';
      return;
    }
    fnUrl = cfg.url.replace(/\/$/, '') + '/functions/v1/admin';
    sb = window.supabase.createClient(cfg.url, cfg.anon_key);

    authError = readAuthError();
    const { data: { session } } = await sb.auth.getSession();
    user = session?.user ?? null;
    sb.auth.onAuthStateChange((_e, s) => {
      user = s?.user ?? null;
      if (user) authError = null;   // a good sign-in clears a stale complaint
      render();
    });
    await render();
  }

  // Supabase reports a failed magic link by redirecting back with error params —
  // in the hash for the implicit flow, in the query string for PKCE. Reading them
  // is the difference between "expired link, get a new one" and a silent bounce
  // back to the sign-in form that looks like nothing happened at all.
  //
  // Worth being explicit about the two we actually hit in production:
  //   otp_expired / "invalid or has expired" — usually the link was already
  //     spent. Mail providers PREFETCH links (observed: Gmail hitting /verify
  //     from 74.125.184.178 and burning the token), so this fires even on a link
  //     the human never clicked twice.
  //   redirect mismatch — the URL isn't in Supabase's allowlist, so tokens went
  //     to the Site URL instead of here. The old default is localhost:3000,
  //     which silently swallows a perfectly valid session.
  function readAuthError() {
    const parse = s => new URLSearchParams((s || '').replace(/^[#?]/, ''));
    for (const src of [location.hash, location.search]) {
      const p = parse(src);
      const code = p.get('error_code') || p.get('error');
      if (!code) continue;
      const desc = (p.get('error_description') || '').replace(/\+/g, ' ');
      // Clean the URL so a refresh doesn't re-display a resolved error.
      history.replaceState(null, '', location.pathname);
      if (/expired|not_found|invalid/i.test(code + desc)) {
        return 'That sign-in link had already been used or expired. Request a ' +
               'fresh one below and open it as soon as it arrives — some mail ' +
               'providers scan links automatically, which uses them up.';
      }
      return `Sign-in failed: ${desc || code}`;
    }
    return null;
  }

  async function render() {
    if (!user) {
      if (authError) {
        $('gateMsg').innerHTML = `<span class="text-rich">${esc(authError)}</span>`;
        $('gateForm').classList.remove('hidden');
        $('gate').classList.remove('hidden');
        $('main').classList.add('hidden');
        $('authBox').innerHTML = '';
        return;
      }
      $('gateMsg').textContent = 'Sign in to review proposals.';
      $('gateForm').classList.remove('hidden');
      $('gate').classList.remove('hidden');
      $('main').classList.add('hidden');
      $('authBox').innerHTML = '';
      return;
    }
    // The real gate is RLS + the Edge Function; this only decides what to draw.
    // A non-admin who signs in sees an empty queue and gets 403 on any action.
    $('authBox').innerHTML =
      `<span class="text-slate-400">${esc(user.email)}</span>` +
      `<button id="out" class="fb-btn">Sign out</button>`;
    $('out').onclick = () => sb.auth.signOut();
    $('gate').classList.add('hidden');
    $('main').classList.remove('hidden');
    await load();
  }

  // ------------------------------------------------------------------ data

  async function load() {
    const { data, error } = await sb.from('proposals')
      .select('*').order('evidence_count', { ascending: false })
      .order('last_seen', { ascending: false });
    if (error) {
      $('queue').innerHTML =
        `<div class="text-sm text-rich">Couldn't load the queue: ${esc(error.message)}. ` +
        `If you're signed in but not an admin, that's expected.</div>`;
      return;
    }
    rows = data ?? [];
    drawTabs();
    drawQueue();
  }

  const inTab = r => (TABS.find(t => t.key === tab)?.statuses ?? []).includes(r.status);

  function drawTabs() {
    $('tabs').innerHTML = TABS.map(t => {
      const n = rows.filter(r => t.statuses.includes(r.status)).length;
      const on = t.key === tab;
      return `<button data-tab="${t.key}" class="fb-btn ${on ? 'active' : ''}">` +
             `${t.label}<span class="opacity-60 ml-1">${n}</span></button>`;
    }).join('');
    $('tabs').querySelectorAll('[data-tab]').forEach(b => {
      b.onclick = () => { tab = b.dataset.tab; sel = null; drawTabs(); drawQueue();
                          $('detail').innerHTML = '<div class="text-sm text-slate-500">Pick a proposal on the left.</div>'; };
    });
  }

  function drawQueue() {
    const list = rows.filter(inTab);
    const legacy = list.filter(r => r.payload?.legacy).length;
    $('queueMeta').textContent = list.length
      ? `${list.length} proposal${list.length === 1 ? '' : 's'}` +
        (legacy ? ` · ${legacy} carried over from before this queue existed` : '')
      : '';

    if (!list.length) {
      $('queue').innerHTML = `<div class="text-sm text-slate-500 py-6">Nothing here.</div>`;
      return;
    }
    $('queue').innerHTML = list.map(r => {
      const on = sel?.id === r.id;
      // evidence_count is the honest headline number: how many times the agents
      // raised this before anyone could answer. It's why the queue is sorted by it.
      const ev = r.evidence_count > 1
        ? `<span class="badge bg-warn/15 text-warn">raised ${r.evidence_count}×</span>` : '';
      return `<button data-id="${r.id}" class="w-full text-left rounded-lg border p-3 transition
              ${on ? 'border-accent bg-panel2' : 'border-line bg-panel hover:border-slate-600'}">
        <div class="flex items-center gap-1.5 mb-1.5 flex-wrap">
          <span class="badge ${STATUS_STYLE[r.status] ?? 'bg-slate-500/15 text-slate-300'}">${esc(r.status)}</span>
          <span class="badge bg-slate-500/10 text-slate-400">${esc(KIND_LABEL[r.kind] ?? r.kind)}</span>
          ${ev}
        </div>
        <div class="text-sm text-slate-200 font-medium truncate">${esc(r.target)}</div>
        <div class="text-xs text-slate-500 line-clamp-2 mt-0.5">${esc((r.proposal ?? '').slice(0, 140))}</div>
      </button>`;
    }).join('');
    $('queue').querySelectorAll('[data-id]').forEach(b => {
      b.onclick = () => open(Number(b.dataset.id));
    });
  }

  // ------------------------------------------------------------------ detail

  async function open(id) {
    if (outcome && outcome.id !== id) outcome = null;   // don't resurface a stale banner
    sel = rows.find(r => r.id === id);
    drawQueue();
    if (!sel) return;

    const [{ data: msgs }, { data: sols }] = await Promise.all([
      sb.from('proposal_messages').select('*').eq('proposal_id', id).order('ts'),
      sb.from('proposal_solutions').select('*').eq('proposal_id', id).order('revision', { ascending: false }),
    ]);
    drawDetail(msgs ?? [], sols ?? []);
  }

  function section(title, body) {
    return `<div class="mb-4">
      <div class="section-title">${title}</div>
      <div class="text-sm text-slate-300 leading-relaxed">${body}</div></div>`;
  }

  function drawDetail(msgs, sols) {
    const r = sel;
    const isData = IS_DATA(r.kind);
    const ex = Array.isArray(r.worked_examples) ? r.worked_examples : [];
    const decidable = ['pending', 'parked'].includes(r.status);

    const examples = ex.length ? section('If you approve this', ex.map(e => `
      <div class="rounded-lg border border-line bg-panel2 p-3 mb-2">
        <div class="text-xs text-slate-400 mb-1.5">${esc(e.situation ?? 'Example')}</div>
        <div class="grid sm:grid-cols-2 gap-2 text-xs">
          <div><span class="text-slate-500">Today</span><div class="text-slate-300 mt-0.5">${esc(e.today ?? '—')}</div></div>
          <div><span class="text-cheap/80">After</span><div class="text-slate-300 mt-0.5">${esc(e.after ?? '—')}</div></div>
        </div></div>`).join('')) : '';

    // The honest statement of what a click does. Different per kind, on purpose.
    const effect = isData
      ? `<span class="text-cheap">Approving changes the system straight away</span> — the next data run picks it up.`
      : `<span class="text-warn">Approving starts a build, it doesn't change anything yet</span>. ` +
        `A plain-English plan comes back here for you to approve before any code is written.`;

    const evidence = r.evidence_count > 1
      ? `<p class="text-xs text-slate-500 mt-3">The agents raised this ${r.evidence_count} times` +
        (r.payload?.distinct_wordings > 1 ? `, worded ${r.payload.distinct_wordings} different ways` : '') +
        ` between ${new Date(r.first_seen).toLocaleDateString()} and ${new Date(r.last_seen).toLocaleDateString()}.</p>`
      : '';

    const banner = outcome && outcome.id === r.id ? `
      <div class="rounded-lg border p-3 mb-4 text-sm ${outcome.ok
        ? 'border-cheap/40 bg-cheap/10 text-cheap' : 'border-rich/40 bg-rich/10 text-rich'}">
        ${outcome.text}
      </div>` : '';

    const preview = decidable ? drawPreview(r) : '';

    $('detail').innerHTML = banner + `
      <div class="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <div class="flex items-center gap-1.5 mb-1 flex-wrap">
            <span class="badge ${STATUS_STYLE[r.status] ?? ''}">${esc(r.status)}</span>
            <span class="badge bg-slate-500/10 text-slate-400">${esc(KIND_LABEL[r.kind] ?? r.kind)}</span>
            <span class="text-xs text-slate-500">from ${esc(r.source_agent)}</span>
          </div>
          <h2 class="text-lg font-semibold text-white">${esc(r.target)}</h2>
        </div>
      </div>

      ${section('What would change', esc(r.proposal))}
      ${r.reason ? section('Why it was raised', esc(r.reason)) : ''}
      ${r.how_used ? section('How it gets used from here', esc(r.how_used)) : ''}
      ${r.expected_outcome ? section('What should improve', esc(r.expected_outcome)) : ''}
      ${examples}
      ${r.needs_enrichment ? `<p class="text-xs text-warn/90 mb-4">
        <b>Not written up yet.</b> The text above is the agent's raw output — it may not
        say why this matters or what will consume it. The nightly job fills that in;
        deciding before then means deciding on less than the full picture.</p>` : ''}

      <div class="rounded-lg border border-line bg-panel2 p-3 text-xs text-slate-400 mb-4">
        ${effect}${evidence}
      </div>

      ${preview}

      ${r.action_detail ? section('What happened', `<span class="text-xs">${esc(r.action_detail)}</span>` +
        (r.issue_url ? ` <a href="${esc(r.issue_url)}" target="_blank" rel="noopener" class="text-accent hover:underline text-xs">issue &rarr;</a>` : '')) : ''}

      ${drawSolutions(sols)}

      ${decidable ? `
      <div class="border-t border-line pt-4 mt-4">
        <div class="section-title">Your decision</div>
        <textarea id="note" rows="2" placeholder="Optional note — why you decided this way"
          class="ctrl w-full mb-2 resize-y"></textarea>
        <div class="flex gap-2 flex-wrap">
          <button id="approve" class="px-3 py-1.5 rounded-lg bg-cheap/20 border border-cheap/40 text-cheap hover:bg-cheap/30 transition text-sm">
            ${isData ? 'Approve &amp; apply now' : 'Approve &amp; start build'}
          </button>
          <button id="park" class="px-3 py-1.5 rounded-lg bg-panel2 border border-line text-slate-300 hover:border-slate-500 transition text-sm">
            Park for later
          </button>
          <button id="decline" class="px-3 py-1.5 rounded-lg bg-rich/10 border border-rich/30 text-rich hover:bg-rich/20 transition text-sm">
            Decline
          </button>
        </div>
        <p class="text-xs text-slate-500 mt-2">
          Parked proposals come back on their own once more evidence accumulates.
          Declining is permanent — the agents won't raise it again.
        </p>
        <div id="actMsg" class="text-xs mt-2"></div>
      </div>` : ''}

      <div class="border-t border-line pt-4 mt-4">
        <div class="section-title">Ask about this</div>
        <div id="thread" class="space-y-2 mb-2 max-h-72 overflow-y-auto">${drawThread(msgs)}</div>
        <div class="flex gap-2">
          <input id="q" placeholder="e.g. what breaks if I decline this?" class="ctrl flex-1" />
          <button id="ask" class="px-3 py-1.5 rounded-lg bg-accent/20 border border-accent/40 text-accent hover:bg-accent/30 transition text-sm">Ask</button>
        </div>
      </div>`;

    if (decidable) {
      $('approve').onclick = () => decide('approve');
      $('decline').onclick = () => decide('decline');
      $('park').onclick = () => decide('park');
    }
    $('ask').onclick = ask;
    $('q').onkeydown = e => { if (e.key === 'Enter') ask(); };
    sols.forEach(s => {
      const ok = $(`push-${s.id}`), no = $(`revise-${s.id}`);
      if (ok) ok.onclick = () => solution(s.id, 'push_ok');
      if (no) no.onclick = () => solution(s.id, 'revising', $(`fb-${s.id}`)?.value);
    });
  }

  // The exact change approval will make, read off the payload the apply step
  // actually uses — not a restatement of the prose.
  //
  // This exists because of a real miss on the first live approval. The proposal
  // read "propose for Industrial Materials: Capex Intensity", but its payload
  // (a legacy row) carried no sector, so the apply step defaulted applies_to to
  // "all" and the KPI landed across every sector. The prose said one thing, the
  // write did another, and nothing in the UI showed the difference. Prose is the
  // agent's pitch; this is the diff.
  function drawPreview(r) {
    const p = r.payload ?? {};
    const row = (k, v, warn) =>
      `<tr><td class="pr-3 py-0.5 text-slate-500 align-top whitespace-nowrap">${k}</td>` +
      `<td class="py-0.5 ${warn ? 'text-warn' : 'text-slate-300'}">${v}</td></tr>`;

    if (r.kind === 'catalog_kpi') {
      const tags = Array.isArray(p.xbrl_tags) ? p.xbrl_tags : [];
      // Mirrors engine/proposals.py::_apply_catalog_kpi and the Edge Function's
      // applyCatalogKpi. If those defaults change, change these with them.
      const scope = p.applies_to || p.sector || p.proposed_for_sub_sector || null;
      // Does the prose name a sector the payload doesn't carry? That mismatch is
      // the thing worth shouting about, so look for it explicitly.
      const named = /\bfor\s+([A-Z][\w&/ -]{2,40}?)\s*[::]/.exec(r.proposal || '');
      const rows = [
        row('code', `<code>${esc(r.target)}</code>`),
        row('label', esc(p.label || r.target.replace(/_/g, ' '))),
        // Editable, not a verdict. Showing the admin that a one-sector proposal
        // was about to land market-wide was only half the fix — they still had
        // no way to say "no, just this sector" short of undoing it afterwards.
        // Whatever is in this box is what gets written.
        row('applies to',
          `<input id="scopeOverride" class="ctrl text-xs px-2 py-0.5 w-48" ` +
          `value="${esc(scope || named?.[1] || 'all')}" spellcheck="false">` +
          (scope ? '' : named
            ? ` <span class="text-warn">the proposal carries no sector field — ` +
              `pre-filled from its text (“${esc(named[1])}”), change it if that's wrong</span>`
            : ` <span class="text-warn">no sector given — <b>all</b> means every ` +
              `company, every sector</span>`), !scope),
        row('collected from', tags.length
          ? `XBRL: <code>${tags.map(esc).join('</code>, <code>')}</code>`
          : 'computed — no XBRL tags given, so nothing is fetched until someone ' +
            'writes the formula', !tags.length),
        p.definition ? row('definition', esc(p.definition)) : '',
        row('importance', esc(p.importance || 'medium')),
      ].join('');
      return `<div class="rounded-lg border border-line bg-panel2 p-3 mb-4">
        <div class="section-title">Exactly what gets written</div>
        <table class="text-xs w-full">${rows}</table>
        <p class="text-[11px] text-slate-500 mt-2">A row in <code>metric_catalog</code>.
          ${tags.length ? 'The next data run collects it.'
            : 'With no XBRL tags it is a definition only — nothing collects it until ' +
              'someone writes the formula, so approving this records the decision ' +
              'rather than changing any number.'}</p></div>`;
    }

    if (r.kind === 'model_routing') {
      const chain = Array.isArray(p.chain) ? p.chain : [];
      return `<div class="rounded-lg border border-line bg-panel2 p-3 mb-4">
        <div class="section-title">Exactly what gets written</div>
        <table class="text-xs w-full">
          ${row('role', esc(p.role || 'agent'))}
          ${row('new chain', chain.length ? `<code>${chain.map(esc).join(' → ')}</code>` : '(none given)', !chain.length)}
        </table>
        <p class="text-[11px] text-warn mt-2">Recorded only. Model chains live in
          environment variables, so this does <b>not</b> take effect until someone
          sets it and redeploys.</p></div>`;
    }

    // Code kinds: the honest answer is that nothing is written yet.
    return `<div class="rounded-lg border border-line bg-panel2 p-3 mb-4">
      <div class="section-title">Exactly what happens</div>
      <p class="text-xs text-slate-300">A GitHub issue is filed and the Builder
        drafts a plain-English plan, which comes back here for you to approve.
        <b>No data and no code change yet</b> — nothing is written until you approve
        that plan too.</p></div>`;
  }

  function drawThread(msgs) {
    if (!msgs.length) return `<div class="text-xs text-slate-500">No questions yet.</div>`;
    return msgs.map(m => `
      <div class="rounded-lg p-2.5 ${m.role === 'admin' ? 'bg-panel2 border border-line' : 'bg-accent/5 border border-accent/20'}">
        <div class="text-[10px] uppercase tracking-wide ${m.role === 'admin' ? 'text-slate-500' : 'text-accent/70'} mb-1">
          ${m.role === 'admin' ? 'You' : esc(m.model_id ?? 'assistant')}
        </div>
        <div class="text-sm text-slate-300 whitespace-pre-wrap">${esc(m.body)}</div>
      </div>`).join('');
  }

  function drawSolutions(sols) {
    if (!sols.length) return '';
    const s = sols[0];   // newest revision
    const open = ['draft', 'revising'].includes(s.status);
    const files = Array.isArray(s.files_touched) ? s.files_touched : [];
    return `
      <div class="border-t border-line pt-4 mt-4">
        <div class="section-title">The plan (revision ${s.revision})
          <span class="badge ${s.status === 'merged' ? 'bg-cheap/15 text-cheap' : 'bg-slate-500/15 text-slate-400'} ml-1">${esc(s.status)}</span>
        </div>
        <div class="text-sm text-slate-300 leading-relaxed mb-2">${esc(s.plan)}</div>
        ${s.risks ? `<div class="text-xs text-warn/90 mb-2"><b>Risks:</b> ${esc(s.risks)}</div>` : ''}
        ${s.test_plan ? `<div class="text-xs text-slate-400 mb-2"><b>How we'd check:</b> ${esc(s.test_plan)}</div>` : ''}
        ${files.length ? `<div class="text-xs text-slate-500 mb-2">Touches: ${files.map(f => `<code class="text-slate-400">${esc(f)}</code>`).join(', ')}</div>` : ''}
        ${s.pr_url ? `<a href="${esc(s.pr_url)}" target="_blank" rel="noopener" class="text-accent hover:underline text-xs">pull request &rarr;</a>` : ''}
        ${open ? `
          <textarea id="fb-${s.id}" rows="2" placeholder="What should change about this plan?"
            class="ctrl w-full my-2 resize-y"></textarea>
          <div class="flex gap-2 flex-wrap">
            <button id="push-${s.id}" class="px-3 py-1.5 rounded-lg bg-cheap/20 border border-cheap/40 text-cheap hover:bg-cheap/30 transition text-sm">Build it</button>
            <button id="revise-${s.id}" class="px-3 py-1.5 rounded-lg bg-panel2 border border-line text-slate-300 hover:border-slate-500 transition text-sm">Send back for changes</button>
          </div>` : ''}
      </div>`;
  }

  // ------------------------------------------------------------------ actions

  async function fn(body) {
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(fnUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  }

  function busy(el, on) { if (el) { el.disabled = on; el.style.opacity = on ? '.5' : '1'; } }

  async function decide(decision) {
    const btn = $(decision);
    const note = $('note')?.value ?? '';
    let extra = {};
    if (decision === 'approve' && sel.kind === 'catalog_kpi') {
      // Sent as a typed field, never parsed back out of the note. Inferring
      // meaning from free text is what put capex_intensity on every sector.
      const s = ($('scopeOverride')?.value ?? '').trim();
      if (s) extra.applies_to = s;
    }
    if (decision === 'park') {
      // "come up for discussion later as more data accumulates" — the default is
      // evidence-based rather than a date, because the agents re-raising it IS
      // the signal that it's worth another look.
      extra = { park_min_evidence: (sel.evidence_count ?? 1) + 3 };
    }
    if (decision === 'decline' &&
        !confirm('Decline permanently? The agents will never raise this again.')) return;

    // Approving something that never said why it matters or what will read it is
    // the exact thing that went wrong on the first live approval: capex_intensity
    // was approved off one line of agent text and landed across every sector.
    // The warning banner alone wasn't enough — it sits above the fold and reads
    // as informational. This makes it impossible to do UNKNOWINGLY, without
    // taking the decision away: the missing pieces are named, and the nightly
    // enricher is offered as the alternative.
    if (decision === 'approve' && sel.needs_enrichment) {
        // needs_enrichment is the authority here, not a check on the text. It is
        // set by the same completeness gate the engine uses (reason AND
        // expected_outcome AND how_used all present), so it catches the legacy
        // rows whose `reason` is the non-answer "LLM sub-sector KPI proposal" —
        // technically populated, which is why a length or null heuristic waves
        // exactly the wrong proposals through. Naming the empty fields is just
        // for the message; the gate itself is the flag.
        const missing = [
          !r_(sel.reason) && 'why it was raised',
          !r_(sel.how_used) && 'what will use it afterwards',
          !r_(sel.expected_outcome) && 'what should improve',
        ].filter(Boolean);
        if (!confirm(
              'This proposal hasn\'t been written up yet' +
              (missing.length ? ` — it doesn't say ${missing.join(', or ')}` : '') +
              '.\n\nThe nightly job fills that in. Approving now means deciding ' +
              'on the agent\'s raw text.\n\nApprove anyway?')) return;
    }

    busy(btn, true);
    $('actMsg').innerHTML = '<span class="text-slate-400">Working…</span>';
    try {
      const res = await fn({ action: 'decide', proposal_id: sel.id, decision, note, ...extra });
      // Report what the server actually did, not what we hoped it did. These
      // strings differ per outcome because the outcomes genuinely differ.
      const said = {
        actioned: `Done — ${esc(res.detail ?? 'applied')}`,
        queued_build: `Build started${res.issue_url ? ' and an issue was filed' : ''}. Nothing has changed yet — a plan will appear here for you to approve.`,
        declined: "Declined. The agents won't raise this again.",
        parked: "Parked. It'll come back if the agents keep raising it.",
        failed: `Couldn't apply it: ${esc(res.error ?? '')}`,
      }[res.status] ?? esc(res.status);
      outcome = { id: sel.id, ok: res.status !== 'failed', text: said };
      await load();
      await open(sel.id);
    } catch (e) {
      outcome = { id: sel.id, ok: false, text: esc(e.message) };
      if ($('actMsg')) $('actMsg').innerHTML = `<span class="text-rich">${esc(e.message)}</span>`;
      busy(btn, false);
    }
  }

  async function ask() {
    const q = $('q').value.trim();
    if (!q) return;
    busy($('ask'), true);
    $('thread').insertAdjacentHTML('beforeend',
      `<div class="rounded-lg p-2.5 bg-panel2 border border-line">
         <div class="text-[10px] uppercase tracking-wide text-slate-500 mb-1">You</div>
         <div class="text-sm text-slate-300">${esc(q)}</div></div>
       <div id="pending" class="text-xs text-slate-500 px-2.5">Thinking…</div>`);
    $('q').value = '';
    try {
      await fn({ action: 'chat', proposal_id: sel.id, message: q });
    } catch (e) {
      $('pending')?.remove();
      $('thread').insertAdjacentHTML('beforeend',
        `<div class="text-xs text-rich px-2.5">${esc(e.message)}</div>`);
      busy($('ask'), false);
      return;
    }
    await open(sel.id);
  }

  async function solution(id, verdict, feedback) {
    if (verdict === 'revising' && !(feedback ?? '').trim()) {
      alert('Say what should change, so the Builder knows what to fix.');
      return;
    }
    try {
      await fn({ action: 'solution', solution_id: id, verdict, feedback });
      await open(sel.id);
    } catch (e) {
      alert(e.message);
    }
  }

  // ------------------------------------------------------------------ sign-in

  document.addEventListener('DOMContentLoaded', () => {
    $('sendLink').onclick = async () => {
      const email = $('email').value.trim();
      if (!email) return;
      // boot() is async, so a fast click can land before the client exists.
      if (!sb) { $('gateMsg').textContent = 'Still starting up — try again in a moment.'; return; }
      try {
        // Redirect to the clean path, not location.href — href can still carry
        // the error params from a previous failed attempt, and Supabase matches
        // the whole URL against its allowlist.
        await sb.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: location.origin + location.pathname },
        });
        authError = null;
        $('gateMsg').innerHTML =
          `Link sent to <b>${esc(email)}</b>. Open it on this device, and soon — ` +
          `each link works once, and some mail providers use it up by scanning it. ` +
          `If it doesn't work, just request another.`;
        $('gateForm').classList.add('hidden');
      } catch (e) {
        $('gateMsg').textContent = e.message;
      }
    };
    boot();
  });

  return {};
})();
