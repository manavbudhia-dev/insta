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
    linkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4M12 10v7"/>',
    arrow: '<path d="M5 12h14m-7-7 7 7-7 7"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16m0 5v-5h5M3 12a9 9 0 0 1 15.5-6.2L21 8m0-5v5h-5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>', right: '<path d="m9 18 6-6-6-6"/>', plus: '<path d="M5 12h14M12 5v14"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3-3-9 9"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', trash: '<path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  };
  const ic = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
  const LOGO = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M13.5 1.5 4 13.2h6.2L9 22.5l10-12.4h-6.3z" fill="url(#g-bolt)" stroke="url(#g-bolt)" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  document.querySelectorAll('[data-logo]').forEach((el) => (el.innerHTML = LOGO));

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
    },
  };
  async function loadCalendar() {
    if (!calViews.posts) return;
    try { await calViews.posts(); } catch (e) { $('#calendar').innerHTML = `<div class="panel empty">${esc(e.message)}</div>`; }
    if (location.hash.startsWith('#calendar')) $('#cal-home').scrollIntoView({ block: 'start' });
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
    const [shell, ov, igPosts, liPosts, liAcc, liStatus] = await Promise.all([
      safe(get('/api/shell')), safe(get(`/api/overview?days=7&tz=${tz}`)), safe(get('/api/posts')),
      safe(get('/linkedin/api/posts')), safe(get('/linkedin/api/accounts')), safe(get('/linkedin/api/status')),
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
    if (next && /^\/(dm|scheduler|linkedin)\/[\w./?=&#-]*$/.test(next)) return location.replace(next);
    $('#login').hidden = true;
    $('#hub').hidden = false;
    await Promise.all([render(), loadCalendar()]);
  }
  setInterval(() => { if (!$('#hub').hidden && document.visibilityState === 'visible') render(); }, 60000);
  start();
})();
