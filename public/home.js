/* Autopilot launcher: login, then one card per mini app with live numbers, plus what needs attention and what is coming up. */
(() => {
  // Old bookmarks like "/#inbox" or "/#posts" pointed at the single Instagram dashboard: send them to the right mini app.
  const h = location.hash.slice(1).split('/')[0];
  if (h === 'posts') return location.replace('/scheduler/' + location.hash);
  if (['overview', 'rules', 'flows', 'flow', 'inbox', 'insights', 'activity', 'settings'].includes(h)) return location.replace('/dm/' + location.hash);

  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString();
  const P = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    whatsapp: '<path d="M3 21l1.7-4.6A8.5 8.5 0 1 1 8 19.6z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-2-1-1 .8a4 4 0 0 1-2.1-2.1l.8-1-1-2z"/>',
    linkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4M12 10v7"/>',
    arrow: '<path d="M5 12h14m-7-7 7 7-7 7"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16m0 5v-5h5M3 12a9 9 0 0 1 15.5-6.2L21 8m0-5v5h-5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>', right: '<path d="m9 18 6-6-6-6"/>', plus: '<path d="M5 12h14M12 5v14"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3-3-9 9"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', trash: '<path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.6 7.6"/><circle cx="11" cy="11" r="2"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  };
  const ic = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
  const LOGO = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M13.5 1.5 4 13.2h6.2L9 22.5l10-12.4h-6.3z" fill="url(#g-bolt)" stroke="url(#g-bolt)" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  document.querySelectorAll('[data-logo]').forEach((el) => (el.innerHTML = LOGO));
  document.querySelectorAll('[data-ic]').forEach((el) => (el.innerHTML = ic(el.dataset.ic)));

  async function get(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }
  const safe = (p) => p.catch(() => null); // one app being down must not blank the whole home page

  const relDay = (ms) => {
    const d = new Date(ms), now = new Date();
    const day = (x) => Math.floor((x - x.getTimezoneOffset() * 60000) / 864e5);
    const diff = day(d) - day(now);
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return diff === 0 ? `Today, ${t}` : diff === 1 ? `Tomorrow, ${t}` : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${t}`;
  };
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  // ---------- calendar host ----------
  // calendar.js runs on the Instagram dashboard's helpers; these are the few it needs, for the home page.
  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }
  let pop = null;
  const closePop = () => { pop?.remove(); pop = null; };
  function popover(anchor, items) {
    closePop();
    pop = document.createElement('div');
    pop.className = 'pop';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = items.map((it, i) => (it.cap ? `<div class="cap">${esc(it.cap)}</div>` : `<button role="menuitem" type="button" data-i="${i}">${it.icon ? ic(it.icon) : ''}${esc(it.label)}</button>`)).join('');
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)) + 'px';
    pop.style.top = Math.min(r.bottom + 8, innerHeight - pop.offsetHeight - 8) + 'px';
    pop.querySelectorAll('button[data-i]').forEach((b) => (b.onclick = () => { const it = items[Number(b.dataset.i)]; closePop(); it.onClick(); }));
    pop.querySelector('button')?.focus();
  }
  document.addEventListener('mousedown', (e) => { if (pop && !pop.contains(e.target)) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  addEventListener('resize', closePop);
  async function api(path, opts = {}) {
    const r = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) showLogin();
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    return j;
  }
  let calTimer;
  const calViews = {};
  window.CALHOST = {
    $, $$: (sel, root = document) => [...root.querySelectorAll(sel)], esc, ic, api, toast, popover, views: calViews,
    run: (fn) => (...a) => Promise.resolve().then(() => fn(...a)).catch((e) => toast(e.message, true)),
    main: document.getElementById('calendar'),
    POST_TYPES: { IMAGE: 'Photo', CAROUSEL: 'Carousel', REELS: 'Reel', STORIES: 'Story' },
    gen: () => 0, setRefresh: (t) => { clearInterval(calTimer); calTimer = t; }, visible: () => document.visibilityState === 'visible',
    num, when: (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'),
    calendar: {
      platforms: ['instagram', 'linkedin'],
      hashBase: 'calendar',
      // Instagram posts are created and edited in the Instagram Scheduler, which opens its form from these links.
      igNew: (day) => location.assign(`/scheduler/#posts/new/${day}`),
      igEdit: (post) => location.assign(`/scheduler/#posts/edit/${post.id}`),
      onChange: () => { render(); renderStudio(); },
    },
  };
  async function loadCalendar() {
    if (!calViews.posts) return;
    try { await calViews.posts(); } catch (e) { $('#calendar').innerHTML = `<div class="panel empty">${esc(e.message)}</div>`; }
    if (location.hash.startsWith('#calendar')) $('#cal-home').scrollIntoView({ block: 'start' });
  }


  // ---------- AI content studio (LinkedIn) ----------
  async function li(path, opts = {}) {
    const r = await fetch('/linkedin/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Something went wrong (${r.status})`);
    return j;
  }
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const slotLabel = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const localInput = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
  let studio = null;       // GET /linkedin/api/auto
  let written = [];        // posts written from an idea, not saved yet: [{ text }]
  let nextSlot = null;
  let busy = '';           // 'write' | 'plan' | ''
  let planNote = null;     // [cls, text]

  async function refreshAfterChange() {
    await Promise.all([renderStudio(), calViews.posts?.().catch(() => {}), render()]);
  }

  async function renderStudio() {
    const body = $('#studio-body');
    let accounts;
    try {
      [studio, accounts] = await Promise.all([li('/auto'), li('/accounts')]);
    } catch (e) {
      $('#studio-tools').innerHTML = '';
      body.innerHTML = `<div class="empty">The AI studio could not load: ${esc(e.message)}</div>`;
      return;
    }
    const cfg = studio.config;
    const account = accounts.find((a) => a.id === cfg.accountId);
    const live = accounts.filter((a) => !a.expired);
    const writeReady = studio.keySet && !!account;
    const planReady = writeReady && cfg.days.length && cfg.times.length;
    const autoReady = planReady && !!cfg.topics;

    $('#studio-tools').innerHTML = `
      <label class="switch" title="${autoReady ? '' : 'Finish the setup to turn on Autopilot'}"><input type="checkbox" id="ap-on" ${cfg.enabled ? 'checked' : ''} ${autoReady ? '' : 'disabled'}><span class="track"></span>Autopilot</label>
      <select id="ap-mode" aria-label="Before posting" style="width:auto" ${planReady ? '' : 'disabled'}>
        <option value="approve" ${cfg.mode !== 'auto' ? 'selected' : ''}>Ask me before posting</option>
        <option value="auto" ${cfg.mode === 'auto' ? 'selected' : ''}>Post automatically</option>
      </select>
      <a class="btn ghost small" href="/linkedin/auto.html#setup">${ic('settings')}Settings</a>`;

    // What is still missing, in order.
    const steps = [
      [live.length > 0, 'Connect a LinkedIn account', '/linkedin/accounts.html'],
      [studio.keySet, 'Add your Anthropic API key', '/linkedin/auto.html#setup'],
      [!!account, 'Choose which account the AI posts as', '/linkedin/auto.html#setup'],
      [!!(cfg.days.length && cfg.times.length), 'Pick your posting days and times', '/linkedin/auto.html#setup'],
      [!!cfg.topics, 'Describe your topics, audience and voice', '/linkedin/auto.html#setup'],
    ];
    const setup = steps.some(([done]) => !done) ? `
      <div class="box">
        <h3>${ic('settings')}Finish setting up (${steps.filter(([d]) => d).length} of ${steps.length} done)</h3>
        <div class="setup">${steps.map(([done, label, href]) => `<a class="row" href="${href}"><span class="dot ${done ? 'done' : 'warn'}">${ic(done ? 'check' : 'alert')}</span><span class="txt"><b>${esc(label)}</b></span>${done ? '' : ic('arrow')}</a>`).join('')}</div>
      </div>` : '';

    const slots = cfg.days.length && cfg.times.length
      ? `${cfg.days.map((d) => DAYS[d]).join(', ')} at ${cfg.times.join(', ')} (${esc(cfg.tz)})` : 'no posting days yet';
    const drafts = studio.drafts || [];

    body.innerHTML = `
      ${setup}
      <div class="studio-grid" ${setup ? 'style="margin-top:16px"' : ''}>
        <div class="box">
          <h3>${ic('pen')}Write a post</h3>
          <label class="field">What do you want to post about?
            <textarea id="idea" placeholder="e.g. 3 lessons from launching my side project in 30 days" ${writeReady ? '' : 'disabled'}></textarea></label>
          <div class="acts">
            <button class="btn ai" type="button" id="write" ${writeReady && !busy ? '' : 'disabled'}>${busy === 'write' ? '<span class="spin"></span>Writing…' : `${ic('spark')}Write with AI`}</button>
            <select id="versions" aria-label="How many versions" style="width:auto" ${writeReady ? '' : 'disabled'}>
              <option value="1">1 version</option><option value="2">2 versions</option><option value="3">3 versions</option>
            </select>
          </div>
          ${busy === 'write' ? '<p class="note">Claude is writing in your voice. This can take up to a minute.</p>' : ''}
          <div id="written">${written.map((w, i) => `
            <div class="draft-card" data-w="${i}">
              <textarea aria-label="Post text ${i + 1}" data-text="${i}">${esc(w.text)}</textarea>
              <div class="draft-meta"><span>${written.length > 1 ? `Version ${i + 1}` : 'Edit anything before saving'}</span><span data-count="${i}">${w.text.length} / 3000</span></div>
              <div class="acts">
                ${nextSlot ? `<button class="btn primary small" type="button" data-next="${i}">${ic('calendar')}Schedule · ${esc(slotLabel(nextSlot))}</button>` : ''}
                <button class="btn small" type="button" data-pickopen="${i}">${ic('calendar')}Pick a time</button>
                <button class="btn small" type="button" data-draft="${i}">Save as draft</button>
                <button class="btn small ghost" type="button" data-drop="${i}">Discard</button>
              </div>
              <div class="pick" data-pick="${i}" hidden>
                <input type="datetime-local" data-when="${i}" value="${localInput(Date.now() + 2 * 3600e3)}" min="${localInput(Date.now() + 5 * 60e3)}">
                <button class="btn primary small" type="button" data-at="${i}">Schedule</button>
              </div>
            </div>`).join('')}</div>
        </div>

        <div class="box">
          <h3>${ic('calendar')}Plan ahead</h3>
          <p class="note">Fills your empty slots (${slots}) with posts and adds them to the calendar. ${cfg.mode === 'auto' ? '<b>They will publish by themselves.</b>' : '<b>You approve each one before it posts.</b>'}</p>
          <label class="field">Theme for this period <span class="muted small" style="font-weight:400">(optional)</span>
            <input id="brief" placeholder="e.g. Hiring for our new team, product launch on the 25th" ${planReady ? '' : 'disabled'}></label>
          <div class="acts">
            <select id="horizon" aria-label="How far ahead" style="width:auto" ${planReady ? '' : 'disabled'}>
              <option value="7">Next 7 days</option><option value="14">Next 14 days</option><option value="30">Next 30 days</option>
            </select>
            <button class="btn ai" type="button" id="plan" ${planReady && !busy ? '' : 'disabled'}>${busy === 'plan' ? '<span class="spin"></span>Planning…' : `${ic('spark')}Plan &amp; add to calendar`}</button>
          </div>
          ${busy === 'plan' ? '<p class="note">Writing a post for every empty slot. This can take a minute or two.</p>' : ''}
          ${planNote ? `<p class="note ${planNote[0]}">${esc(planNote[1])}</p>` : ''}
          <p class="note">${cfg.enabled ? `Autopilot is <b>on</b>: every 30 minutes it fills empty slots in the next ${cfg.horizonDays} days.` : 'Autopilot is off: posts are only written when you ask.'}
            ${studio.last ? ` Last run ${esc(new Date(studio.last.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}: ${studio.last.ok ? `${studio.last.created || 0} added${studio.last.note ? ` (${esc(studio.last.note)})` : ''}` : `<span style="color:var(--bad)">${esc(studio.last.error)}</span>`}.` : ''}</p>
        </div>
      </div>

      ${drafts.length ? `
      <div class="box" style="margin-top:16px">
        <div class="acts" style="justify-content:space-between"><h3>${ic('edit')}Waiting for your approval (${drafts.length})</h3>
          <button class="btn primary small" type="button" id="approve-all">${ic('check')}Approve all</button></div>
        <div class="queue">${drafts.slice(0, 6).map((d) => `
          <div class="qrow"><span class="when">${esc(slotLabel(d.when_at))}</span><span class="txt">${esc(clip(d.text, 160))}</span>
            <span class="acts"><button class="btn small primary" type="button" data-approve="${Number(d.id)}">Approve</button><a class="btn small" href="/linkedin/?edit=${Number(d.id)}">Edit</a></span></div>`).join('')}
          ${drafts.length > 6 ? `<a class="note" href="/linkedin/auto.html">+${drafts.length - 6} more in Auto content</a>` : ''}
        </div>
      </div>` : ''}`;
    bindStudio(cfg);
  }

  function bindStudio(cfg) {
    const act = (fn) => async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try { await fn(b); } catch (err) { toast(err.message, true); } finally { b.disabled = false; }
    };
    const saveCfg = async (patch) => {
      await li('/auto', { method: 'PUT', body: { config: { ...cfg, ...patch } } });
      await renderStudio();
    };
    $('#ap-on')?.addEventListener('change', async (e) => {
      try { await saveCfg({ enabled: e.target.checked }); toast(e.target.checked ? 'Autopilot is on' : 'Autopilot is off'); }
      catch (err) { e.target.checked = !e.target.checked; toast(err.message, true); }
    });
    $('#ap-mode')?.addEventListener('change', async (e) => {
      try { await saveCfg({ mode: e.target.value }); toast(e.target.value === 'auto' ? 'AI posts will publish by themselves' : 'AI posts will wait for your approval'); }
      catch (err) { toast(err.message, true); renderStudio(); }
    });

    const write = $('#write');
    if (write) write.onclick = async () => {
      const idea = $('#idea').value.trim();
      if (!idea) { $('#idea').focus(); return toast('Say what the post should be about', true); }
      busy = 'write';
      const count = $('#versions').value;
      await renderStudio();
      $('#idea').value = idea;
      try {
        const r = await li('/auto/compose', { method: 'POST', body: { idea, count } });
        written = r.posts.map((text) => ({ text }));
        nextSlot = r.nextSlot;
      } catch (err) { toast(err.message, true); }
      busy = '';
      await renderStudio();
      $('#idea').value = idea;
    };
    document.querySelectorAll('[data-text]').forEach((t) => t.addEventListener('input', () => {
      written[+t.dataset.text].text = t.value;
      document.querySelector(`[data-count="${t.dataset.text}"]`).textContent = `${t.value.length} / 3000`;
    }));
    const save = async (i, body, msg) => {
      const text = written[i].text.trim();
      const r = await li('/auto/add', { method: 'POST', body: { text, ...body } });
      written.splice(i, 1);
      toast(msg(r.posts[0]));
      await refreshAfterChange();
    };
    document.querySelectorAll('[data-next]').forEach((b) => (b.onclick = act(() => save(+b.dataset.next, { status: 'scheduled' }, (p) => `Scheduled for ${slotLabel(p.when_at)}. It will post by itself.`))));
    document.querySelectorAll('[data-draft]').forEach((b) => (b.onclick = act(() => save(+b.dataset.draft, { status: 'draft' }, (p) => `Saved as a draft for ${slotLabel(p.when_at)}. Approve it to post.`))));
    document.querySelectorAll('[data-pickopen]').forEach((b) => (b.onclick = () => { const p = document.querySelector(`[data-pick="${b.dataset.pickopen}"]`); p.hidden = !p.hidden; }));
    document.querySelectorAll('[data-at]').forEach((b) => (b.onclick = act(async () => {
      const i = +b.dataset.at, v = document.querySelector(`[data-when="${i}"]`).value;
      const at = v ? new Date(v).getTime() : NaN;
      if (!Number.isFinite(at) || at < Date.now() + 2 * 60e3) throw new Error('Pick a time in the future');
      await save(i, { status: 'scheduled', whenAt: at }, (p) => `Scheduled for ${slotLabel(p.when_at)}. It will post by itself.`);
    })));
    document.querySelectorAll('[data-drop]').forEach((b) => (b.onclick = () => { written.splice(+b.dataset.drop, 1); renderStudio(); }));

    const plan = $('#plan');
    if (plan) plan.onclick = async () => {
      const brief = $('#brief').value.trim(), days = $('#horizon').value;
      busy = 'plan'; planNote = null;
      await renderStudio();
      $('#brief').value = brief; $('#horizon').value = days;
      try {
        const r = await li('/auto/plan', { method: 'POST', body: { brief, days } });
        if (r.busy) planNote = ['', 'Autopilot is writing right now. Try again in a minute.'];
        else if (!r.created) planNote = ['', 'Every slot in that period already has a post. Pick a longer period or add posting times in settings.'];
        else planNote = ['ok', `Added ${r.created} post${r.created === 1 ? '' : 's'} to the calendar${r.posts?.[0]?.status === 'draft' ? '. Approve them below so they can post.' : '. They will publish by themselves.'}`];
      } catch (err) { planNote = ['bad', err.message]; }
      busy = '';
      await refreshAfterChange();
    };
    document.querySelectorAll('#studio [data-approve]').forEach((b) => (b.onclick = act(async () => {
      const r = await li(`/auto/drafts/${b.dataset.approve}/approve`, { method: 'POST' });
      toast(`Approved. It will post ${slotLabel(r.when_at)}.`);
      await refreshAfterChange();
    })));
    const all = $('#approve-all');
    if (all) all.onclick = act(async () => {
      const r = await li('/auto/approve-all', { method: 'POST' });
      toast(`Approved ${r.approved} post${r.approved === 1 ? '' : 's'}. They will post on schedule.`);
      await refreshAfterChange();
    });
  }

  // ---------- login ----------
  function showLogin() { $('#hub').hidden = true; $('#login').hidden = false; }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: e.target.password.value }) });
    if (!r.ok) {
      err.textContent = (await r.json().catch(() => ({}))).error || 'Could not sign in';
      err.hidden = false;
      return;
    }
    e.target.reset();
    start();
  });
  $('#signout').onclick = async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  };

  // ---------- hub ----------
  const card = (a) => `
    <a class="app" href="${a.href}">
      <div class="app-top">
        <div class="app-ico ${a.cls}">${ic(a.icon)}</div>
        <span class="pill ${a.state[0]}">${esc(a.state[1])}</span>
      </div>
      <div><h3>${esc(a.name)}</h3><p>${esc(a.desc)}</p></div>
      <div class="stats">${a.stats.map(([v, l]) => `<div class="stat"><b>${v == null ? '–' : num(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
      <div class="app-foot"><span class="note">${esc(a.note || '')}</span><span class="open">Open ${ic('arrow')}</span></div>
    </a>`;

  async function render() {
    const hr = new Date().getHours();
    $('#hello').textContent = `${hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'} 👋`;
    const tz = -new Date().getTimezoneOffset();
    const [shell, ov, igPosts, liPosts, liAcc, liStatus, wa] = await Promise.all([
      safe(get('/api/shell')), safe(get(`/api/overview?days=7&tz=${tz}`)), safe(get('/api/posts')),
      safe(get('/linkedin/api/posts')), safe(get('/linkedin/api/accounts')), safe(get('/linkedin/api/status')),
      safe(get('/whatsapp/api/status')),
    ]);
    if (shell === null && ov === null && igPosts === null) {
      // The session ended (or the server is down): check before showing an empty page.
      const s = await safe(get('/api/session'));
      if (!s?.loggedIn) return showLogin();
    }

    const now = Date.now();
    const igConnected = !!shell?.account;
    const igSched = (igPosts || []).filter((p) => p.status === 'scheduled' || p.status === 'publishing');
    const igFailed = (igPosts || []).filter((p) => p.status === 'failed');
    const igPublished = (igPosts || []).filter((p) => p.status === 'published' && p.published_at > now - 30 * 864e5);
    const liSched = (liPosts || []).filter((p) => p.status === 'scheduled' || p.status === 'publishing');
    const liDrafts = (liPosts || []).filter((p) => p.status === 'draft');
    const liFailed = (liPosts || []).filter((p) => p.status === 'failed');
    const liLive = (liAcc || []).filter((a) => !a.expired);
    const rulesOn = (ov?.rules || []).filter((r) => r.enabled).length;
    const nextIg = [...igSched].sort((a, b) => a.scheduled_at - b.scheduled_at)[0];
    const nextLi = [...liSched].sort((a, b) => a.when_at - b.when_at)[0];
    const acct = igConnected ? `@${shell.account.username}` : '';

    const apps = [
      {
        name: 'Instagram DM Automation', cls: 'dm', icon: 'chat', href: '/dm/',
        desc: 'Auto-replies, comment-to-DM, flows and your inbox.',
        state: !igConnected ? ['warn', 'Not connected'] : shell.automationEnabled ? ['ok', 'Active'] : ['warn', 'Paused'],
        stats: [[ov?.received?.value, 'DMs (7 days)'], [shell?.badge, 'Awaiting reply'], [ov ? rulesOn : null, 'Rules on']],
        note: acct || 'Connect your Instagram account to start',
      },
      {
        name: 'Instagram Scheduler', cls: 'sched', icon: 'calendar', href: '/scheduler/',
        desc: 'Plan photos, carousels, reels and stories on a calendar.',
        state: !igConnected ? ['warn', 'Not connected'] : igFailed.length ? ['bad', `${igFailed.length} failed`] : ['ok', 'Ready'],
        stats: [[igPosts ? igSched.length : null, 'Scheduled'], [igPosts ? igPublished.length : null, 'Published'], [igPosts ? igFailed.length : null, 'Failed']],
        note: nextIg ? `Next: ${relDay(nextIg.scheduled_at)}` : 'Nothing scheduled yet',
      },
      {
        name: 'LinkedIn Scheduler', cls: 'li', icon: 'linkedin', href: '/linkedin/',
        desc: 'Text, image, video and poll posts for profiles and pages.',
        state: liStatus && !liStatus.linkedinReady ? ['warn', 'Needs setup'] : liAcc && !liLive.length ? ['warn', 'No account'] : liFailed.length ? ['bad', `${liFailed.length} failed`] : liPosts ? ['ok', 'Ready'] : ['', 'Unavailable'],
        stats: [[liPosts ? liSched.length : null, 'Scheduled'], [liPosts ? liDrafts.length : null, 'Drafts'], [liAcc ? liLive.length : null, 'Accounts']],
        note: nextLi ? `Next: ${relDay(nextLi.when_at)}` : 'Nothing scheduled yet',
      },
      {
        name: 'WhatsApp Automation', cls: 'wa', icon: 'whatsapp', href: '/whatsapp/',
        desc: 'Auto-replies, template broadcasts, inbox and n8n.',
        state: !wa ? ['', 'Unavailable'] : !wa.configured ? ['warn', 'Not connected'] : wa.failed24h ? ['bad', `${wa.failed24h} failed`] : wa.automation ? ['ok', 'Active'] : ['warn', 'Paused'],
        stats: [[wa?.received7d, 'Messages (7 days)'], [wa?.awaiting, 'Awaiting reply'], [wa?.rulesOn, 'Rules on']],
        note: wa?.display?.phone || (wa?.nextBroadcast ? `Broadcast: ${relDay(wa.nextBroadcast.scheduled_at)}` : 'Connect your WhatsApp number to start'),
      },
    ];
    $('#apps').innerHTML = apps.map(card).join('');

    // Needs attention: the same things each app warns about, gathered in one place.
    const att = [];
    if (shell && !igConnected) att.push(['warn', 'Instagram account not connected', 'DM automation and the Instagram scheduler need it.', '/dm/#overview']);
    if (igConnected && !shell.automationEnabled) att.push(['warn', 'Instagram automations are paused', 'Nobody gets automatic replies until you resume.', '/dm/#settings']);
    if (shell?.alerts) att.push(['bad', `${shell.alerts} Instagram problem${shell.alerts === 1 ? '' : 's'} in the last 24 hours`, 'Failed replies or comment checks.', '/dm/#activity']);
    if (igFailed.length) att.push(['bad', `${igFailed.length} Instagram post${igFailed.length === 1 ? '' : 's'} failed to publish`, clip(igFailed[0].error, 80), '/scheduler/#posts']);
    if (liStatus && !liStatus.linkedinReady) att.push(['warn', 'LinkedIn app not set up', 'Add your Client ID and Secret in LinkedIn settings.', '/linkedin/settings.html']);
    else if (liAcc && !liAcc.length) att.push(['warn', 'No LinkedIn account connected', 'Connect a profile to start publishing.', '/linkedin/accounts.html']);
    for (const t of liStatus?.tokens || []) att.push([t.expired ? 'bad' : 'warn', t.expired ? `LinkedIn connection for ${t.name} expired` : `LinkedIn connection for ${t.name} expires in ${t.days_left} day${t.days_left === 1 ? '' : 's'}`, 'Reconnect it so scheduled posts keep publishing.', '/linkedin/accounts.html']);
    if (liFailed.length) att.push(['bad', `${liFailed.length} LinkedIn post${liFailed.length === 1 ? '' : 's'} failed`, clip(liFailed[0].error, 80), '/linkedin/queue.html']);
    if (wa && !wa.configured) att.push(['warn', 'WhatsApp not connected', 'Add your Cloud API number and token in WhatsApp settings.', '/whatsapp/#settings']);
    if (wa?.failed24h) att.push(['bad', `${wa.failed24h} WhatsApp message${wa.failed24h === 1 ? '' : 's'} failed in the last 24 hours`, 'See what went wrong in Activity.', '/whatsapp/#activity']);
    if (wa?.awaiting) att.push(['warn', `${wa.awaiting} WhatsApp chat${wa.awaiting === 1 ? '' : 's'} awaiting a reply`, 'Reply within 24 hours, after that only templates are allowed.', '/whatsapp/#inbox']);
    if (liDrafts.some((p) => p.ai)) att.push(['warn', 'AI drafts are waiting for your approval', 'Review them in Auto content.', '/linkedin/auto.html']);
    $('#attention').innerHTML = att.length
      ? att.map(([lvl, t, d, href]) => `<a class="row" href="${href}"><span class="dot ${lvl}">${ic('alert')}</span><span class="txt"><b>${esc(t)}</b><span>${esc(d || '')}</span></span>${ic('arrow')}</a>`).join('')
      : '<div class="empty ok">All good. Nothing needs your attention.</div>';

    // Coming up: the next posts from both schedulers on one timeline.
    const up = [
      ...igSched.map((p) => ({ at: p.scheduled_at, cls: 'sched', icon: 'calendar', title: clip(p.caption, 70) || 'No caption', sub: `Instagram · ${String(p.type || '').toLowerCase()}`, href: '/scheduler/#posts' })),
      ...liSched.map((p) => ({ at: p.when_at, cls: 'li', icon: 'linkedin', title: clip(p.text, 70), sub: `LinkedIn · ${p.account_name || 'account'}`, href: '/linkedin/queue.html' })),
    ].sort((a, b) => a.at - b.at).slice(0, 6);
    $('#upcoming').innerHTML = up.length
      ? up.map((u) => `<a class="row" href="${u.href}"><span class="dot ${u.cls}">${ic(u.icon)}</span><span class="txt"><b>${esc(u.title)}</b><span>${esc(u.sub)}</span></span><span class="when">${esc(relDay(u.at))}</span></a>`).join('')
      : '<div class="empty">Nothing scheduled. Open a scheduler to plan your next post.</div>';
  }

  async function start() {
    const s = await safe(get('/api/session'));
    if (!s?.loggedIn) return showLogin();
    // Sent here to sign in from another page (e.g. the LinkedIn login): go back once signed in. Same-site paths only.
    const next = new URLSearchParams(location.search).get('next');
    if (next && /^\/(dm|scheduler|linkedin|whatsapp)\/[\w./?=&#-]*$/.test(next)) return location.replace(next);
    $('#login').hidden = true;
    $('#hub').hidden = false;
    await Promise.all([render(), loadCalendar(), renderStudio()]);
  }
  setInterval(() => { if (!$('#hub').hidden && document.visibilityState === 'visible') render(); }, 60000);
  start();
})();
