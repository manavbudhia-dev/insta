/* DM Autopilot — visual flow builder (Flows list + drag-and-drop canvas). Uses helpers shared by app.js. */
(() => {
  const D = window.DMA;
  if (!D) return;
  const { $, $$, esc, ic, api, toast, run, openModal, closeModal, modalHead, popover, views, main } = D;

  // ------------------------------------------------------------------ icons used only here

  const EXTRA = {
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    branch: '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2c0 4-6 3-11 7"/>',
    shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1"/>',
    bubble: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    flask: '<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21.5h11.6a2 2 0 0 0 1.7-3L14 9V3"/><path d="M7 15h10"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    back: '<path d="M15 18 9 12l6-6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  };
  const bi = (n) => (EXTRA[n] ? `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${EXTRA[n]}</svg>` : ic(n));

  // ------------------------------------------------------------------ node catalogue

  const T = {
    trigger: { label: 'Trigger', icon: 'zap', color: '#22c55e', group: 'Start', desc: 'What starts this flow' },
    message: { label: 'Send message', icon: 'chat', color: '#8b5cf6', group: 'Send', desc: 'Text, buttons, quick replies' },
    media: { label: 'Send image', icon: 'image', color: '#ec4899', group: 'Send', desc: 'An image or a video' },
    wait_reply: { label: 'Wait for reply', icon: 'reply', color: '#f59e0b', group: 'Logic', desc: 'Save what they type' },
    condition: { label: 'Condition', icon: 'branch', color: '#f97316', group: 'Logic', desc: 'Go one way or another' },
    delay: { label: 'Delay', icon: 'clock', color: '#06b6d4', group: 'Logic', desc: 'Pause before the next step' },
    split: { label: 'A/B split', icon: 'shuffle', color: '#a855f7', group: 'Logic', desc: 'Randomly test two paths' },
    comment_reply: { label: 'Reply to comment', icon: 'bubble', color: '#14b8a6', group: 'Actions', desc: 'Public reply under the post' },
    tag: { label: 'Tag contact', icon: 'tag', color: '#84cc16', group: 'Actions', desc: 'Add or remove a label' },
    handoff: { label: 'Hand off to me', icon: 'user', color: '#f43f5e', group: 'Actions', desc: 'Stop the bot, you take over' },
  };
  const DEF = {
    trigger: () => ({ on: 'dm', match_mode: 'contains', keywords: [], media_id: null, cooldown_minutes: 0, priority: 0 }),
    message: () => ({ text: '', buttons: [], quick: [] }),
    media: () => ({ url: '', kind: 'image' }),
    wait_reply: () => ({ save_as: '', validate: 'any', timeout_minutes: 0 }),
    condition: () => ({ check: 'text', variable: '', op: 'contains', values: [] }),
    delay: () => ({ amount: 5, unit: 'minutes' }),
    comment_reply: () => ({ variants: [] }),
    tag: () => ({ action: 'add', tag: '' }),
    split: () => ({ percent_a: 50 }),
    handoff: () => ({ pause_hours: 24 }),
  };
  const TRIG = { dm: 'Direct message', comment: 'Comment on a post', story_reply: 'Reply to my story', story_mention: 'Mentions me in a story', welcome: 'First ever message' };

  /** Output ports; must match portsOf() in src/flows.ts. */
  function portsOf(n) {
    const d = n.data || {};
    switch (n.type) {
      case 'message': {
        const opts = [
          ...(d.buttons || []).map((b, i) => (b.kind === 'flow' ? `b${i}` : null)).filter(Boolean),
          ...((d.buttons || []).length ? [] : (d.quick || []).map((_, i) => `q${i}`)),
        ];
        return opts.length ? [...opts, 'other'] : ['next'];
      }
      case 'wait_reply': return ['reply', ...(d.validate && d.validate !== 'any' ? ['invalid'] : []), ...(d.timeout_minutes > 0 ? ['timeout'] : [])];
      case 'condition': return ['yes', 'no'];
      case 'split': return ['a', 'b'];
      case 'handoff': return [];
      default: return ['next'];
    }
  }
  const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m} min`);
  function portLabel(n, p) {
    const d = n.data;
    if (p === 'next') return 'Next';
    if (p === 'other') return 'Any other reply';
    if (p[0] === 'b') return d.buttons[Number(p.slice(1))]?.title || 'Button';
    if (p[0] === 'q') return d.quick[Number(p.slice(1))] || 'Quick reply';
    if (p === 'reply') return d.validate === 'any' ? 'Got a reply' : `Valid ${d.validate}`;
    if (p === 'invalid') return 'Invalid answer';
    if (p === 'timeout') return `No reply in ${dur(d.timeout_minutes)}`;
    if (p === 'yes') return 'Yes';
    if (p === 'no') return 'No';
    if (p === 'a') return `Path A · ${d.percent_a}%`;
    if (p === 'b') return `Path B · ${100 - d.percent_a}%`;
    return p;
  }
  const PORT_COLOR = { yes: '#22c55e', reply: '#22c55e', a: '#60a5fa', b: '#c084fc', no: '#f43f5e', invalid: '#f43f5e', timeout: '#f59e0b', other: '#94a3b8' };
  const portColor = (n, p) => PORT_COLOR[p] || T[n.type].color;

  const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
  const words = (raw, t) => {
    const k = norm(raw);
    if (!k) return false;
    const escd = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escd}(?![\\p{L}\\p{N}])`, 'u').test(norm(t));
  };
  const VALID = {
    any: (s) => s.trim().length > 0,
    email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim()),
    phone: (s) => /^\+?[\d\s().-]{7,20}$/.test(s.trim()) && s.replace(/\D/g, '').length >= 7,
    number: (s) => /^-?\d+([.,]\d+)?$/.test(s.trim()),
  };
  const varsHtml = (s) => esc(s).replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, '<span class="fv">{{$1}}</span>');
  const trigSummary = (t) => (!t ? 'No trigger yet' : t.match_mode === 'any' || t.on === 'welcome' || t.on === 'story_mention'
    ? `${TRIG[t.on]} · any text` : `${TRIG[t.on]} · ${t.keywords.length ? t.keywords.map((k) => `“${k}”`).join(', ') : 'no keywords'}`);

  // ------------------------------------------------------------------ templates

  function tpl(nodes, links) {
    const ids = {};
    const out = { nodes: nodes.map(([key, type, x, y, data]) => (ids[key] = uid('n'), { id: ids[key], type, x, y, data: { ...DEF[type](), ...data } })), edges: [] };
    out.edges = links.map(([a, port, b]) => ({ id: uid('e'), from: ids[a], port, to: ids[b] }));
    return out;
  }
  const TEMPLATES = [
    { key: 'blank', name: 'Start from scratch', icon: 'plus', desc: 'An empty canvas with a trigger.', build: () => tpl([['t', 'trigger', 80, 160, {}]], []) },
    {
      key: 'comment', name: 'Comment → DM link', icon: 'bubble', desc: 'Someone comments a keyword, gets a public reply and a DM with the link.',
      build: () => tpl([
        ['t', 'trigger', 60, 180, { on: 'comment', keywords: ['link'] }],
        ['c', 'comment_reply', 400, 60, { variants: ['Sent you a DM 📩', 'Check your inbox ✅'] }],
        ['m', 'message', 400, 260, { text: 'Hey {{first_name}}! Want the link? 👇', quick: ['Yes please'] }],
        ['l', 'message', 760, 200, { text: 'Here you go 🎉', buttons: [{ title: 'Open the link', kind: 'url', url: 'https://example.com' }] }],
        ['o', 'message', 760, 420, { text: 'Just reply "Yes please" and I will send it right over.' }],
      ], [['t', 'next', 'c'], ['c', 'next', 'm'], ['m', 'q0', 'l'], ['m', 'other', 'o']]),
    },
    {
      key: 'welcome', name: 'Welcome menu', icon: 'chat', desc: 'Greet first-time messages with a menu of choices.',
      build: () => tpl([
        ['t', 'trigger', 60, 200, { on: 'welcome', match_mode: 'any' }],
        ['m', 'message', 400, 160, { text: 'Hi {{first_name}} 👋 Thanks for reaching out! What can we help with?', quick: ['Pricing', 'Book a call', 'Talk to a human'] }],
        ['p', 'message', 780, 20, { text: 'Our plans start at ₹999/month. Full details here 👇', buttons: [{ title: 'See pricing', kind: 'url', url: 'https://example.com/pricing' }] }],
        ['b', 'message', 780, 200, { text: 'Pick a time that suits you 📅', buttons: [{ title: 'Book a call', kind: 'url', url: 'https://example.com/book' }] }],
        ['h', 'handoff', 780, 380, { pause_hours: 24 }],
        ['o', 'message', 780, 520, { text: 'Got it! Someone from the team will reply here soon.' }],
      ], [['t', 'next', 'm'], ['m', 'q0', 'p'], ['m', 'q1', 'b'], ['m', 'q2', 'h'], ['m', 'other', 'o']]),
    },
    {
      key: 'lead', name: 'Collect emails', icon: 'send', desc: 'Ask for an email, check it, tag the lead and send the freebie.',
      build: () => tpl([
        ['t', 'trigger', 40, 200, { on: 'dm', keywords: ['guide', 'freebie'] }],
        ['a', 'message', 380, 200, { text: 'Happy to send it! What is your email address? 📧' }],
        ['w', 'wait_reply', 720, 200, { save_as: 'email', validate: 'email', timeout_minutes: 60 }],
        ['g', 'tag', 1060, 60, { action: 'add', tag: 'lead' }],
        ['s', 'message', 1400, 60, { text: 'Thanks! The guide is on its way to {{email}} 🎁', buttons: [{ title: 'Download now', kind: 'url', url: 'https://example.com/guide' }] }],
        ['i', 'message', 1060, 300, { text: 'Hmm, that does not look like an email. Could you check it?' }],
        ['x', 'message', 1060, 480, { text: 'Still want the guide? Just reply with your email 🙂' }],
      ], [['t', 'next', 'a'], ['a', 'next', 'w'], ['w', 'reply', 'g'], ['g', 'next', 's'], ['w', 'invalid', 'i'], ['i', 'next', 'w'], ['w', 'timeout', 'x']]),
    },
    {
      key: 'story', name: 'Thank story mentions', icon: 'star', desc: 'Thank people who mention you in their story, after a short pause.',
      build: () => tpl([
        ['t', 'trigger', 60, 160, { on: 'story_mention', match_mode: 'any' }],
        ['d', 'delay', 400, 160, { amount: 2, unit: 'minutes' }],
        ['m', 'message', 740, 160, { text: 'Thank you so much for the mention {{first_name}}! 💜' }],
        ['g', 'tag', 1080, 160, { action: 'add', tag: 'mentioned us' }],
      ], [['t', 'next', 'd'], ['d', 'next', 'm'], ['m', 'next', 'g']]),
    },
  ];

  // ------------------------------------------------------------------ flows list

  views.flows = async () => {
    const g = D.gen();
    const flows = await api('/flows');
    if (g !== D.gen()) return;
    main.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>Your flows</h2><p>${flows.length} flow${flows.length === 1 ? '' : 's'} · ${flows.filter((f) => f.enabled).length} live</p></div>
          <button class="btn primary" id="new-flow" type="button">${ic('plus')}New flow</button></div>
        ${flows.length ? `<div class="flow-grid">${flows.map((f) => `
          <article class="flow-card" data-open="${f.id}" tabindex="0">
            <div class="fc-top">
              <div class="fc-ico">${bi('flow')}</div>
              <div class="grow"><b>${esc(f.name)}</b><span>${esc(trigSummary(f.trigger))}</span></div>
              <input class="switch" type="checkbox" data-live="${f.id}" ${f.enabled ? 'checked' : ''} aria-label="Turn ${esc(f.name)} on or off">
              <button class="kebab" type="button" data-pop data-fmenu="${f.id}" aria-label="More">${ic('more')}</button>
            </div>
            <div class="fc-stats">
              <span><b>${f.steps}</b> step${f.steps === 1 ? '' : 's'}</span><span><b>${D.num(f.runs)}</b> runs</span><span><b>${D.num(f.active)}</b> in progress</span>
              ${f.errors ? `<span class="pill bad">${f.errors} problem${f.errors === 1 ? '' : 's'}</span>` : f.enabled ? '<span class="pill ok">Live</span>' : '<span class="pill">Draft</span>'}
            </div>
            <div class="fc-foot">Edited ${esc(D.ago(f.updated_at))}</div>
          </article>`).join('')}</div>`
        : `<div class="empty flow-empty">${bi('flow')}<b>Build your first flow</b><span>Drag steps onto a canvas and connect them: buttons, questions, conditions, delays and tags.</span>
            <button class="btn primary" id="new-flow-2" type="button">${ic('plus')}New flow</button></div>`}
      </section>`;
    const create = () => newFlowModal();
    $('#new-flow').onclick = create;
    if ($('#new-flow-2')) $('#new-flow-2').onclick = create;
    $$('[data-open]').forEach((c) => {
      c.onclick = (e) => { if (!e.target.closest('input,button')) location.hash = `#flow/${c.dataset.open}`; };
      c.onkeydown = (e) => { if (e.key === 'Enter' && e.target === c) location.hash = `#flow/${c.dataset.open}`; };
    });
    $$('[data-live]').forEach((t) => (t.onchange = async () => {
      try {
        await api(`/flows/${t.dataset.live}/toggle`, { method: 'POST' });
        toast(t.checked ? 'Flow is live' : 'Flow turned off');
      } catch (e) {
        t.checked = !t.checked;
        toast(e.message, true);
      }
      views.flows();
    }));
    $$('[data-fmenu]').forEach((b) => (b.onclick = () => {
      const f = flows.find((x) => x.id == b.dataset.fmenu);
      popover(b, [
        { icon: 'edit', label: 'Open builder', onClick: () => (location.hash = `#flow/${f.id}`) },
        { icon: 'more', label: 'Duplicate', onClick: async () => { await api(`/flows/${f.id}/duplicate`, { method: 'POST' }); toast('Flow duplicated'); views.flows(); } },
        '-',
        { icon: 'trash', label: 'Delete', danger: true, onClick: async () => { if (!confirm(`Delete "${f.name}"? People in the middle of it will stop receiving messages.`)) return; await api(`/flows/${f.id}`, { method: 'DELETE' }); views.flows(); } },
      ]);
    }));
  };

  function newFlowModal() {
    const box = openModal(`${modalHead('New flow')}
      <form class="form" id="nf">
        <label>Name<input name="name" placeholder="e.g. Comment LINK → send link" maxlength="80" required></label>
        <div class="tpl-grid">${TEMPLATES.map((t, i) => `
          <label class="tpl"><input type="radio" name="tpl" value="${t.key}" ${i === 0 ? 'checked' : ''}>
            <span class="tpl-ico">${bi(t.icon)}</span><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></label>`).join('')}</div>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" id="nf-cancel">Cancel</button><button class="btn primary">Create and open</button></div>
      </form>`);
    $('#nf-cancel', box).onclick = closeModal;
    $('#nf', box).onsubmit = run(async (e) => {
      e.preventDefault();
      const f = e.target;
      const t = TEMPLATES.find((x) => x.key === f.tpl.value) || TEMPLATES[0];
      const { id } = await api('/flows', { method: 'POST', body: { name: f.name.value.trim() || t.name, graph: t.build() } });
      closeModal();
      location.hash = `#flow/${id}`;
    });
    setTimeout(() => $('input[name=name]', box)?.focus(), 30);
  }

  // ------------------------------------------------------------------ builder state

  let F = null; // { id, name, enabled, graph, stats, issues }
  let V = { x: 0, y: 0, k: 1 }; // canvas pan and zoom
  let sel = null; // { kind: 'node' | 'edge', id }
  let dirty = false;
  let undoStack = [];
  let redoStack = [];
  let editSnap = null;
  let media = [];
  let simOpen = false;
  let els = {};

  const active = () => !!F && document.body.classList.contains('builder-mode') && !!$('.fb');
  const byId = (id) => F.graph.nodes.find((n) => n.id === id);
  const nodeEl = (id) => els.nodes.querySelector(`.fn[data-id="${CSS.escape(id)}"]`);
  const snap = () => JSON.stringify({ name: F.name, graph: F.graph });
  function checkpoint() {
    undoStack.push(snap());
    if (undoStack.length > 80) undoStack.shift();
    redoStack = [];
  }
  function restore(s) {
    const o = JSON.parse(s);
    F.name = o.name;
    F.graph = o.graph;
    els.name.value = F.name;
    if (sel && (sel.kind === 'node' ? !byId(sel.id) : !F.graph.edges.some((e) => e.id === sel.id))) sel = null;
    renderAll();
    changed(true);
  }
  function undo() { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); }
  function redo() { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); }

  function changed(structural) {
    dirty = true;
    paintBar();
    validateSoon();
    if (structural) renderInspector();
  }

  D.guard = () => !active() || !dirty || confirm('You have unsaved changes in this flow. Leave without saving?');
  window.addEventListener('beforeunload', (e) => { if (active() && dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ------------------------------------------------------------------ builder page

  views.flow = async () => {
    const g = D.gen();
    const id = Number((location.hash.split('/')[1] || '').replace(/\D/g, ''));
    if (!id) { location.hash = '#flows'; return; }
    const [flow, m] = await Promise.all([api(`/flows/${id}`), api('/media').catch(() => [])]);
    if (g !== D.gen()) return;
    F = { id: flow.id, name: flow.name, enabled: !!flow.enabled, graph: flow.graph, stats: flow.stats, issues: flow.issues };
    media = m;
    sel = null; dirty = false; undoStack = []; redoStack = []; simOpen = false;

    const groups = ['Start', 'Send', 'Logic', 'Actions'];
    main.innerHTML = `
      <div class="fb">
        <header class="fb-bar">
          <a class="fb-ibtn" href="#flows" aria-label="Back to flows">${bi('back')}</a>
          <input class="fb-name" id="fb-name" value="${esc(F.name)}" maxlength="80" aria-label="Flow name">
          <span class="fb-state" id="fb-state"></span>
          <div class="fb-tools">
            <button class="fb-ibtn mob-only" id="fb-pal" type="button" aria-label="Add step">${ic('plus')}</button>
            <span class="fb-sep desk-only"></span>
            <button class="fb-ibtn desk-only" id="fb-undo" type="button" title="Undo (Ctrl+Z)" aria-label="Undo">${bi('undo')}</button>
            <button class="fb-ibtn desk-only" id="fb-redo" type="button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${bi('redo')}</button>
            <span class="fb-sep desk-only"></span>
            <button class="fb-ibtn desk-only" id="fb-zout" type="button" aria-label="Zoom out">${bi('minus')}</button>
            <button class="fb-zoom desk-only" id="fb-zlabel" type="button" title="Reset zoom">100%</button>
            <button class="fb-ibtn desk-only" id="fb-zin" type="button" aria-label="Zoom in">${ic('plus')}</button>
            <button class="fb-ibtn" id="fb-fit" type="button" title="Fit to screen" aria-label="Fit to screen">${bi('fit')}</button>
            <span class="fb-sep desk-only"></span>
            <button class="fb-issues" id="fb-issues" type="button" hidden></button>
            <button class="btn small fb-test" id="fb-test" type="button">${bi('flask')}<span class="desk-only">Test</span></button>
            <label class="fb-live" title="When live, this flow answers real people"><input class="switch" type="checkbox" id="fb-live" ${F.enabled ? 'checked' : ''}><span class="desk-only">Live</span></label>
            <button class="btn primary small" id="fb-save" type="button">${bi('save')}<span class="desk-only">Save</span></button>
          </div>
        </header>
        <div class="fb-body">
          <aside class="fb-palette" id="fb-palette">
            <div class="fb-pal-head"><b>Steps</b><span>Drag onto the canvas, or click to add</span><button class="fb-ibtn mob-only" id="fb-pal-x" type="button" aria-label="Close">${ic('x')}</button></div>
            ${groups.map((gr) => `<div class="fb-group"><h4>${gr}</h4>${Object.entries(T).filter(([, t]) => t.group === gr).map(([k, t]) => `
              <div class="fb-item" data-add="${k}" role="button" tabindex="0" style="--c:${t.color}">
                <span class="fb-item-ico">${bi(t.icon)}</span><span><b>${t.label}</b><small>${t.desc}</small></span>
              </div>`).join('')}</div>`).join('')}
          </aside>
          <div class="fb-canvas" id="fb-canvas" tabindex="0" aria-label="Flow canvas">
            <div class="fb-world" id="fb-world">
              <svg class="fb-wires" id="fb-wires" aria-hidden="true"><path class="wire temp" id="fb-temp" d=""/></svg>
              <div id="fb-nodes"></div>
              <button class="fb-edge-x" id="fb-edge-x" type="button" hidden aria-label="Delete connection">${ic('x')}</button>
            </div>
            <div class="fb-hint" id="fb-hint"></div>
          </div>
          <aside class="fb-inspector" id="fb-insp"></aside>
        </div>
      </div>`;

    els = {
      canvas: $('#fb-canvas'), world: $('#fb-world'), nodes: $('#fb-nodes'), wires: $('#fb-wires'), temp: $('#fb-temp'),
      insp: $('#fb-insp'), name: $('#fb-name'), edgeX: $('#fb-edge-x'), root: $('.fb'), palette: $('#fb-palette'),
    };
    bindBar();
    bindCanvas();
    bindPalette();
    bindInspector();
    renderAll();
    requestAnimationFrame(() => fit(false));
    paintBar();
    paintIssues();
  };

  // ------------------------------------------------------------------ rendering

  function nodeSummary(n) {
    const d = n.data;
    switch (n.type) {
      case 'trigger': {
        const post = d.on === 'comment' ? (d.media_id ? `<div class="fn-note">${ic('image')} One specific post</div>` : '<div class="fn-note">On any post</div>') : '';
        const any = d.match_mode === 'any' || d.on === 'welcome' || d.on === 'story_mention';
        return `<div class="fn-kicker">${esc(TRIG[d.on])}</div>${any ? '<div class="fn-muted">Any message</div>'
          : d.keywords.length ? `<div class="fn-chips">${d.match_mode === 'exact' ? '<em>is exactly</em>' : '<em>contains</em>'}${d.keywords.slice(0, 6).map((k) => `<span>${esc(k)}</span>`).join('')}${d.keywords.length > 6 ? `<span>+${d.keywords.length - 6}</span>` : ''}</div>`
          : '<div class="fn-muted warn">Add keywords</div>'}${post}`;
      }
      case 'message': {
        const links = d.buttons.filter((b) => b.kind === 'url');
        return `${d.text.trim() ? `<div class="fn-text">${varsHtml(d.text.length > 180 ? d.text.slice(0, 180) + '…' : d.text)}</div>` : '<div class="fn-muted warn">Write a message…</div>'}
          ${links.map((b) => `<div class="fn-link">${bi('globe')}${esc(b.title || 'Link')}</div>`).join('')}`;
      }
      case 'media':
        return d.url ? (d.kind === 'video' ? `<div class="fn-text">${ic('play')} Video</div>` : `<img class="fn-img" src="${esc(d.url)}" alt="" loading="lazy" draggable="false">`) : '<div class="fn-muted warn">Upload an image</div>';
      case 'wait_reply':
        return `<div class="fn-text">${d.save_as ? `Saves the answer as <span class="fv">{{${esc(d.save_as)}}}</span>` : 'Waits for their next message'}</div>${d.validate !== 'any' ? `<div class="fn-note">Must be a valid ${esc(d.validate)}</div>` : ''}`;
      case 'condition': {
        const subj = d.check === 'tag' ? 'Contact has tag' : d.check === 'variable' ? `<span class="fv">{{${esc(d.variable || '?')}}}</span>` : 'Last message';
        const op = d.check === 'tag' ? '' : d.op === 'is_set' ? 'is not empty' : d.op === 'exact' ? 'is exactly' : 'contains';
        return `<div class="fn-text">${subj} ${op}</div>${d.op !== 'is_set' || d.check === 'tag' ? `<div class="fn-chips">${d.values.slice(0, 6).map((k) => `<span>${esc(k)}</span>`).join('') || '<span class="warn">add a value</span>'}</div>` : ''}`;
      }
      case 'delay': return `<div class="fn-big">${d.amount} ${d.unit === 'hours' ? (d.amount === 1 ? 'hour' : 'hours') : (d.amount === 1 ? 'minute' : 'minutes')}</div>`;
      case 'comment_reply': return d.variants.length ? `<div class="fn-text">“${esc(d.variants[0])}”</div>${d.variants.length > 1 ? `<div class="fn-note">+${d.variants.length - 1} variation${d.variants.length > 2 ? 's' : ''}, picked at random</div>` : ''}` : '<div class="fn-muted warn">Write a public reply</div>';
      case 'tag': return d.tag ? `<div class="fn-text">${d.action === 'add' ? 'Add' : 'Remove'} <span class="fn-tag">${esc(d.tag)}</span></div>` : '<div class="fn-muted warn">Name the tag</div>';
      case 'split': return `<div class="fn-bar"><i style="width:${d.percent_a}%"></i></div>`;
      case 'handoff': return `<div class="fn-text">Stops the bot for this person${d.pause_hours ? ` for ${d.pause_hours}h` : ''} so you can reply yourself.</div>`;
      default: return '';
    }
  }

  function nodeHtml(n) {
    const t = T[n.type];
    const hits = F.stats?.hits?.[n.id] || 0;
    const ports = portsOf(n);
    const selected = sel?.kind === 'node' && sel.id === n.id;
    return `<div class="fn ${selected ? 'sel' : ''}" data-id="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px;--c:${t.color}">
      ${n.type !== 'trigger' ? '<i class="fn-in" data-in></i>' : ''}
      <div class="fn-head"><span class="fn-ico">${bi(t.icon)}</span><b>${t.label}</b>${hits ? `<span class="fn-hits" title="Times this step ran">${D.num(hits)}</span>` : ''}<span class="fn-flag" hidden></span></div>
      <div class="fn-body">${nodeSummary(n)}</div>
      ${ports.length ? `<div class="fn-ports ${ports.length === 1 && ports[0] === 'next' ? 'solo' : ''}">${ports.map((p) => `
        <div class="fn-port" data-port="${p}"><span>${esc(portLabel(n, p))}</span><i class="fn-out" data-out="${p}" style="--pc:${portColor(n, p)}"></i></div>`).join('')}</div>` : '<div class="fn-end">End of flow</div>'}
    </div>`;
  }

  function renderAll() {
    els.nodes.innerHTML = F.graph.nodes.map(nodeHtml).join('');
    drawWires();
    paintIssues();
    renderInspector();
    hint();
  }
  function renderNode(id) {
    const n = byId(id);
    const old = nodeEl(id);
    if (!n || !old) return;
    old.outerHTML = nodeHtml(n);
    drawWires();
    paintIssues();
  }
  function hint() {
    const h = $('#fb-hint');
    if (!h) return;
    const only = F.graph.nodes.length <= 1;
    h.innerHTML = only ? `${bi('grid')}<span>Drag a step from the left, then pull a wire from a step's dot to connect them.</span>` : '';
    h.hidden = !only;
  }

  function offsetIn(el, root) {
    let y = 0;
    let cur = el;
    while (cur && cur !== root) { y += cur.offsetTop; cur = cur.offsetParent; }
    return y;
  }
  function outPos(n, port) {
    const el = nodeEl(n.id);
    const dot = el?.querySelector(`[data-out="${port}"]`);
    if (!el || !dot) return null;
    return { x: n.x + el.offsetWidth, y: n.y + offsetIn(dot, el) + dot.offsetHeight / 2 };
  }
  const inPos = (n) => ({ x: n.x, y: n.y + 26 });
  function curve(a, b) {
    const dx = Math.max(50, Math.abs(b.x - a.x) * 0.5);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }
  function drawWires() {
    const parts = [];
    let mid = null;
    for (const e of F.graph.edges) {
      const a = byId(e.from);
      const b = byId(e.to);
      if (!a || !b) continue;
      const p1 = outPos(a, e.port);
      if (!p1) continue;
      const p2 = inPos(b);
      const on = sel?.kind === 'edge' && sel.id === e.id;
      const near = sel?.kind === 'node' && (sel.id === e.from || sel.id === e.to);
      const d = curve(p1, p2);
      parts.push(`<path class="wire ${on ? 'on' : ''} ${near ? 'near' : ''}" d="${d}" style="--wc:${portColor(a, e.port)}"/><circle class="wire-end" cx="${p2.x}" cy="${p2.y}" r="3.5" style="--wc:${portColor(a, e.port)}"/><path class="hit" data-edge="${esc(e.id)}" d="${d}"/>`);
      if (on) mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    }
    els.wires.innerHTML = parts.join('') + '<path class="wire temp" id="fb-temp" d=""/>';
    els.temp = $('#fb-temp');
    els.edgeX.hidden = !mid;
    if (mid) { els.edgeX.style.left = `${mid.x}px`; els.edgeX.style.top = `${mid.y}px`; }
  }

  function applyView() {
    els.world.style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.k})`;
    const s = 24 * V.k;
    els.canvas.style.backgroundSize = `${s}px ${s}px`;
    els.canvas.style.backgroundPosition = `${V.x}px ${V.y}px`;
    const z = $('#fb-zlabel');
    if (z) z.textContent = `${Math.round(V.k * 100)}%`;
  }
  function zoomAt(k, cx, cy) {
    const nk = Math.min(1.8, Math.max(0.25, k));
    V.x = cx - (cx - V.x) * (nk / V.k);
    V.y = cy - (cy - V.y) * (nk / V.k);
    V.k = nk;
    applyView();
  }
  function zoomBy(f) {
    const r = els.canvas.getBoundingClientRect();
    zoomAt(V.k * f, r.width / 2, r.height / 2);
  }
  function fit(animate = true) {
    const r = els.canvas.getBoundingClientRect();
    if (!F.graph.nodes.length || !r.width) { V = { x: 80, y: 80, k: 1 }; applyView(); return; }
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
    for (const n of F.graph.nodes) {
      const el = nodeEl(n.id);
      x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y);
      x2 = Math.max(x2, n.x + (el?.offsetWidth || 260)); y2 = Math.max(y2, n.y + (el?.offsetHeight || 120));
    }
    const pad = 60;
    const k = Math.min(1.1, Math.max(0.25, Math.min((r.width - pad * 2) / (x2 - x1), (r.height - pad * 2) / (y2 - y1))));
    V = { k, x: (r.width - (x2 - x1) * k) / 2 - x1 * k, y: (r.height - (y2 - y1) * k) / 2 - y1 * k };
    els.world.classList.toggle('anim', animate);
    applyView();
    setTimeout(() => els.world?.classList.remove('anim'), 260);
  }
  const toWorld = (cx, cy) => {
    const r = els.canvas.getBoundingClientRect();
    return { x: (cx - r.left - V.x) / V.k, y: (cy - r.top - V.y) / V.k };
  };
  function centerOn(id) {
    const n = byId(id);
    const el = nodeEl(id);
    if (!n || !el) return;
    const r = els.canvas.getBoundingClientRect();
    V.x = r.width / 2 - (n.x + el.offsetWidth / 2) * V.k;
    V.y = r.height / 2 - (n.y + el.offsetHeight / 2) * V.k;
    els.world.classList.add('anim');
    applyView();
    setTimeout(() => els.world?.classList.remove('anim'), 260);
  }

  // ------------------------------------------------------------------ graph edits

  function select(s) {
    sel = s;
    $$('.fn', els.nodes).forEach((el) => el.classList.toggle('sel', s?.kind === 'node' && el.dataset.id === s.id));
    drawWires();
    renderInspector();
    els.root.classList.toggle('show-insp', !!s || simOpen);
    if (s?.kind === 'node' && innerWidth <= 900) {
      const n = byId(s.id);
      const el = nodeEl(s.id);
      const r = els.canvas.getBoundingClientRect();
      if (n && el) {
        V.x = r.width / 2 - (n.x + el.offsetWidth / 2) * V.k;
        V.y = r.height * 0.2 - n.y * V.k;
        els.world.classList.add('anim');
        applyView();
        setTimeout(() => els.world?.classList.remove('anim'), 260);
      }
    }
  }
  function freeSpot(x, y) {
    let tries = 0;
    while (tries++ < 30 && F.graph.nodes.some((n) => Math.abs(n.x - x) < 120 && Math.abs(n.y - y) < 80)) y += 90;
    return { x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10 };
  }
  function addNode(type, at, link) {
    if (type === 'trigger' && F.graph.nodes.some((n) => n.type === 'trigger')) { toast('A flow has exactly one trigger. Edit the existing one instead.', true); return; }
    checkpoint();
    const pos = freeSpot(at.x, at.y);
    const n = { id: uid('n'), type, x: pos.x, y: pos.y, data: DEF[type]() };
    F.graph.nodes.push(n);
    if (link) {
      F.graph.edges = F.graph.edges.filter((e) => !(e.from === link.from && e.port === link.port));
      F.graph.edges.push({ id: uid('e'), from: link.from, port: link.port, to: n.id });
    }
    els.nodes.insertAdjacentHTML('beforeend', nodeHtml(n));
    hint();
    select({ kind: 'node', id: n.id });
    changed(false);
    return n;
  }
  /** Adding from the palette: place to the right of the selected step and connect its first free output. */
  function addFromPalette(type) {
    const from = sel?.kind === 'node' ? byId(sel.id) : null;
    if (from) {
      const free = portsOf(from).find((p) => !F.graph.edges.some((e) => e.from === from.id && e.port === p));
      const el = nodeEl(from.id);
      if (free && type !== 'trigger') {
        addNode(type, { x: from.x + (el?.offsetWidth || 260) + 90, y: from.y }, { from: from.id, port: free });
        return;
      }
    }
    const r = els.canvas.getBoundingClientRect();
    const c = toWorld(r.left + r.width / 2 - 130, r.top + r.height / 2 - 60);
    addNode(type, c);
  }
  function connect(from, port, to) {
    if (from === to || byId(to)?.type === 'trigger') return;
    checkpoint();
    F.graph.edges = F.graph.edges.filter((e) => !(e.from === from && e.port === port));
    F.graph.edges.push({ id: uid('e'), from, port, to });
    drawWires();
    changed(false);
  }
  function removeSel() {
    if (!sel) return;
    checkpoint();
    if (sel.kind === 'edge') {
      F.graph.edges = F.graph.edges.filter((e) => e.id !== sel.id);
    } else {
      F.graph.nodes = F.graph.nodes.filter((n) => n.id !== sel.id);
      F.graph.edges = F.graph.edges.filter((e) => e.from !== sel.id && e.to !== sel.id);
      nodeEl(sel.id)?.remove();
    }
    sel = null;
    drawWires();
    hint();
    select(null);
    changed(false);
  }
  function duplicate(id) {
    const n = byId(id);
    if (!n || n.type === 'trigger') return;
    checkpoint();
    const c = { ...clone(n), id: uid('n'), x: n.x + 40, y: n.y + 40 };
    F.graph.nodes.push(c);
    els.nodes.insertAdjacentHTML('beforeend', nodeHtml(c));
    select({ kind: 'node', id: c.id });
    changed(false);
  }
  /** Drop connections from outputs that no longer exist, optionally renumbering after a list item was removed. */
  function fixPorts(n, prefix, removedIdx) {
    if (prefix !== undefined) {
      for (const e of F.graph.edges) {
        if (e.from !== n.id || e.port[0] !== prefix) continue;
        const i = Number(e.port.slice(1));
        if (i === removedIdx) e.port = '__gone';
        else if (i > removedIdx) e.port = `${prefix}${i - 1}`;
      }
    }
    const valid = new Set(portsOf(n));
    F.graph.edges = F.graph.edges.filter((e) => e.from !== n.id || valid.has(e.port));
  }

  // ------------------------------------------------------------------ canvas interaction

  let gesture = null;
  const pointers = new Map();
  let spaceDown = false;

  function bindCanvas() {
    const cv = els.canvas;
    cv.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), k: V.k };
        return;
      }
      if (e.button === 2) return;
      const t = e.target;
      if (t.closest('.fb-edge-x')) return;
      cv.setPointerCapture(e.pointerId);
      const out = t.closest('[data-out]');
      const node = t.closest('.fn');
      const hit = t.closest('[data-edge]');
      if (e.button === 1 || spaceDown) {
        gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: V.x, vy: V.y, moved: false };
      } else if (out && node) {
        gesture = { type: 'wire', from: node.dataset.id, port: out.dataset.out };
        els.root.classList.add('wiring');
      } else if (node) {
        const n = byId(node.dataset.id);
        if (!(sel?.kind === 'node' && sel.id === n.id)) select({ kind: 'node', id: n.id });
        gesture = { type: 'drag', id: n.id, sx: e.clientX, sy: e.clientY, nx: n.x, ny: n.y, moved: false, before: snap() };
      } else if (hit) {
        select({ kind: 'edge', id: hit.dataset.edge });
        gesture = null;
      } else {
        gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: V.x, vy: V.y, moved: false, empty: true };
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!gesture) return;
      if (gesture.type === 'pinch' && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const r = cv.getBoundingClientRect();
        zoomAt(gesture.k * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.d), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      } else if (gesture.type === 'pan') {
        const dx = e.clientX - gesture.sx;
        const dy = e.clientY - gesture.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) { gesture.moved = true; cv.classList.add('panning'); }
        V.x = gesture.vx + dx;
        V.y = gesture.vy + dy;
        applyView();
      } else if (gesture.type === 'drag') {
        const n = byId(gesture.id);
        const dx = (e.clientX - gesture.sx) / V.k;
        const dy = (e.clientY - gesture.sy) / V.k;
        if (Math.abs(dx) + Math.abs(dy) > 2) gesture.moved = true;
        n.x = Math.round((gesture.nx + dx) / 10) * 10;
        n.y = Math.round((gesture.ny + dy) / 10) * 10;
        const el = nodeEl(n.id);
        el.style.left = `${n.x}px`;
        el.style.top = `${n.y}px`;
        el.classList.add('dragging');
        drawWires();
      } else if (gesture.type === 'wire') {
        const a = outPos(byId(gesture.from), gesture.port);
        const b = toWorld(e.clientX, e.clientY);
        els.temp.setAttribute('d', curve(a, b));
        $$('.fn.drop').forEach((x) => x.classList.remove('drop'));
        const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.fn');
        if (over && over.dataset.id !== gesture.from && byId(over.dataset.id)?.type !== 'trigger') over.classList.add('drop');
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (!gesture) return;
      const g = gesture;
      gesture = null;
      cv.classList.remove('panning');
      if (g.type === 'pan' && g.empty && !g.moved) select(null);
      if (g.type === 'drag') {
        nodeEl(g.id)?.classList.remove('dragging');
        if (g.moved) { undoStack.push(g.before); redoStack = []; changed(false); }
      }
      if (g.type === 'wire') {
        els.root.classList.remove('wiring');
        els.temp.setAttribute('d', '');
        $$('.fn.drop').forEach((x) => x.classList.remove('drop'));
        const over = document.elementFromPoint(e.clientX, e.clientY);
        const target = over?.closest('.fn');
        if (target && target.dataset.id !== g.from) connect(g.from, g.port, target.dataset.id);
        else if (!target && over?.closest('.fb-canvas')) quickAdd(e.clientX, e.clientY, g);
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(V.k * Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
      else { V.x -= e.deltaX; V.y -= e.deltaY; applyView(); }
    }, { passive: false });
    cv.addEventListener('dblclick', (e) => {
      if (e.target.closest('.fn')) return;
      quickAdd(e.clientX, e.clientY, null);
    });
    els.edgeX.onclick = (e) => { e.stopPropagation(); removeSel(); };
    new ResizeObserver(() => drawWires()).observe(els.nodes);
  }

  /** Menu of steps at a point on the canvas; when it came from a dragged wire, the new step is connected. */
  function quickAdd(cx, cy, link) {
    D.closePop();
    $('.fb-menu')?.remove();
    const at = toWorld(cx, cy);
    const types = Object.keys(T).filter((k) => k !== 'trigger' || !F.graph.nodes.some((n) => n.type === 'trigger'));
    const menu = document.createElement('div');
    menu.className = 'pop fb-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `<div class="cap">${link ? 'Connect to a new step' : 'Add a step here'}</div>${types.map((k) =>
      `<button type="button" role="menuitem" data-k="${k}" style="--c:${T[k].color}"><span class="fb-mi">${bi(T[k].icon)}</span>${T[k].label}</button>`).join('')}`;
    document.body.appendChild(menu);
    menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, cx))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, cy))}px`;
    const close = (e) => { if (!e || !menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      close();
      addNode(b.dataset.k, { x: at.x, y: at.y - 26 }, link && { from: link.from, port: link.port });
    });
    menu.querySelector('button')?.focus();
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  function bindPalette() {
    $$('[data-add]', els.palette).forEach((item) => {
      item.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const type = item.dataset.add;
        const sx = e.clientX;
        const sy = e.clientY;
        let ghost = null;
        const move = (ev) => {
          if (!ghost && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) {
            ghost = document.createElement('div');
            ghost.className = 'fb-ghost';
            ghost.style.setProperty('--c', T[type].color);
            ghost.innerHTML = `${bi(T[type].icon)}<b>${T[type].label}</b>`;
            document.body.appendChild(ghost);
            els.root.classList.remove('show-pal');
          }
          if (ghost) { ghost.style.left = `${ev.clientX}px`; ghost.style.top = `${ev.clientY}px`; }
        };
        const up = (ev) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          if (!ghost) { addFromPalette(type); els.root.classList.remove('show-pal'); return; }
          ghost.remove();
          const r = els.canvas.getBoundingClientRect();
          if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
            const w = toWorld(ev.clientX, ev.clientY);
            addNode(type, { x: w.x - 20, y: w.y - 20 });
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addFromPalette(item.dataset.add); } });
    });
  }

  // Keyboard shortcuts (only while the builder is open).
  document.addEventListener('keydown', (e) => {
    if (!active()) return;
    if (e.code === 'Space' && !e.target.closest('input,textarea,select,[contenteditable]')) { spaceDown = true; els.canvas.classList.add('grab'); }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); run(save)(); return; }
    if (e.target.closest('input,textarea,select,[contenteditable]')) return;
    if (!$('#modal').hidden) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === 'd' && sel?.kind === 'node') { e.preventDefault(); duplicate(sel.id); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); removeSel(); }
    else if (e.key === 'Escape') select(null);
    else if (e.key === 'f' && !mod) fit();
    else if ((e.key === '=' || e.key === '+') && !mod) zoomBy(1.2);
    else if (e.key === '-' && !mod) zoomBy(1 / 1.2);
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; els.canvas?.classList.remove('grab'); } });

  // ------------------------------------------------------------------ toolbar, saving, validation

  function bindBar() {
    els.name.oninput = () => { F.name = els.name.value; dirty = true; paintBar(); };
    els.name.onfocus = () => { editSnap = snap(); };
    els.name.onblur = () => { if (editSnap && editSnap !== snap()) { undoStack.push(editSnap); redoStack = []; } editSnap = null; };
    $('#fb-undo').onclick = undo;
    $('#fb-redo').onclick = redo;
    $('#fb-zin').onclick = () => zoomBy(1.2);
    $('#fb-zout').onclick = () => zoomBy(1 / 1.2);
    $('#fb-zlabel').onclick = () => { const r = els.canvas.getBoundingClientRect(); zoomAt(1, r.width / 2, r.height / 2); };
    $('#fb-fit').onclick = () => fit();
    $('#fb-save').onclick = run(() => save());
    $('#fb-test').onclick = () => (simOpen ? closeSim() : openSim());
    $('#fb-pal').onclick = () => els.root.classList.toggle('show-pal');
    $('#fb-pal-x').onclick = () => els.root.classList.remove('show-pal');
    $('#fb-issues').onclick = () => {
      const first = (F.issues || []).find((i) => i.node && byId(i.node));
      if (first) { select({ kind: 'node', id: first.node }); centerOn(first.node); } else select(null);
    };
    $('#fb-live').onchange = async (e) => {
      const want = e.target.checked;
      try {
        await save(want);
        toast(want ? 'Flow is live: it now answers real people' : 'Flow turned off');
      } catch (err) {
        e.target.checked = !want;
        toast(err.message, true);
        if (want) $('#fb-issues').click();
      }
    };
  }

  function paintBar() {
    const st = $('#fb-state');
    if (!st) return;
    st.className = `fb-state ${dirty ? 'dirty' : F.enabled ? 'live' : ''}`;
    st.textContent = dirty ? 'Unsaved changes' : F.enabled ? 'Live · saved' : 'Draft · saved';
    $('#fb-undo').disabled = !undoStack.length;
    $('#fb-redo').disabled = !redoStack.length;
    $('#fb-live').checked = F.enabled;
  }

  async function save(enabled = F.enabled) {
    const res = await api(`/flows/${F.id}`, { method: 'PUT', body: { name: F.name, enabled, graph: F.graph } });
    F.enabled = res.enabled;
    F.issues = res.issues;
    dirty = false;
    paintBar();
    paintIssues();
    if (!sel) renderInspector();
    toast(enabled === F.enabled && res.issues.some((i) => i.level === 'warning') ? 'Saved, with warnings to review' : 'Flow saved');
  }

  const validateSoon = D.debounce(async () => {
    if (!F) return;
    try {
      const { issues } = await api('/flows/validate', { method: 'POST', body: { graph: F.graph } });
      F.issues = issues;
      paintIssues();
      if (!sel && !simOpen) renderInspector();
    } catch { /* shown on save */ }
  }, 450);

  function paintIssues() {
    if (!F || !els.nodes) return;
    const issues = F.issues || [];
    $$('.fn', els.nodes).forEach((el) => {
      const mine = issues.filter((i) => i.node === el.dataset.id);
      const errs = mine.filter((i) => i.level === 'error').length;
      el.classList.toggle('has-err', errs > 0);
      el.classList.toggle('has-warn', !errs && mine.length > 0);
      const flag = $('.fn-flag', el);
      if (flag) { flag.hidden = !mine.length; flag.innerHTML = mine.length ? bi('alert') : ''; flag.title = mine.map((i) => i.message).join('\n'); }
    });
    const b = $('#fb-issues');
    if (!b) return;
    const errs = issues.filter((i) => i.level === 'error').length;
    b.hidden = !issues.length;
    b.className = `fb-issues ${errs ? 'bad' : 'warn'}`;
    b.innerHTML = `${bi('alert')}<span>${issues.length}<span class="desk-only"> ${issues.length === 1 ? 'issue' : 'issues'}</span></span>`;
  }

  // ------------------------------------------------------------------ inspector

  const savedVars = () => [...new Set(F.graph.nodes.filter((n) => n.type === 'wait_reply' && n.data.save_as).map((n) => n.data.save_as))];
  const allTags = () => [...new Set(F.graph.nodes.filter((n) => n.type === 'tag' && n.data.tag).map((n) => n.data.tag))];
  const opt = (v, cur, label) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  const field = (label, html, hint = '') => `<label class="fi">${label}${hint ? `<span class="hint">${hint}</span>` : ''}${html}</label>`;
  const csv = (a) => esc((a || []).join(', '));
  const mediaLabel = (m) => `${new Date(m.timestamp).toLocaleDateString()} · ${(m.caption || m.media_type || 'post').slice(0, 40)}`;
  const isComment = () => F.graph.nodes.find((n) => n.type === 'trigger')?.data.on === 'comment';

  function inspectorFor(n) {
    const d = n.data;
    const chipsVars = ['first_name', 'username', 'name', ...savedVars()].map((v) => `<button type="button" class="chip" data-insert="{{${v}}}">{{${v}}}</button>`).join('');
    switch (n.type) {
      case 'trigger':
        return `
          ${field('Starts when', `<select data-f="on" data-re>${Object.entries(TRIG).map(([k, v]) => opt(k, d.on, v)).join('')}</select>`)}
          ${d.on === 'welcome' || d.on === 'story_mention' ? '<p class="fi-note">Runs for any message of this kind.</p>' : `
          ${field('And the text', `<select data-f="match_mode" data-re>${opt('contains', d.match_mode, 'contains a keyword')}${opt('exact', d.match_mode, 'is exactly a keyword')}${opt('any', d.match_mode, 'is anything')}</select>`)}
          ${d.match_mode !== 'any' ? field('Keywords', `<input data-f="keywords" data-csv value="${csv(d.keywords)}" placeholder="price, link, info">`, 'Comma separated, not case-sensitive. Whole words only.') : ''}`}
          ${d.on === 'comment' ? field('Which post', `<select data-f="media_id" data-null>${opt('', d.media_id || '', 'Any post')}${media.map((m) => opt(m.id, d.media_id || '', mediaLabel(m))).join('')}</select>`, media.length ? '' : 'Your recent posts appear here once Instagram is connected.') : ''}
          <div class="fi-cols">
            ${field('Cooldown (min)', `<input type="number" min="0" data-f="cooldown_minutes" data-num value="${d.cooldown_minutes}">`, 'Once per person per…')}
            ${field('Priority', `<input type="number" min="-100" max="100" data-f="priority" data-num value="${d.priority}">`, 'Higher wins')}
          </div>
          <p class="fi-note">If a simple automation matches the same message, the one with the higher priority answers. On a tie, the flow wins.</p>`;
      case 'message': {
        const limit = d.buttons.length ? 640 : 1000;
        return `
          ${field('Message', `<textarea data-f="text" rows="5" placeholder="Hey {{first_name}}! 👋">${esc(d.text)}</textarea>`)}
          <div class="fi-chips">${chipsVars}<span class="fi-count" id="fi-count">${[...d.text].length}/${limit}</span></div>
          <div class="fi-sec"><div class="fi-sec-head"><b>Buttons</b><span>${d.buttons.length}/3</span></div>
            ${d.buttons.map((b, i) => `<div class="fi-row">
              <input data-f="buttons.${i}.title" value="${esc(b.title)}" maxlength="20" placeholder="Button title">
              <select data-f="buttons.${i}.kind" data-re>${opt('url', b.kind, 'Opens a link')}${opt('flow', b.kind, 'Continues the flow')}</select>
              ${b.kind === 'url' ? `<input data-f="buttons.${i}.url" value="${esc(b.url)}" placeholder="https://…" class="full">` : '<span class="fi-tip full">Adds an output on the step for this button.</span>'}
              <button type="button" class="fi-x" data-del="buttons.${i}" aria-label="Remove button">${ic('x')}</button></div>`).join('')}
            ${d.buttons.length < 3 ? `<button type="button" class="btn small ghost" data-push="buttons">${ic('plus')}Add button</button>` : ''}
          </div>
          ${d.buttons.length ? '<p class="fi-note">Quick replies are not available on a message with buttons.</p>' : `
          <div class="fi-sec"><div class="fi-sec-head"><b>Quick replies</b><span>${d.quick.length}/13</span></div>
            ${d.quick.map((q, i) => `<div class="fi-row"><input data-f="quick.${i}" value="${esc(q)}" maxlength="20" placeholder="Reply option" class="grow"><button type="button" class="fi-x" data-del="quick.${i}" aria-label="Remove">${ic('x')}</button></div>`).join('')}
            ${d.quick.length < 13 ? `<button type="button" class="btn small ghost" data-push="quick">${ic('plus')}Add quick reply</button>` : ''}
            <p class="fi-tip">Each one gets its own output. "Any other reply" catches anything else they type.</p>
          </div>`}
          ${isComment() ? '<p class="fi-note warn">If this is the first reply to a comment, Instagram only allows plain text: links and choices are written into the message, and the flow continues when they reply.</p>' : ''}`;
      }
      case 'media':
        return `
          ${field('Type', `<select data-f="kind" data-re>${opt('image', d.kind, 'Image')}${opt('video', d.kind, 'Video')}</select>`)}
          ${d.url && d.kind === 'image' ? `<img class="fi-img" src="${esc(d.url)}" alt="">` : ''}
          ${field('File', `<input type="file" id="fi-upload" accept="${d.kind === 'video' ? 'video/mp4,video/quicktime' : 'image/*'}">`, 'Uploads to your server so Instagram can fetch it.')}
          ${field('…or a link', `<input data-f="url" value="${esc(d.url)}" placeholder="https://…">`)}`;
      case 'wait_reply':
        return `
          <p class="fi-note">The flow pauses here until the person sends their next message.</p>
          ${field('Save the answer as', `<input data-f="save_as" data-var value="${esc(d.save_as)}" placeholder="e.g. email">`, 'Use it later as {{name}}. Letters, numbers and _.')}
          ${field('Check the answer', `<select data-f="validate" data-re>${opt('any', d.validate, 'Accept anything')}${opt('email', d.validate, 'Must be an email')}${opt('phone', d.validate, 'Must be a phone number')}${opt('number', d.validate, 'Must be a number')}</select>`)}
          ${field('Give up after (minutes)', `<input type="number" min="0" max="1439" data-f="timeout_minutes" data-num data-re value="${d.timeout_minutes}">`, '0 = wait up to 24 hours. Adds a "No reply" output.')}`;
      case 'condition':
        return `
          ${field('Check', `<select data-f="check" data-re>${opt('text', d.check, 'Their last message')}${opt('variable', d.check, 'A saved answer')}${opt('tag', d.check, 'A contact tag')}</select>`)}
          ${d.check === 'variable' ? field('Saved answer', savedVars().length ? `<select data-f="variable">${opt('', d.variable, 'Choose…')}${savedVars().map((v) => opt(v, d.variable, `{{${v}}}`)).join('')}</select>` : `<input data-f="variable" data-var value="${esc(d.variable)}" placeholder="e.g. email">`, savedVars().length ? '' : 'Add a "Wait for reply" step that saves an answer first.') : ''}
          ${d.check !== 'tag' ? field('Rule', `<select data-f="op" data-re>${opt('contains', d.op, 'contains any of')}${opt('exact', d.op, 'is exactly one of')}${opt('is_set', d.op, 'is not empty')}</select>`) : ''}
          ${d.check === 'tag' || d.op !== 'is_set' ? field(d.check === 'tag' ? 'Has any of these tags' : 'Values', `<input data-f="values" data-csv value="${csv(d.values)}" list="fi-tags" placeholder="${d.check === 'tag' ? 'vip, lead' : 'yes, sure, ok'}"><datalist id="fi-tags">${allTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`, 'Comma separated') : ''}`;
      case 'delay':
        return `
          <div class="fi-cols">${field('Wait', `<input type="number" min="1" data-f="amount" data-num value="${d.amount}">`)}${field('Unit', `<select data-f="unit" data-re>${opt('minutes', d.unit, 'minutes')}${opt('hours', d.unit, 'hours')}</select>`)}</div>
          <p class="fi-note">Up to 23 hours: Instagram only allows messages within 24 hours of the person's last message.</p>`;
      case 'comment_reply':
        return `${field('Public replies', `<textarea data-f="variants" data-lines rows="4" placeholder="Sent you a DM 📩&#10;Check your inbox ✅">${esc(d.variants.join('\n'))}</textarea>`, 'One per line. A random one is used each time.')}
          ${!isComment() ? '<p class="fi-note warn">Only works when the trigger is a comment.</p>' : ''}`;
      case 'tag':
        return `${field('Action', `<select data-f="action" data-re>${opt('add', d.action, 'Add tag')}${opt('remove', d.action, 'Remove tag')}</select>`)}
          ${field('Tag', `<input data-f="tag" value="${esc(d.tag)}" maxlength="30" list="fi-tags" placeholder="e.g. lead"><datalist id="fi-tags">${allTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`, 'Use tags in a Condition step later.')}`;
      case 'split':
        return `${field(`Path A gets <b id="fi-pa">${d.percent_a}%</b>, path B gets <b id="fi-pb">${100 - d.percent_a}%</b>`, `<input type="range" min="1" max="99" data-f="percent_a" data-num value="${d.percent_a}">`)}
          <p class="fi-note">Each person is sent down one path at random. Compare the step counts to see which works better.</p>`;
      case 'handoff':
        return `${field('Pause automation for (hours)', `<input type="number" min="0" max="168" data-f="pause_hours" data-num value="${d.pause_hours}">`, '0 = only end the flow, keep other automations on')}
          <p class="fi-note">Ends the flow and keeps the bot quiet in this chat so you can answer yourself from Instagram or the Inbox.</p>`;
      default: return '';
    }
  }

  function renderInspector() {
    if (!els.insp) return;
    if (simOpen) return;
    const n = sel?.kind === 'node' ? byId(sel.id) : null;
    if (n) {
      const t = T[n.type];
      const hits = F.stats?.hits?.[n.id] || 0;
      const mine = (F.issues || []).filter((i) => i.node === n.id);
      els.insp.innerHTML = `
        <div class="fi-head" style="--c:${t.color}"><span class="fn-ico">${bi(t.icon)}</span><div class="grow"><b>${t.label}</b><span>${t.desc}</span></div>
          ${n.type !== 'trigger' ? `<button class="fb-ibtn" type="button" data-act="dup" title="Duplicate (Ctrl+D)" aria-label="Duplicate">${bi('copy')}</button>` : ''}
          <button class="fb-ibtn danger" type="button" data-act="del" title="Delete (Del)" aria-label="Delete">${ic('trash')}</button>
          <button class="fb-ibtn mob-only" type="button" data-act="close" aria-label="Close">${ic('x')}</button></div>
        ${mine.map((i) => `<div class="fi-issue ${i.level}">${bi('alert')}<span>${esc(i.message)}</span></div>`).join('')}
        <form class="fi-form">${inspectorFor(n)}</form>
        <div class="fi-foot">${hits ? `Ran <b>${D.num(hits)}</b> time${hits === 1 ? '' : 's'}` : 'Has not run yet'}</div>`;
      return;
    }
    if (sel?.kind === 'edge') {
      els.insp.innerHTML = `<div class="fi-head"><div class="grow"><b>Connection</b><span>Links one step's output to the next step</span></div>
        <button class="fb-ibtn danger" type="button" data-act="del" aria-label="Delete">${ic('trash')}</button><button class="fb-ibtn mob-only" type="button" data-act="close" aria-label="Close">${ic('x')}</button></div>
        <p class="fi-note">Press Delete, or drag a new wire from the same output to replace it.</p>`;
      return;
    }
    const runs = F.stats?.runs || {};
    const issues = F.issues || [];
    els.insp.innerHTML = `
      <div class="fi-head"><span class="fn-ico" style="--c:#8b5cf6">${bi('flow')}</span><div class="grow"><b>Flow overview</b><span>${esc(trigSummary(F.graph.nodes.find((x) => x.type === 'trigger')?.data))}</span></div></div>
      <div class="fi-stats">
        <div><b>${D.num(Object.values(runs).reduce((a, b) => a + b, 0))}</b><span>Started</span></div>
        <div><b>${D.num((runs.running || 0) + (runs.waiting || 0))}</b><span>In progress</span></div>
        <div><b>${D.num(runs.done || 0)}</b><span>Finished</span></div>
      </div>
      <div class="fi-sec"><div class="fi-sec-head"><b>${issues.length ? 'Things to fix' : 'Checks'}</b><span>${issues.length}</span></div>
        ${issues.length ? issues.map((i, k) => `<button type="button" class="fi-issue ${i.level} click" data-issue="${k}">${bi('alert')}<span>${esc(i.message)}</span></button>`).join('')
          : `<div class="fi-ok">${ic('check')} Everything is connected. Turn on <b>Live</b> to start answering people.</div>`}
      </div>
      <div class="fi-sec"><div class="fi-sec-head"><b>How to build</b></div>
        <ul class="fi-help">
          <li>Drag steps from the left onto the canvas.</li>
          <li>Pull a wire from a step's <i class="dot-demo"></i> dot onto another step. Drop it on empty space to create a step there.</li>
          <li>Drag empty space to move around. <kbd>Ctrl</kbd> + scroll or pinch to zoom.</li>
          <li><kbd>Del</kbd> delete · <kbd>Ctrl</kbd><kbd>Z</kbd> undo · <kbd>Ctrl</kbd><kbd>D</kbd> duplicate · <kbd>Ctrl</kbd><kbd>S</kbd> save · <kbd>F</kbd> fit</li>
          <li>Use <b>Test</b> to try the flow in a chat preview. Nothing is sent to Instagram.</li>
        </ul>
      </div>
      ${Object.keys(F.stats?.hits || {}).length ? '<button type="button" class="btn small ghost" data-act="reset">Reset step counts</button>' : ''}`;
  }

  function setPath(obj, path, v) {
    let o = obj;
    for (let i = 0; i < path.length - 1; i++) o = o[/^\d+$/.test(path[i]) ? Number(path[i]) : path[i]];
    o[/^\d+$/.test(path.at(-1)) ? Number(path.at(-1)) : path.at(-1)] = v;
  }

  function bindInspector() {
    const box = els.insp;
    box.addEventListener('submit', (e) => e.preventDefault()); // inline handlers are blocked by the CSP
    box.addEventListener('focusin', (e) => { if (e.target.matches('[data-f]')) editSnap = snap(); });
    box.addEventListener('focusout', (e) => {
      if (!e.target.matches('[data-f]')) return;
      if (e.target.dataset.var !== undefined) {
        e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '').slice(0, 31);
        update(e.target);
      }
      if (editSnap && editSnap !== snap()) { undoStack.push(editSnap); redoStack = []; paintBar(); }
      editSnap = null;
    });
    const update = (el) => {
      const n = sel?.kind === 'node' && byId(sel.id);
      if (!n) return;
      let v = el.value;
      if (el.dataset.num !== undefined) v = Number(v) || 0;
      if (el.dataset.csv !== undefined) v = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (el.dataset.lines !== undefined) v = v.split('\n').map((s) => s.trim()).filter(Boolean);
      if (el.dataset.null !== undefined && v === '') v = null;
      if (el.dataset.var !== undefined) v = String(v).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '').slice(0, 31);
      const path = el.dataset.f.split('.');
      setPath(n.data, path, v);
      if (n.type === 'message' && path[0] === 'buttons' && path[2] === 'kind') {
        if (v === 'flow') n.data.buttons[Number(path[1])].url = '';
        n.data.quick = n.data.buttons.length ? [] : n.data.quick;
      }
      if (n.type === 'trigger' && (n.data.on === 'welcome' || n.data.on === 'story_mention')) n.data.match_mode = 'any';
      if (n.type === 'trigger' && n.data.on !== 'comment') n.data.media_id = null;
      if (n.type === 'delay') n.data.amount = Math.max(1, Math.min(n.data.unit === 'hours' ? 23 : 1380, n.data.amount));
      if (n.type === 'split') { const a = $('#fi-pa', box); const b = $('#fi-pb', box); if (a) a.textContent = `${n.data.percent_a}%`; if (b) b.textContent = `${100 - n.data.percent_a}%`; }
      if (n.type === 'message') { const c = $('#fi-count', box); if (c) c.textContent = `${[...n.data.text].length}/${n.data.buttons.length ? 640 : 1000}`; }
      fixPorts(n);
      renderNode(n.id);
      changed(el.dataset.re !== undefined);
    };
    box.addEventListener('input', (e) => { if (e.target.matches('[data-f]') && e.target.tagName !== 'SELECT') update(e.target); });
    box.addEventListener('change', (e) => {
      if (e.target.matches('select[data-f]')) {
        const before = editSnap || snap();
        update(e.target);
        if (before !== snap()) { undoStack.push(before); redoStack = []; paintBar(); }
        editSnap = snap();
      }
      if (e.target.id === 'fi-upload') upload(e.target);
    });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const n = sel?.kind === 'node' && byId(sel.id);
      if (b.dataset.act === 'del') removeSel();
      else if (b.dataset.act === 'dup' && n) duplicate(n.id);
      else if (b.dataset.act === 'close') select(null);
      else if (b.dataset.act === 'reset') run(async () => { if (!confirm('Reset the run counts shown on each step?')) return; await api(`/flows/${F.id}/reset-stats`, { method: 'POST' }); F.stats.hits = {}; renderAll(); })();
      else if (b.dataset.issue !== undefined) {
        const i = (F.issues || [])[Number(b.dataset.issue)];
        if (i?.node && byId(i.node)) { select({ kind: 'node', id: i.node }); centerOn(i.node); }
      } else if (b.dataset.push && n) {
        checkpoint();
        if (b.dataset.push === 'buttons') { n.data.buttons.push({ title: '', kind: 'url', url: '' }); n.data.quick = []; } else n.data.quick.push('');
        fixPorts(n);
        renderNode(n.id);
        changed(true);
        const inputs = $$(`[data-f^="${b.dataset.push}."]`, box);
        inputs.filter((x) => x.tagName === 'INPUT')[b.dataset.push === 'buttons' ? inputs.filter((x) => x.tagName === 'INPUT' && x.dataset.f.endsWith('title')).length - 1 : inputs.length - 1]?.focus();
      } else if (b.dataset.del && n) {
        const [list, idx] = b.dataset.del.split('.');
        checkpoint();
        n.data[list].splice(Number(idx), 1);
        fixPorts(n, list === 'buttons' ? 'b' : 'q', Number(idx));
        renderNode(n.id);
        changed(true);
      } else if (b.dataset.insert && n) {
        const ta = $('textarea[data-f="text"]', box);
        if (!ta) return;
        const s = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, s) + b.dataset.insert + ta.value.slice(ta.selectionEnd ?? s);
        ta.focus();
        ta.selectionStart = ta.selectionEnd = s + b.dataset.insert.length;
        editSnap = editSnap || snap();
        update(ta);
      }
    });
  }

  async function upload(input) {
    const n = sel?.kind === 'node' && byId(sel.id);
    if (!n || !input.files.length) return;
    const form = new FormData();
    form.append('files', input.files[0]);
    toast('Uploading…');
    try {
      const [file] = await api('/upload', { method: 'POST', form });
      checkpoint();
      n.data.url = file.url;
      n.data.kind = file.kind;
      renderNode(n.id);
      changed(true);
      toast('Uploaded');
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ------------------------------------------------------------------ test chat (runs in the browser; nothing is sent)

  let S = null;
  function openSim() {
    simOpen = true;
    els.root.classList.add('show-insp', 'simming');
    $('#fb-test').classList.add('on');
    const t = F.graph.nodes.find((n) => n.type === 'trigger');
    S = { waiting: null, vars: {}, tags: [], lastText: '', privateLeft: false, started: false };
    els.insp.innerHTML = `
      <div class="fi-head"><span class="fn-ico" style="--c:#22c55e">${bi('flask')}</span><div class="grow"><b>Test this flow</b><span>A preview only: nothing is sent to Instagram</span></div>
        <button class="fb-ibtn" type="button" id="sim-reset" title="Start over" aria-label="Start over">${ic('refresh')}</button>
        <button class="fb-ibtn" type="button" id="sim-x" aria-label="Close test">${ic('x')}</button></div>
      <div class="sim-chat" id="sim-chat"></div>
      <form class="sim-input" id="sim-form">
        <input id="sim-text" autocomplete="off" placeholder="${t?.data.on === 'comment' ? 'Type a comment, e.g. ' + esc(t.data.keywords[0] || 'link') : 'Type a message, e.g. ' + esc(t?.data.keywords?.[0] || 'hi')}">
        <button class="btn primary small" aria-label="Send">${ic('send')}</button>
      </form>`;
    sys(t ? `Pretend you are a follower. ${t.data.on === 'comment' ? 'Your first message counts as a comment on your post.' : t.data.on === 'story_mention' ? 'Your first message counts as a story mention.' : t.data.on === 'story_reply' ? 'Your first message counts as a reply to your story.' : 'Send a DM to start.'}` : 'Add a trigger first.');
    $('#sim-x').onclick = closeSim;
    $('#sim-reset').onclick = openSim;
    $('#sim-form').onsubmit = (e) => { e.preventDefault(); const v = $('#sim-text').value.trim(); if (!v) return; $('#sim-text').value = ''; simInput(v); };
    $('#sim-chat').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sport]');
      if (b && S.waiting?.id === b.dataset.node) { bubble('user', b.textContent); simResume(b.dataset.sport, b.textContent); }
      const to = e.target.closest('[data-timeout]');
      if (to && S.waiting?.id === to.dataset.timeout) { sys('⏱ No reply came in time'); const id = S.waiting.id; S.waiting = null; simAdvance(id, 'timeout'); }
    });
    setTimeout(() => $('#sim-text')?.focus(), 30);
  }
  function closeSim() {
    simOpen = false;
    S = null;
    els.root.classList.remove('simming');
    $('#fb-test')?.classList.remove('on');
    $$('.fn.sim-on', els.nodes).forEach((x) => x.classList.remove('sim-on'));
    els.root.classList.toggle('show-insp', !!sel);
    renderInspector();
  }
  const chat = () => $('#sim-chat');
  function push(html) { const c = chat(); if (!c) return; c.insertAdjacentHTML('beforeend', html); c.scrollTop = c.scrollHeight; }
  const sys = (t) => push(`<div class="sim-sys">${esc(t)}</div>`);
  const bubble = (who, html, raw = false) => push(`<div class="sim-b ${who}">${raw ? html : esc(html)}</div>`);
  const sample = { username: 'alex.demo', name: 'Alex Kumar' };
  function simRender(text) {
    return text.replace(/\{\{\s*([a-z][a-z0-9_]{0,30})\s*\}\}/gi, (m, k) => {
      const key = k.toLowerCase();
      if (key in S.vars) return S.vars[key];
      if (key === 'first_name') return sample.name.split(' ')[0];
      if (key === 'name') return sample.name;
      if (key === 'username') return sample.username;
      return m;
    });
  }
  function glow(id) {
    $$('.fn.sim-on', els.nodes).forEach((x) => x.classList.remove('sim-on'));
    nodeEl(id)?.classList.add('sim-on');
  }
  function simInput(text) {
    bubble('user', text);
    S.lastText = text;
    if (S.waiting) return simResume(null, text);
    const t = F.graph.nodes.find((n) => n.type === 'trigger');
    if (!t) return sys('This flow has no trigger.');
    const d = t.data;
    const any = d.match_mode === 'any' || d.on === 'welcome' || d.on === 'story_mention';
    const ok = any || (d.match_mode === 'exact' ? d.keywords.some((k) => norm(k) === norm(text)) : d.keywords.some((k) => words(k, text)));
    if (!ok) return sys(`No match: the trigger is waiting for ${d.keywords.map((k) => `“${k}”`).join(', ') || 'a keyword'}. Your simple automations could still answer this.`);
    if (S.started && d.cooldown_minutes) sys(`(In real use, the ${d.cooldown_minutes}-minute cooldown would stop it repeating for the same person.)`);
    S.started = true;
    S.privateLeft = d.on === 'comment';
    sys('▶ Flow started');
    glow(t.id);
    simAdvance(t.id, 'next');
  }
  function simResume(port, text) {
    const n = byId(S.waiting.id);
    const has = (p) => F.graph.edges.some((e) => e.from === n.id && e.port === p);
    S.waiting = null;
    if (n.type === 'message') {
      let p = port;
      if (!p) {
        const bi2 = n.data.buttons.findIndex((b) => b.kind === 'flow' && norm(b.title) === norm(text));
        const qi = n.data.quick.findIndex((q) => norm(q) === norm(text));
        p = bi2 >= 0 ? `b${bi2}` : qi >= 0 ? `q${qi}` : 'other';
      }
      if (p === 'other' && !has('other')) return sys('■ The flow ends here: free text is not connected ("Any other reply"). Your simple automations would get this message.');
      return simAdvance(n.id, p);
    }
    if (n.type === 'wait_reply') {
      const valid = (VALID[n.data.validate] || VALID.any)(text);
      if (valid && n.data.save_as) { S.vars[n.data.save_as] = text.trim(); sys(`Saved {{${n.data.save_as}}} = “${text.trim()}”`); }
      if (!valid) sys(`That is not a valid ${n.data.validate}`);
      if (!valid && !has('invalid')) return sys('■ The flow ends here: "Invalid answer" is not connected.');
      return simAdvance(n.id, valid ? 'reply' : 'invalid');
    }
  }
  function simAdvance(fromId, port) {
    let at = fromId;
    let via = port;
    for (let i = 0; i < 40; i++) {
      const e = F.graph.edges.find((x) => x.from === at && x.port === via);
      const n = e && byId(e.to);
      if (!n) { sys('■ Flow finished'); return; }
      glow(n.id);
      const d = n.data;
      at = n.id;
      via = 'next';
      if (n.type === 'message') {
        const text = simRender(d.text);
        const priv = S.privateLeft;
        S.privateLeft = false;
        if (priv) {
          const links = d.buttons.filter((b) => b.kind === 'url').map((b) => `${b.title}: ${b.url}`);
          const choices = [...d.buttons.filter((b) => b.kind === 'flow').map((b) => b.title), ...d.quick];
          sys('Sent as a private reply to the comment (plain text only)');
          bubble('bot', [text, links.join('\n'), choices.length ? `Reply with: ${choices.join(' · ')}` : ''].filter(Boolean).join('\n\n'));
        } else {
          bubble('bot', `${esc(text)}${d.buttons.length ? `<div class="sim-btns">${d.buttons.map((b, k) => b.kind === 'url'
            ? `<a class="sim-btn" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.title)} ↗</a>`
            : `<button type="button" class="sim-btn" data-node="${esc(n.id)}" data-sport="b${k}">${esc(b.title)}</button>`).join('')}</div>` : ''}`, true);
          if (!d.buttons.length && d.quick.length) push(`<div class="sim-quick">${d.quick.map((q, k) => `<button type="button" data-node="${esc(n.id)}" data-sport="q${k}">${esc(q)}</button>`).join('')}</div>`);
        }
        if (portsOf(n)[0] !== 'next') { S.waiting = n; sys('Waiting for their answer…'); return; }
      } else if (n.type === 'media') {
        if (d.url && d.kind === 'image') bubble('bot', `<img src="${esc(d.url)}" alt="">`, true); else bubble('bot', `[${d.kind}]`);
      } else if (n.type === 'wait_reply') {
        S.waiting = n;
        push(`<div class="sim-sys">Waiting for a reply${d.save_as ? `, saved as {{${esc(d.save_as)}}}` : ''}…${d.timeout_minutes ? ` <button type="button" class="link" data-timeout="${esc(n.id)}">Pretend they did not reply</button>` : ''}</div>`);
        return;
      } else if (n.type === 'condition') {
        const subject = d.check === 'variable' ? S.vars[d.variable] || '' : S.lastText;
        const yes = d.check === 'tag' ? d.values.some((v) => S.tags.some((t) => norm(t) === norm(v)))
          : d.op === 'is_set' ? subject.trim().length > 0
          : d.op === 'exact' ? d.values.some((v) => norm(v) === norm(subject)) : d.values.some((v) => words(v, subject));
        via = yes ? 'yes' : 'no';
        sys(`Condition → ${yes ? 'Yes' : 'No'}`);
      } else if (n.type === 'delay') {
        sys(`⏱ Waits ${d.amount} ${d.unit} (skipped in the test)`);
      } else if (n.type === 'comment_reply') {
        if (d.variants.length) sys(`💬 Public reply under the post: “${simRender(d.variants[Math.floor(Math.random() * d.variants.length)])}”`);
      } else if (n.type === 'tag') {
        if (d.action === 'add') S.tags = [...new Set([...S.tags, d.tag])]; else S.tags = S.tags.filter((t) => norm(t) !== norm(d.tag));
        sys(`🏷 Tag ${d.action === 'add' ? 'added' : 'removed'}: ${d.tag}`);
      } else if (n.type === 'split') {
        via = Math.random() * 100 < d.percent_a ? 'a' : 'b';
        sys(`A/B split → path ${via.toUpperCase()}`);
      } else if (n.type === 'handoff') {
        sys(`👤 Handed over to you${d.pause_hours ? `, automation paused for ${d.pause_hours}h` : ''}`);
        sys('■ Flow finished');
        return;
      }
    }
    sys('■ Stopped: too many steps in a row (is there a loop without a wait?)');
  }
})();
