/* DM Autopilot dashboard — dependency-free single-page app. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const main = $('#main');

  // One page, two mini apps: /dm/ (DM automation) and /scheduler/ (Instagram scheduler). Each shows only its own
  // pages; a link to a page of the other app (e.g. "Schedule post" on the DM overview) opens that app instead.
  const APPS = {
    dm: { name: 'DM Automation', path: '/dm/', home: 'overview', views: ['overview', 'rules', 'flows', 'flow', 'inbox', 'insights', 'activity', 'settings'] },
    scheduler: { name: 'Instagram Scheduler', path: '/scheduler/', home: 'posts', views: ['posts', 'insights'] },
  };
  const MODE = location.pathname.startsWith('/scheduler') ? 'scheduler' : 'dm';
  const APP = APPS[MODE];
  const OTHER = APPS[MODE === 'dm' ? 'scheduler' : 'dm'];
  document.title = `${APP.name} · Autopilot`;
  $('#brand-name').textContent = APP.name;
  $('#brand').href = `#${APP.home}`;
  for (const a of $$('#nav a[data-view]')) if (!APP.views.includes(a.dataset.view)) a.parentNode.removeChild(a);

  // Everything shown from Instagram (usernames, comments, messages) is untrusted: always escape.
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const ago = (ms) => {
    if (!ms) return 'never';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };
  const short = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  const lines = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  const num = (n) => Number(n || 0).toLocaleString();

  // ---------- icons (24px grid, stroke) ----------
  const P = {
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    flow: '<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="12" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M8.4 7.2c3.8.6 5 2.2 7.2 3.6M8.4 16.8c3.8-.6 5-2.2 7.2-3.6"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    calendarCheck: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18m-12 6 2 2 4-4"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    reply: '<path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
    star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21.1 7 14.2 2 9.3l6.9-1z"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
    down: '<path d="m6 9 6 6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>', plus: '<path d="M5 12h14M12 5v14"/>', check: '<path d="M20 6 9 17l-5-5"/>',
    arrow: '<path d="M5 12h14m-7-7 7 7-7 7"/>', up: '<path d="M12 19V5m-7 7 7-7 7 7"/>', dn: '<path d="M12 5v14m7-7-7 7-7-7"/>',
    more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
    play: '<path d="M7 4v16l13-8z" fill="currentColor"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16m0 5v-5h5M3 12a9 9 0 0 1 15.5-6.2L21 8m0-5v5h-5"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15v2M11 10v7M15 12v5M19 6v11"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3-3-9 9"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    linkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4M12 10v7"/>',
  };
  const ic = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
  const IG = (cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6.5" fill="url(#g-ig)"/><rect x="5.3" y="5.3" width="13.4" height="13.4" rx="4" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="12" cy="12" r="3.1" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="16.3" cy="7.7" r="1" fill="#fff"/></svg>`;
  const LOGO = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M13.5 1.5 4 13.2h6.2L9 22.5l10-12.4h-6.3z" fill="url(#g-bolt)" stroke="url(#g-bolt)" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const mount = () => {
    $$('[data-ic]').forEach((el) => el.replaceWith(Object.assign(document.createElement('span'), { innerHTML: ic(el.dataset.ic), style: 'display:contents' })));
    $$('[data-logo]').forEach((el) => (el.innerHTML = LOGO));
  };

  // ---------- plumbing ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function request(path, opts, retries) {
    const init = { method: opts.method ?? 'GET', headers: {} };
    if (opts.form) init.body = opts.form;
    else if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      init.signal = AbortSignal.timeout(opts.form ? 300000 : 20000);
      res = await fetch('/api' + path, init);
    } catch {
      if (retries > 0) {
        await sleep(700);
        return request(path, opts, retries - 1);
      }
      const err = new Error('Cannot reach the server right now. Retrying in the background.');
      err.network = true;
      throw err;
    }
    if (res.status === 401 && path !== '/login') {
      showLogin();
      throw new Error('Please sign in again');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  // Identical GETs that are already in flight share one request; GETs retry once on a dropped connection.
  const inflight = new Map();
  function api(path, opts = {}) {
    if ((opts.method ?? 'GET') !== 'GET') return request(path, opts, 0);
    if (inflight.has(path)) return inflight.get(path);
    const p = request(path, opts, 1).finally(() => inflight.delete(path));
    inflight.set(path, p);
    return p;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 3000);
  }
  /** Run an async action, surfacing failures as a toast. */
  let lastNet = 0;
  const run = (fn, okMsg) => async (...args) => {
    try {
      await fn(...args);
      if (okMsg) toast(okMsg);
    } catch (e) {
      if (e.network) {
        if (Date.now() - lastNet > 10000) { lastNet = Date.now(); toast(e.message, true); }
      } else toast(e.message, true);
    }
  };
  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const visible = () => !document.hidden;

  const modalHead = (title) => `<div class="modal-head"><h2>${title}</h2><button type="button" class="x" id="m-close" aria-label="Close">${ic('x')}</button></div>`;
  function openModal(html) {
    closePop();
    const box = $('#modal-box');
    box.innerHTML = html;
    $('#modal').hidden = false;
    const x = $('#m-close', box);
    if (x) x.onclick = closeModal;
    return box;
  }
  function closeModal() {
    $('#modal').hidden = true;
    $('#modal-box').innerHTML = '';
  }
  $('#modal').addEventListener('mousedown', (e) => e.target.id === 'modal' && closeModal());

  // Small floating menu anchored under a button.
  let pop = null;
  function closePop() {
    pop?.remove();
    pop = null;
  }
  function popover(anchor, items, { align = 'right' } = {}) {
    closePop();
    pop = document.createElement('div');
    pop.className = 'pop';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : it.cap ? `<div class="cap">${esc(it.cap)}</div>`
      : it.href ? `<a role="menuitem" href="${esc(it.href)}">${it.icon ? ic(it.icon) : ''}${esc(it.label)}</a>`
      : `<button role="menuitem" type="button" data-i="${i}" class="${it.danger ? 'danger' : ''} ${it.on ? 'on' : ''}">${it.icon ? ic(it.icon) : ''}${esc(it.label)}</button>`).join('');
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = align === 'right' ? Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) : Math.max(8, Math.min(innerWidth - w - 8, r.left));
    pop.style.left = left + 'px';
    pop.style.top = Math.min(r.bottom + 8, innerHeight - pop.offsetHeight - 8) + 'px';
    $$('button[data-i]', pop).forEach((b) => (b.onclick = () => {
      const it = items[Number(b.dataset.i)];
      closePop();
      run(it.onClick)();
    }));
  }
  document.addEventListener('mousedown', (e) => { if (pop && !pop.contains(e.target) && !e.target.closest('[data-pop]')) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePop(); if (!$('#modal').hidden) closeModal(); } });
  window.addEventListener('resize', closePop);

  // ---------- session ----------

  // Signing in happens on the launcher ("/"), which sends you back here afterwards.
  function showLogin() {
    $('#app').hidden = true;
    location.replace('/?next=' + encodeURIComponent(location.pathname + location.hash));
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    try {
      await api('/login', { method: 'POST', body: { password: e.target.password.value } });
      e.target.reset();
      start();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  const signOut = async () => {
    await api('/logout', { method: 'POST' });
    location.href = '/';
  };

  // ---------- chrome: sidebar meter, account pill, bell, avatar, banner ----------

  let chrome = null;
  const PAGES = {
    overview: { icon: 'sun', title: () => `${greeting()}, ${firstName()} 👋`, sub: 'Run your Instagram DM automation, schedule content, and grow conversations.' },
    rules: { icon: 'zap', title: () => 'Automations', sub: 'Each rule watches for a trigger and sends a reply. The first matching rule wins.' },
    flows: { icon: 'flow', title: () => 'Flows', sub: 'Multi-step conversations built visually: buttons, questions, conditions, delays and tags.' },
    flow: { icon: 'flow', title: () => 'Flow builder', sub: '' },
    inbox: { icon: 'chat', title: () => 'Inbox', sub: 'Conversations and comments handled by your automations.' },
    posts: { icon: 'calendar', title: () => 'Content calendar', sub: 'Plan photos, carousels, reels and stories by month. Times are in your local timezone.' },
    insights: { icon: 'chart', title: () => 'Insights', sub: 'How your conversations, automations and posts are performing.' },
    activity: { icon: 'activity', title: () => 'Activity', sub: 'Every reply the system queued, and what happened to it.' },
    settings: { icon: 'settings', title: () => 'Settings', sub: 'Safety limits and how comments are collected.' },
  };
  let currentView = 'overview';
  const hour = () => new Date().getHours();
  const greeting = () => (hour() < 12 ? 'Good morning' : hour() < 18 ? 'Good afternoon' : 'Good evening');
  const firstName = () => {
    const a = chrome?.account;
    const n = (a?.name || '').trim().split(/\s+/)[0] || a?.username || '';
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'there';
  };

  function renderTopbar() {
    const pg = PAGES[currentView];
    const a = chrome?.account;
    const h = hour();
    const icon = currentView === 'overview' ? (h >= 6 && h < 18 ? 'sun' : 'moon') : pg.icon;
    const tone = currentView === 'overview' ? (icon === 'sun' ? 'sun' : 'moon') : '';
    const initial = firstName().charAt(0).toUpperCase();
    $('#topbar').innerHTML = `
      <div class="tile-ico ${tone}">${ic(icon)}</div>
      <div class="titles"><h1>${esc(pg.title())}</h1><p>${esc(pg.sub)}</p></div>
      <div class="tools">
        ${a ? `<button class="acct" id="acct" data-pop type="button" aria-haspopup="menu">${IG('ig')}<span class="who"><b>@${esc(a.username)}</b><span>Connected</span></span>${ic('down')}</button>`
          : `<button class="acct" id="acct" data-pop type="button">${IG('ig')}<span class="who"><b>Instagram</b><span class="off">Not connected</span></span>${ic('down')}</button>`}
        <button class="icon-btn" id="bell" type="button" aria-label="Notifications">${ic('bell')}${chrome?.alerts ? '<i class="dot-alert"></i>' : ''}</button>
        <button class="avatar" id="me" data-pop type="button" aria-label="Account menu">${a?.picture ? `<img src="${esc(a.picture)}" alt="">` : esc(initial)}</button>
      </div>`;
    $('#acct').onclick = (e) => accountMenu(e.currentTarget);
    $('#bell').onclick = run(showAlerts);
    $('#me').onclick = (e) => popover(e.currentTarget, [
      { icon: 'settings', label: 'Settings', onClick: () => (location.hash = '#settings') },
      '-',
      { icon: 'logout', label: 'Sign out', onClick: signOut },
    ]);
  }

  function renderLimit() {
    if (MODE !== 'dm') { $('#limit').innerHTML = ''; return; } // the hourly reply limit belongs to DM automation
    const l = chrome?.limit || { used: 0, max: 0 };
    const pct = l.max ? Math.min(100, Math.round((l.used / l.max) * 100)) : 0;
    $('#limit').innerHTML = `
      <div class="limit">
        <div class="limit-title">${ic('zap')}Hourly limit</div>
        <div class="limit-count">${num(l.used)} / ${num(l.max)} replies this hour</div>
        <div class="meter"><div class="bar"><i style="width:${pct}%"></i></div><span>${pct}%</span></div>
        <a class="btn" href="#settings">${ic('settings')}Adjust limit</a>
      </div>`;
  }

  function renderBanner() {
    $('#banner').innerHTML = MODE === 'dm' && chrome && !chrome.automationEnabled
      ? `<div class="banner">${ic('pause')}<span>All automations are paused. Nobody will receive automatic replies until you resume.</span><button class="btn small" id="resume" type="button">Resume</button></div>` : '';
    const b = $('#resume');
    if (b) b.onclick = run(() => setPaused(false));
  }

  let chromeAt = 0;
  async function refreshChrome(force = false) {
    if (!force && Date.now() - chromeAt < 5000) return;
    chromeAt = Date.now();
    try {
      chrome = await api('/shell');
    } catch { chromeAt = 0; return; }
    const badge = $('#badge'); // only the DM app has the Inbox link that carries it
    if (badge) {
      badge.textContent = chrome.badge > 99 ? '99+' : chrome.badge;
      badge.hidden = !chrome.badge;
    }
    renderTopbar();
    renderLimit();
    renderBanner();
  }

  async function setPaused(paused) {
    await api('/settings', { method: 'PUT', body: { automation_enabled: paused ? 0 : 1 } });
    toast(paused ? 'Automations paused' : 'Automations resumed');
    await refreshChrome(true);
    if (currentView === 'overview' || currentView === 'settings') route();
  }

  const reload = () => route();
  const doResub = async () => {
    try {
      await api('/account/subscribe', { method: 'POST' });
      toast('Checked with Meta: webhooks are subscribed');
    } finally {
      reload();
    }
  };
  const doDisconnect = async () => {
    if (!confirm('Disconnect this Instagram account? Automations stop until you reconnect.')) return;
    await api('/account/disconnect', { method: 'POST' });
    closeModal();
    reload();
  };
  const doSelect = async (id) => { await api('/account/select', { method: 'POST', body: { id } }); toast('Switched account'); reload(); };

  function accountMenu(anchor) {
    const a = chrome?.account;
    if (!a) return openConnect();
    const items = [];
    if (a.accounts.length > 1) {
      items.push({ cap: 'Switch account' });
      a.accounts.forEach((x) => items.push({ label: '@' + x.username, on: x.id === a.id, onClick: () => (x.id === a.id ? null : doSelect(x.id)) }));
      items.push('-');
    }
    items.push({ icon: 'pause', label: chrome.automationEnabled ? 'Pause all automations' : 'Resume automations', onClick: () => setPaused(chrome.automationEnabled) });
    items.push({ icon: 'refresh', label: 'Check webhooks now', onClick: doResub });
    items.push({ icon: 'link', label: 'Reconnect account', href: '/auth/instagram' });
    items.push({ icon: 'trash', label: 'Disconnect', danger: true, onClick: doDisconnect });
    popover(anchor, items);
  }

  async function showAlerts() {
    const s = await api('/status');
    const a = s.account;
    const rows = [];
    if (s.stats.failed24h) rows.push(['bad', 'activity', `${s.stats.failed24h} repl${s.stats.failed24h === 1 ? 'y' : 'ies'} failed to send in the last 24 hours`, 'Open Activity to see the error for each one.', '#activity']);
    if (s.health.lastPollError) rows.push(['bad', 'activity', 'Comment check is failing', esc(s.health.lastPollError), '#activity']);
    if (a && a.tokenExpiresAt && a.tokenExpiresAt < Date.now()) rows.push(['bad', 'link', 'Instagram access token expired', 'Reconnect the account to keep automations running.', null]);
    else if (a && a.tokenExpiresAt && a.tokenExpiresAt - Date.now() < 7 * 86400000) rows.push(['warn', 'link', 'Instagram access token expires soon', `Valid for ${Math.floor((a.tokenExpiresAt - Date.now()) / 86400000)} more days — reconnect before then.`, null]);
    if (!a) rows.push(['warn', 'link', 'Instagram account not connected', 'Connect your professional account to start.', null]);
    if (!s.automationEnabled) rows.push(['warn', 'pause', 'Automations are paused', 'Resume them from the account menu or Settings.', '#settings']);
    const box = openModal(`${modalHead('Notifications')}${rows.length ? rows.map(([tone, icon, t, d, href]) => `
      <div class="alert-row"><div class="ico" style="width:40px;height:40px;background:var(--${tone}-bg);color:var(--${tone})">${ic(icon)}</div>
      <div style="flex:1"><b>${t}</b><div class="muted small">${d}</div></div>${href ? `<a class="btn small" href="${href}" data-close>Open</a>` : ''}</div>`).join('')
      : '<div class="empty">You are all caught up. Nothing needs attention.</div>'}`);
    $$('[data-close]', box).forEach((l) => l.addEventListener('click', closeModal));
  }

  // ---------- routing ----------

  const views = {};
  let refreshTimer;
  let gen = 0; // bumped on every navigation so a slow, old page can never draw over a newer one
  async function routeNow() {
    const name = (location.hash || `#${APP.home}`).slice(1).split('/')[0];
    if (views[name] && !APP.views.includes(name) && OTHER.views.includes(name)) return location.assign(OTHER.path + location.hash);
    const view = views[name] && APP.views.includes(name) ? name : APP.home;
    const g = ++gen;
    currentView = view;
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === (view === 'flow' ? 'flows' : view)));
    $('#nav-more')?.classList.toggle('active', !!$('#nav a.active[data-more]'));
    document.body.classList.toggle('builder-mode', view === 'flow');
    clearInterval(refreshTimer);
    renderTopbar();
    refreshChrome();
    try {
      await views[view]();
    } catch (e) {
      if (g !== gen) return;
      main.innerHTML = `<section class="card"><div class="empty">${esc(e.message)}<br><button class="btn primary" id="retry" type="button">${ic('refresh')}Try again</button></div></section>`;
      $('#retry').onclick = route;
    }
  }
  const route = debounce(routeNow, 80);
  // A page with unsaved work (the flow builder) can veto leaving it.
  let lastHash = location.hash;
  window.addEventListener('hashchange', () => {
    if (window.DMA?.guard && location.hash !== lastHash && !window.DMA.guard()) {
      history.replaceState(null, '', lastHash || `#${APP.home}`);
      return;
    }
    lastHash = location.hash;
    closeModal();
    route();
  });
  setInterval(() => { if (!$('#app').hidden && visible()) refreshChrome(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (visible() && !$('#app').hidden) refreshChrome(); });

  async function start() {
    const s = await fetch('/api/session').then((r) => r.json());
    if (!s.loggedIn) return showLogin();
    $('#login').hidden = true;
    $('#app').hidden = false;
    const q = new URLSearchParams(location.search);
    if (q.get('error')) toast(q.get('error'), true);
    if (q.get('connected')) toast('Instagram account connected');
    if (q.size) history.replaceState(null, '', location.pathname + location.hash);
    route();
  }

  // ---------- connect / setup help (opened from the checklist) ----------

  function openConnect() {
    const box = openModal(`${modalHead('Connect your Instagram account')}
      <p>Sign in with Instagram or Facebook, choose your business portfolio and tick your Instagram account. Alternatively, paste a token generated under <i>API setup with Unified login → Generate access tokens</i> in the Meta App Dashboard.</p>
      <div class="row" style="margin-bottom:16px"><a class="btn primary" href="/auth/instagram">Connect Instagram account</a></div>
      <form id="token-form" class="row"><input name="token" placeholder="…or paste an access token" style="flex:1;min-width:220px" autocomplete="off"><button class="btn">Save token</button></form>`);
    $('#token-form', box).onsubmit = run(async (e) => {
      e.preventDefault();
      await api('/account/token', { method: 'POST', body: { token: e.target.token.value } });
      closeModal();
      toast('Instagram account connected');
      reload();
    });
  }

  const ackKey = 'dm_ack_privacy';
  const getAck = () => { try { return localStorage.getItem(ackKey) === '1'; } catch { return false; } };
  const setAck = (v) => { try { localStorage.setItem(ackKey, v ? '1' : '0'); } catch { /* ignore */ } };

  // ---------- overview ----------

  let trendDays = 7;
  const niceStep = (max) => [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 50000].find((s) => s * 3 >= max) ?? Math.ceil(max / 3);
  const delta = (c) => (c === null || c === undefined ? '' : `<span class="delta ${c > 0 ? 'up' : c < 0 ? 'down' : 'flat'}">${c === 0 ? '' : ic(c > 0 ? 'up' : 'dn')}${c > 0 ? '+' : ''}${c}%</span>`);
  const statCard = (cls, icon, value, label, change) => `<div class="stat ${cls}"><div class="tile">${ic(icon)}</div><div><b>${num(value)}</b><div class="lbl">${label}${delta(change)}</div></div></div>`;
  const RULE_ICONS = ['zap', 'chat', 'gift', 'send', 'star'];
  const ruleHint = (r) => {
    if (r.trigger_type === 'welcome') return 'When someone messages for the first time';
    if (r.trigger_type === 'story_mention') return 'When someone mentions you in a story';
    const what = { dm: 'message', comment: 'comment', story_reply: 'story reply' }[r.trigger_type];
    if (r.match_mode === 'any') return `When any ${what} arrives`;
    const kw = r.keywords.slice(0, 2).map((k) => `“${k}”`).join(', ') + (r.keywords.length > 2 ? ` +${r.keywords.length - 2}` : '');
    return `When ${what} ${r.match_mode === 'exact' ? 'is' : 'contains'} ${kw}`;
  };
  const POST_TYPES = { IMAGE: 'Photo', CAROUSEL: 'Carousel', REELS: 'Reel', STORIES: 'Story' };
  const postTitle = (p) => (p.caption || '').split('\n')[0].trim() || `${POST_TYPES[p.type] || 'Post'} post`;
  const slot = (ms) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  const pthumb = (p) => {
    const m = p.media[0];
    const inner = !m ? ic('image') : m.kind === 'video' ? `<video src="${esc(m.url)}" muted preload="metadata"></video><span class="play">${ic('play')}</span>` : `<img src="${esc(m.url)}" alt="" loading="lazy">`;
    return `<div class="pthumb">${inner}</div>`;
  };
  const EV_ICON = { reply: 'chat', dm: 'send', comment: 'chat', post: 'calendar', published: 'check', rule: 'zap' };

  function promoArt() {
    return `<svg class="art" viewBox="0 0 250 178" aria-hidden="true">
      <defs>
        <radialGradient id="pg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#8b5cf6" stop-opacity=".55"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/></radialGradient>
        <linearGradient id="pb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d5cf0"/><stop offset="1" stop-color="#2d2a8c"/></linearGradient>
        <linearGradient id="pc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7d6bff"/><stop offset="1" stop-color="#4338ca"/></linearGradient>
      </defs>
      <ellipse cx="125" cy="92" rx="120" ry="78" fill="url(#pg)"/>
      <g transform="rotate(-13 110 88)">
        <rect x="68" y="6" width="86" height="156" rx="16" fill="url(#pb)" stroke="#a78bfa" stroke-opacity=".7" stroke-width="1.4"/>
        <rect x="74" y="13" width="74" height="142" rx="11" fill="#171551"/>
        <rect x="97" y="17" width="28" height="5" rx="2.5" fill="#2a2870"/>
        <rect x="90" y="62" width="42" height="42" rx="12" fill="url(#g-ig)"/>
        <rect x="98" y="70" width="26" height="26" rx="8" fill="none" stroke="#fff" stroke-width="2.4"/>
        <circle cx="111" cy="83" r="6" fill="none" stroke="#fff" stroke-width="2.4"/>
        <circle cx="119" cy="75" r="1.7" fill="#fff"/>
        <rect x="84" y="118" width="54" height="6" rx="3" fill="#2a2870"/><rect x="92" y="130" width="38" height="6" rx="3" fill="#2a2870"/>
      </g>
      <g transform="rotate(9 188 118)">
        <rect x="160" y="92" width="60" height="52" rx="14" fill="url(#pc)" stroke="#c4b5fd" stroke-opacity=".55"/>
        <path d="m204 106-24 10 9 3 3 9z" fill="#e9e3ff"/><path d="m204 106-15 13" stroke="#6d5cf0" stroke-width="1.6" fill="none"/>
      </g>
      <circle cx="40" cy="40" r="2" fill="#c4b5fd"/><circle cx="214" cy="48" r="2.6" fill="#a78bfa"/><circle cx="30" cy="126" r="1.6" fill="#a78bfa"/>
    </svg>`;
  }

  function drawTrend(el, ov) {
    const data = ov.trend;
    const W = Math.max(300, el.clientWidth), H = 232;
    const m = { l: 40, r: 16, t: 14, b: 30 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const total = data.reduce((s, d) => s + d.n, 0);
    const max = Math.max(...data.map((d) => d.n), 1);
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const X = (i) => m.l + (i / (data.length - 1)) * iw;
    const Y = (v) => m.t + ih - (v / top) * ih;
    const pts = data.map((d, i) => [X(i), Y(d.n)]);
    let line = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i - 1][0] + pts[i][0]) / 2;
      line += ` C${mx},${pts[i - 1][1]} ${mx},${pts[i][1]} ${pts[i][0]},${pts[i][1]}`;
    }
    const base = m.t + ih;
    const area = `${line} L${pts[pts.length - 1][0]},${base} L${pts[0][0]},${base} Z`;
    const label = (d) => new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const every = data.length > 10 ? Math.ceil(data.length / 7) : 1;
    let ticks = '';
    for (let v = 0; v <= top; v += step) ticks += `<line class="${v === 0 ? 'axis' : 'grid'}" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 12}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
    const xl = data.map((d, i) => ((data.length - 1 - i) % every === 0 ? `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${label(d)}</text>` : '')).join('');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Direct messages per day">
      <defs><linearGradient id="ta" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b5cf6" stop-opacity=".62"/><stop offset="1" stop-color="#6d4dff" stop-opacity="0"/></linearGradient>
      <linearGradient id="tl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#b39cff"/></linearGradient></defs>
      ${ticks}${xl}<path d="${area}" fill="url(#ta)"/><path d="${line}" fill="none" stroke="url(#tl)" stroke-width="2.6" stroke-linecap="round"/>
      <circle id="tp" r="6" fill="#161840" stroke="#c4b5fd" stroke-width="3"/><rect id="th" x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent"/></svg><div class="tip" id="tip"></div>`;
    const tip = $('.tip', el), dot = $('#tp', el);
    const show = (i, hovering) => {
      const [x, y] = pts[i];
      dot.setAttribute('cx', x); dot.setAttribute('cy', y);
      const c = ov.received.change;
      const sub = hovering ? label(data[i]) : c === null ? `Last ${data.length} days` : `${c >= 0 ? '↑' : '↓'} ${c > 0 ? '+' : ''}${c}% vs last ${data.length === 7 ? 'week' : 'period'}`;
      tip.innerHTML = `<b>${hovering ? data[i].n : total} DM${(hovering ? data[i].n : total) === 1 ? '' : 's'}</b><span class="${!hovering && c !== null ? (c >= 0 ? 'up' : 'down') : ''}">${sub}</span>`;
      const tw = tip.offsetWidth;
      const left = Math.max(tw / 2, Math.min(W - tw / 2, x));
      tip.style.left = left + 'px'; tip.style.top = y + 'px';
      tip.style.setProperty('--caret', `${50 + ((x - left) / tw) * 100}%`);
    };
    show(data.length - 1, false);
    const th = $('#th', el);
    let raf = 0;
    th.onpointermove = (e) => {
      if (raf) return;
      const cx = e.clientX;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = el.getBoundingClientRect();
        const px = ((cx - r.left) / r.width) * W;
        show(Math.max(0, Math.min(data.length - 1, Math.round(((px - m.l) / iw) * (data.length - 1)))), true);
      });
    };
    th.onpointerleave = () => show(data.length - 1, false);
  }

  views.overview = async () => {
    const tz = -new Date().getTimezoneOffset();
    const g = gen;
    const [s, ov] = await Promise.all([api('/status'), api(`/overview?days=${trendDays}&tz=${tz}`)]);
    if (g !== gen) return;
    const rules = ov.rules;
    const a = s.account, c = s.config;
    const daysLeft = a && a.tokenExpiresAt ? Math.floor((a.tokenExpiresAt - Date.now()) / 86400000) : null;
    const tokenNote = daysLeft === null ? 'The access token does not expire.' : daysLeft < 0 ? 'The access token has EXPIRED — reconnect.' : `The access token is valid for ${daysLeft} more days — reconnect before then.`;
    const metaReady = c.appId && c.appSecret && c.configId;
    const webhookSeen = s.health.lastWebhookAt > 0;
    const wh = a?.webhooks;
    const app = wh?.app;
    const appMissing = app?.found ? wh.expected.filter((f) => !app.fields.includes(f)) : [];
    const appOk = !!(app?.found && app.active && app.callbackUrl === c.webhookUrl && !appMissing.length);
    const checked = wh?.checkedAt ? `Checked with Meta ${ago(wh.checkedAt)}.` : 'Checking with Meta…';
    const appBody = () => {
      if (!app) return '<p class="muted">Checking your Meta app\'s webhook settings…</p>';
      if (!app.checked) return `<p class="muted">Could not read your Meta app's webhook settings: ${esc(app.error || 'unknown error')}</p>`;
      if (!app.found) return `<p class="error">No Instagram webhook is set up in your Meta app yet.</p>
        <p class="muted">In the Meta dashboard open <i>API setup with Unified login → Configure webhooks</i>, paste the callback URL <code>${esc(c.webhookUrl)}</code> and your verify token, click <b>Verify and save</b>, then switch on ${wh.expected.map((f) => `<code>${esc(f)}</code>`).join(' ')}. Meta only lets you do this part in its dashboard.</p>`;
      return `<p>${app.callbackUrl === c.webhookUrl ? `Callback URL in Meta: <code>${esc(app.callbackUrl)}</code> ✓` : `<span class="error">Callback URL in Meta is <code>${esc(app.callbackUrl || 'empty')}</code> but should be <code>${esc(c.webhookUrl)}</code>.</span>`}</p>
        <p>${appMissing.length ? `<span class="error">Switch on these fields in Meta: ${appMissing.map((f) => `<code>${esc(f)}</code>`).join(' ')}</span>` : `Fields switched on in Meta: ${app.fields.map((f) => `<code>${esc(f)}</code>`).join(' ')}`}</p>
        ${app.active ? '' : '<p class="error">Meta reports this webhook as inactive. Open Configure webhooks and click Verify and save again.</p>'}`;
    };
    const upcoming = ov.upcoming;
    const refreshAfter = () => reload();

    const steps = [
      { t: 'Connect your Instagram account', ok: !!a, body: () => a
          ? `<p>Connected as <b>@${esc(a.username)}</b> · ${num(a.followers)} followers.</p><p class="muted">${tokenNote}</p>
             <div class="row"><button class="btn" id="d-resub" type="button">Check webhooks</button><a class="btn" href="/auth/instagram">Reconnect</a><button class="btn danger" id="d-disc" type="button">Disconnect</button></div>`
          : '<p>No Instagram account is connected yet.</p><a class="btn primary" href="/auth/instagram">Connect Instagram account</a>' },
      { t: 'Configure Meta App & permissions', ok: !!metaReady, body: () => `<p>${metaReady ? 'Meta app ID, app secret and login configuration ID are set.' : 'Set <code>META_APP_ID</code>, <code>META_APP_SECRET</code> and <code>META_CONFIG_ID</code> in <code>.env</code>, then restart.'}</p>
          <p class="muted">Login configuration permissions:</p><div class="row">${c.permissions.map((p) => `<code>${esc(p)}</code>`).join(' ')}</div>
          <p class="muted" style="margin-top:14px">Redirect URL for the login configuration:</p><code>${esc(c.redirectUri)}</code>` },
      { t: 'Set webhook callback URL', ok: !!(c.verifyToken && c.https), body: () => `<p>Callback URL: <code>${esc(c.webhookUrl)}</code></p>
          <p>${c.verifyToken ? 'The verify token from <code>.env</code> is set — paste the same value into Meta.' : 'Set <code>WEBHOOK_VERIFY_TOKEN</code> in <code>.env</code>, then restart.'}</p>
          <p>${c.https ? 'Public HTTPS address: <code>' + esc(c.baseUrl) + '</code>' : 'Meta requires https. Set <code>BASE_URL</code> to your public https address.'}</p>` },
      { t: 'Account subscribed to webhooks', ok: !!wh?.ok, body: () => a
          ? `<p>${wh.ok ? `@${esc(a.username)} is subscribed to ${wh.fields.map((f) => `<code>${esc(f)}</code>`).join(' ')}.` : wh.error ? `<span class="error">Not subscribed yet: ${esc(wh.error)}</span>` : 'Subscribing…'}</p>
             <p class="muted">${checked} This is automatic: the app subscribes when you connect, re-checks with Meta every 30 minutes (every 5 minutes after a failure), and re-subscribes on its own if anything is missing.</p>
             <button class="btn" id="d-resub" type="button">${ic('refresh')}Check now</button>`
          : '<p>Connect an Instagram account first.</p>' },
      { t: 'Review privacy policy URL', ok: getAck(), body: () => `<p>Paste this address into the privacy policy field of your Meta app:</p><code>${esc(c.privacyUrl)}</code>
          <div class="row" style="margin-top:16px"><button class="btn ${getAck() ? '' : 'primary'}" id="d-ack" type="button">${getAck() ? 'Mark as not done' : 'Mark as done'}</button></div>` },
      { t: 'Webhooks set up in Meta', ok: appOk || webhookSeen, body: () => `${a ? appBody() : '<p>Connect an Instagram account first.</p>'}
          <p>${webhookSeen ? `Last webhook received <b>${ago(s.health.lastWebhookAt)}</b>.` : 'No real webhook has arrived yet.'}</p>
          <p class="muted">Meta only sends real messages and comments to apps in <b>Live</b> mode (top of the Meta dashboard). In Development mode only the dashboard's test button reaches your server.</p>
          <p class="${s.health.lastPollError ? 'error' : 'muted'}">${s.health.lastPollError ? 'Comment polling error: ' + esc(s.health.lastPollError) : `Comment check last ran ${ago(s.health.lastPollAt)}${s.health.lastCommentWebhookAt ? ' · comment webhooks are also arriving' : ''}.`}</p>
          ${a ? `<button class="btn" id="d-resub" type="button">${ic('refresh')}Check now</button>` : ''}` },
      { t: 'Run a test DM from another account', ok: ov.sent.value > 0, body: () => `<p>${ov.sent.value > 0 ? `An automation reply was sent in the last ${ov.days} days — it works.` : 'Send your account a DM from a different Instagram account whose text matches one of your automations.'}</p>
          <p class="muted">The Overview then shows the message under <i>Recent Activity</i>. The account must have messaged you in the last 24 hours before you can reply by hand.</p>` },
    ];
    const done = steps.filter((x) => x.ok).length;

    main.innerHTML = `
      <div class="dash">
        <div class="col">
          <div class="stats">
            ${statCard('s1', 'send', ov.received.value, 'DMs Received', ov.received.change)}
            ${statCard('s2', 'reply', ov.sent.value, 'DM Replies Sent', ov.sent.change)}
            ${statCard('s3', 'calendarCheck', ov.scheduledPosts, 'Posts Scheduled', null)}
            ${statCard('s4', 'users', ov.conversations.value, 'Total Conversations', ov.conversations.change)}
          </div>
          <div class="mid">
            <section class="card">
              <div class="card-head"><h2>Conversation Trend</h2>
                <select class="sel" id="range" aria-label="Range"><option value="7" ${trendDays === 7 ? 'selected' : ''}>Last 7 days</option><option value="30" ${trendDays === 30 ? 'selected' : ''}>Last 30 days</option></select></div>
              <div class="chart" id="chart"></div>
            </section>
            <section class="card">
              <div class="prog"><h2>Setup checklist</h2><span>${done} of ${steps.length} done</span></div>
              <div class="prog-bar"><i style="width:${(done / steps.length) * 100}%"></i></div>
              <ul class="checklist">${steps.map((x, i) => `<li><button type="button" data-step="${i}"><span class="ck ${x.ok ? 'ok' : ''}">${x.ok ? ic('check') : ''}</span><span>${x.t}</span><span class="chev">${ic('right')}</span></button></li>`).join('')}</ul>
            </section>
          </div>
          <div class="pair">
            <section class="card">
              <div class="card-head"><div><h2>Automations</h2><p>Auto-reply to DMs, qualify leads, and start conversations.</p></div><button class="btn primary" id="new-rule" type="button">${ic('plus')}New automation</button></div>
              ${rules.length ? rules.slice(0, 3).map((r, i) => `
                <div class="item">
                  <div class="ico c${i % 5}">${ic(RULE_ICONS[i % 5])}</div>
                  <div class="grow"><b>${esc(r.name)}</b><span>${esc(ruleHint(r))}</span></div>
                  <span class="pill ${r.enabled ? 'ok' : ''}">${r.enabled ? 'Active' : 'Off'}</span>
                  <input class="switch" type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''} aria-label="Turn ${esc(r.name)} on or off">
                  <div class="num"><b>${num(ov.ruleReplies[r.id])} repl${ov.ruleReplies[r.id] === 1 ? 'y' : 'ies'}</b><span>Last 7 days</span></div>
                  <button class="kebab" type="button" data-pop data-menu-rule="${r.id}" aria-label="More">${ic('more')}</button>
                </div>`).join('') + (rules.length > 3 ? `<div style="margin-top:8px"><a class="link" href="#rules">View all ${rules.length} automations</a></div>` : '')
                : `<div class="empty">No automations yet.<br>Create one to start replying automatically.<br><button class="btn primary" id="empty-rule" type="button">${ic('plus')}New automation</button></div>`}
            </section>
            <section class="card">
              <div class="card-head"><div><h2>Scheduled Posts</h2><p>Photos, carousels, reels and stories.</p></div><button class="btn primary" id="new-post" type="button">${ic('plus')}Schedule post</button></div>
              ${upcoming.length ? upcoming.map((p) => `
                <div class="post">${pthumb(p)}
                  <div class="grow"><b>${IG('ig')}<em>${esc(postTitle(p))}</em></b><span>${ic('calendar')}${slot(p.scheduled_at)}</span></div>
                  <span class="pill ${p.status === 'publishing' ? 'warn' : 'ok'}">${p.status === 'publishing' ? 'Publishing…' : 'Scheduled'}</span>
                  <button class="kebab" type="button" data-pop data-menu-post="${p.id}" aria-label="More">${ic('more')}</button>
                </div>`).join('') + (ov.postCount > upcoming.length ? `<div style="margin-top:8px"><a class="link" href="#posts">Open scheduler</a></div>` : '')
                : `<div class="empty">Nothing scheduled yet.<br><button class="btn primary" id="empty-post" type="button">${ic('plus')}Schedule post</button></div>`}
            </section>
          </div>
        </div>
        <div class="side-col">
          <section class="promo">${promoArt()}<h3>Set up DM automation in minutes</h3><p>Auto-reply, capture leads, and keep your audience engaged 24/7.</p><button class="btn light" id="promo-btn" type="button">Create automation ${ic('arrow')}</button></section>
          <section class="card">
            <div class="card-head" style="margin-bottom:6px"><h2>Recent Activity</h2><a class="link" href="#activity">View all</a></div>
            <div class="feed">${ov.recent.length ? ov.recent.map((e) => `
              <div class="ev"><div class="ring ${e.type}">${ic(EV_ICON[e.type])}</div><div class="grow"><b>${esc(e.title)}</b><span>${esc(e.sub)}</span></div><time>${short(e.ts)}</time></div>`).join('') : '<div class="empty">Activity will appear here.</div>'}</div>
          </section>
        </div>
      </div>`;

    // chart
    const chartEl = $('#chart');
    const paint = () => drawTrend(chartEl, ov);
    paint();
    let rt; const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => chartEl.isConnected && paint(), 120); });
    ro.observe(chartEl);
    $('#range').onchange = run(async (e) => { trendDays = Number(e.target.value); ro.disconnect(); await views.overview(); });

    // checklist details
    $$('[data-step]').forEach((b) => (b.onclick = () => {
      const st = steps[Number(b.dataset.step)];
      const box = openModal(`${modalHead(esc(st.t))}<div class="row" style="margin-bottom:12px"><span class="pill ${st.ok ? 'ok' : 'warn'}">${st.ok ? 'Done' : 'To do'}</span></div>${st.body()}`);
      const r = $('#d-resub', box); if (r) r.onclick = run(async () => { closeModal(); await doResub(); });
      const d = $('#d-disc', box); if (d) d.onclick = run(doDisconnect);
      const k = $('#d-ack', box); if (k) k.onclick = () => { setAck(!getAck()); closeModal(); refreshAfter(); };
    }));

    // automations + posts
    const newRule = run(async () => ruleForm(null, await api('/media')));
    $('#new-rule').onclick = newRule; $('#promo-btn').onclick = newRule;
    if ($('#empty-rule')) $('#empty-rule').onclick = newRule;
    const newPost = () => postForm(null);
    $('#new-post').onclick = newPost; if ($('#empty-post')) $('#empty-post').onclick = newPost;
    $$('[data-toggle]').forEach((t) => (t.onchange = run(async () => { await api(`/rules/${t.dataset.toggle}/toggle`, { method: 'POST' }); refreshAfter(); })));
    $$('[data-menu-rule]').forEach((b) => (b.onclick = () => {
      const r = rules.find((x) => x.id == b.dataset.menuRule);
      popover(b, [
        { icon: 'edit', label: 'Edit', onClick: async () => ruleForm(r, await api('/media')) },
        { icon: 'trash', label: 'Delete', danger: true, onClick: async () => { if (!confirm('Delete this automation?')) return; await api(`/rules/${r.id}`, { method: 'DELETE' }); refreshAfter(); } },
      ]);
    }));
    $$('[data-menu-post]').forEach((b) => (b.onclick = () => {
      const p = upcoming.find((x) => x.id == b.dataset.menuPost);
      popover(b, [
        { icon: 'edit', label: 'Edit', onClick: () => postForm(p) },
        { icon: 'trash', label: 'Delete', danger: true, onClick: async () => { if (!confirm('Remove this post from the scheduler? (A published post stays on Instagram.)')) return; await api(`/posts/${p.id}`, { method: 'DELETE' }); refreshAfter(); } },
      ]);
    }));
    refreshTimer = setInterval(() => visible() && $('#modal').hidden && !pop && run(views.overview)(), 90000);
  };

  // ---------- automations ----------

  const TRIGGERS = {
    dm: 'Direct message',
    comment: 'Comment on a post',
    story_reply: 'Reply to my story',
    story_mention: 'Mentions me in their story',
    welcome: 'First ever message',
  };

  function triggerSummary(r, media) {
    const kw = r.match_mode === 'any' ? 'anything' : r.keywords.map((k) => `“${esc(k)}”`).join(', ');
    const how = r.match_mode === 'exact' ? 'is exactly' : 'contains';
    if (r.trigger_type === 'welcome') return 'When someone messages for the first time';
    if (r.trigger_type === 'story_mention') return 'When someone mentions me in their story';
    const where = { dm: 'a DM', comment: 'a comment', story_reply: 'a story reply' }[r.trigger_type];
    const post = r.trigger_type === 'comment' ? (r.media_id ? ` on ${esc(mediaLabel(media.find((m) => m.id === r.media_id)) || 'one post')}` : ' on any post') : '';
    return r.match_mode === 'any' ? `When ${where} arrives${post}` : `When ${where}${post} ${how} ${kw}`;
  }
  const mediaLabel = (m) => (m ? `${new Date(m.timestamp).toLocaleDateString()} · ${(m.caption || m.media_type || 'post').slice(0, 40)}` : '');

  views.rules = async () => {
    const g = gen;
    const [rules, media] = await Promise.all([api('/rules'), api('/media')]);
    if (g !== gen) return;
    main.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>Your automations</h2><p>${rules.length} rule${rules.length === 1 ? '' : 's'} · ${rules.filter((r) => r.enabled).length} active</p></div><button class="btn primary" id="new-rule" type="button">${ic('plus')}New automation</button></div>
        ${rules.length ? rules.map((r, i) => `
        <div class="rule-card">
          <div class="item" style="padding:0;border:0">
            <div class="ico c${i % 5}">${ic(RULE_ICONS[i % 5])}</div>
            <div class="grow"><b>${esc(r.name)}</b><span>${triggerSummary(r, media)}</span></div>
            <span class="pill ${r.enabled ? 'ok' : ''}">${r.enabled ? 'Active' : 'Off'}</span>
            <input class="switch" type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''} aria-label="Turn ${esc(r.name)} on or off">
            <div class="num"><b>${num(r.hits)} triggered</b><span>All time</span></div>
            <button class="kebab" type="button" data-pop data-menu="${r.id}" aria-label="More">${ic('more')}</button>
          </div>
          ${r.reply_text ? `<div class="reply">↳ DM: ${esc(r.reply_text)}</div>` : ''}
          ${r.buttons.length ? `<div class="row">${r.buttons.map((b) => `<span class="pill accent">${esc(b.title)}</span>`).join('')}</div>` : ''}
          ${r.quick_replies.length ? `<div class="row">${r.quick_replies.map((q) => `<span class="pill">${esc(q)}</span>`).join('')}</div>` : ''}
          ${r.comment_replies.length ? `<div class="reply">↳ Public reply: ${esc(r.comment_replies[0])}${r.comment_replies.length > 1 ? ` (+${r.comment_replies.length - 1} variants)` : ''}</div>` : ''}
        </div>`).join('') : `<div class="empty">No automations yet. Create one to start replying automatically.</div>`}
      </section>`;

    $('#new-rule').onclick = () => ruleForm(null, media);
    $$('[data-menu]').forEach((b) => (b.onclick = () => {
      const r = rules.find((x) => x.id == b.dataset.menu);
      popover(b, [
        { icon: 'edit', label: 'Edit', onClick: () => ruleForm(r, media) },
        { icon: 'trash', label: 'Delete', danger: true, onClick: async () => { if (!confirm('Delete this automation?')) return; await api(`/rules/${r.id}`, { method: 'DELETE' }); views.rules(); } },
      ]);
    }));
    $$('[data-toggle]').forEach((t) => (t.onchange = run(async () => {
      await api(`/rules/${t.dataset.toggle}/toggle`, { method: 'POST' });
      views.rules();
    })));
  };

  function ruleForm(rule, media) {
    const r = rule ?? { name: '', trigger_type: 'dm', match_mode: 'contains', keywords: [], reply_text: '', buttons: [], quick_replies: [], comment_replies: [], cooldown_minutes: 0, priority: 0, enabled: 1, media_id: null };
    const btn = (i) => r.buttons[i] ?? { title: '', url: '' };
    const box = openModal(`
      ${modalHead(rule ? 'Edit automation' : 'New automation')}
      <form class="form" id="rule-form">
        <label>Name<input name="name" value="${esc(r.name)}" placeholder="e.g. Send price list" required></label>
        <div class="cols">
          <label>When this happens<select name="trigger_type">${Object.entries(TRIGGERS).map(([k, v]) => `<option value="${k}" ${r.trigger_type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label data-for="match">And the text<select name="match_mode">
            <option value="contains" ${r.match_mode === 'contains' ? 'selected' : ''}>contains a keyword</option>
            <option value="exact" ${r.match_mode === 'exact' ? 'selected' : ''}>is exactly a keyword</option>
            <option value="any" ${r.match_mode === 'any' ? 'selected' : ''}>is anything</option>
          </select></label>
        </div>
        <label data-for="keywords">Keywords <span class="hint">Separate with commas. Not case-sensitive.</span><input name="keywords" value="${esc(r.keywords.join(', '))}" placeholder="price, link, info"></label>
        <label data-for="media">Limit to one post <span class="hint">Recent posts appear here once the account is connected.</span><select name="media_id"><option value="">Any post</option>${media.map((m) => `<option value="${esc(m.id)}" ${r.media_id === m.id ? 'selected' : ''}>${esc(mediaLabel(m))}</option>`).join('')}</select></label>
        <label>Send this DM <span class="hint">Use {{first_name}} or {{username}}. Up to 1000 characters (640 with buttons).</span><textarea name="reply_text" placeholder="Hey {{first_name}}! Here is the link you asked for…">${esc(r.reply_text)}</textarea></label>
        <label>Link buttons <span class="hint">Optional, up to 3. Title (max 20 characters) and an https:// link.</span>
          ${[0, 1, 2].map((i) => `<div class="cols"><input name="bt${i}" value="${esc(btn(i).title)}" placeholder="Button title" maxlength="20"><input name="bu${i}" value="${esc(btn(i).url)}" placeholder="https://…"></div>`).join('')}
        </label>
        <label data-for="quick">Quick replies <span class="hint">Optional tappable answers, comma separated (max 20 characters each). Not used when link buttons are set.</span><input name="quick_replies" value="${esc(r.quick_replies.join(', '))}" placeholder="Pricing, Talk to a human"></label>
        <label data-for="comment">Public replies to the comment <span class="hint">Optional. One per line; a random one is used each time so replies do not look repetitive.</span><textarea name="comment_replies" placeholder="Sent you a DM! 📩&#10;Check your inbox ✅">${esc(r.comment_replies.join('\n'))}</textarea></label>
        <div class="cols">
          <label>Cooldown (minutes) <span class="hint">Do not fire again for the same person within this time.</span><input name="cooldown_minutes" type="number" min="0" value="${r.cooldown_minutes}"></label>
          <label>Priority <span class="hint">Higher numbers are checked first.</span><input name="priority" type="number" min="-100" max="100" value="${r.priority}"></label>
        </div>
        <label class="check"><input type="checkbox" class="switch" name="enabled" ${r.enabled ? 'checked' : ''}> Turned on</label>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" id="cancel">Cancel</button><button class="btn primary">Save</button></div>
      </form>`);

    const f = $('#rule-form', box);
    const sync = () => {
      const t = f.trigger_type.value;
      const fixedAny = t === 'welcome' || t === 'story_mention';
      $('[data-for=match]', box).hidden = fixedAny;
      $('[data-for=keywords]', box).hidden = fixedAny || f.match_mode.value === 'any';
      $('[data-for=media]', box).hidden = t !== 'comment';
      $('[data-for=comment]', box).hidden = t !== 'comment';
      $('[data-for=quick]', box).hidden = t === 'comment';
    };
    f.trigger_type.onchange = f.match_mode.onchange = sync;
    sync();
    $('#cancel', box).onclick = closeModal;
    f.onsubmit = run(async (e) => {
      e.preventDefault();
      const body = {
        name: f.name.value, trigger_type: f.trigger_type.value, match_mode: f.match_mode.value,
        keywords: f.keywords.value.split(',').map((s) => s.trim()).filter(Boolean),
        media_id: f.media_id.value || null, reply_text: f.reply_text.value,
        buttons: [0, 1, 2].map((i) => ({ title: f[`bt${i}`].value, url: f[`bu${i}`].value })),
        quick_replies: f.quick_replies.value.split(',').map((s) => s.trim()).filter(Boolean),
        comment_replies: lines(f.comment_replies.value),
        cooldown_minutes: f.cooldown_minutes.value, priority: f.priority.value, enabled: f.enabled.checked,
      };
      await api(rule ? `/rules/${rule.id}` : '/rules', { method: rule ? 'PUT' : 'POST', body });
      closeModal();
      toast('Automation saved');
      route();
    });
  }

  // ---------- inbox ----------

  let openContact = null;
  const nameOf = (c) => (c.username ? '@' + c.username : c.name || c.igsid);
  const initialOf = (c) => esc((c.username || c.name || '?').charAt(0).toUpperCase());
  views.inbox = async () => {
    main.innerHTML = `
      <div class="card inbox">
        <div class="threads"><div class="search"><input id="search" placeholder="Search people…" aria-label="Search people"></div><div id="threads"></div></div>
        <div class="chat" id="chat"><div class="empty">Select a conversation.</div></div>
      </div>`;
    const loadThreads = async () => {
      const list = await api('/contacts?q=' + encodeURIComponent($('#search')?.value ?? ''));
      if (!$('#threads')) return;
      $('#threads').innerHTML = list.length ? list.map((c) => `
        <div class="thread ${c.igsid === openContact ? 'active' : ''}" data-id="${esc(c.igsid)}">
          <div class="av">${initialOf(c)}</div>
          <div class="grow"><b>${esc(nameOf(c))}</b><span>${esc(c.last_text || '')}</span></div>
          <time>${short(c.last_at || c.first_seen)}</time>
        </div>`).join('') : '<div class="empty">No conversations yet.</div>';
      $$('.thread', $('#threads')).forEach((el) => (el.onclick = () => {
        openContact = el.dataset.id;
        loadThreads();
        loadChat();
      }));
    };
    const loadChat = run(async (keepDraft) => {
      if (!openContact) return;
      const draft = keepDraft ? $('#chat textarea')?.value ?? '' : '';
      const d = await api(`/contacts/${encodeURIComponent(openContact)}/messages`);
      if (!$('#chat')) return;
      const c = d.contact;
      const paused = c.paused_until > Date.now();
      const KIND = { comment: 'comment', private_reply: 'DM reply to comment', comment_reply: 'public reply', story_reply: 'story reply', story_mention: 'story mention' };
      $('#chat').innerHTML = `
        <div class="chat-head row spread">
          <div class="row"><div class="av">${initialOf(c)}</div><b>${esc(nameOf(c))}</b> <span class="pill ${d.windowOpen ? 'ok' : ''}">${d.windowOpen ? '24h window open' : 'Window closed'}</span>${paused ? ' <span class="pill warn">Automation paused</span>' : ''}</div>
          <div class="row"><button class="btn small" id="pause" type="button">${paused ? 'Resume automation' : 'Pause automation 24h'}</button><button class="btn small danger" id="forget" type="button">Delete</button></div>
        </div>
        <div class="chat-body">${d.messages.map((m) => `
          <div class="bubble ${m.direction === 'out' ? 'out' : ''}">${esc(m.text || '')}<small>${KIND[m.kind] ? KIND[m.kind] + ' · ' : ''}${m.direction === 'out' ? (m.source === 'auto' ? 'automation · ' : m.source === 'human' ? 'sent from Instagram · ' : 'you · ') : ''}${when(m.created_at)}</small></div>`).join('') || '<div class="empty">No messages.</div>'}
        </div>
        <form class="chat-foot"><textarea placeholder="${d.windowOpen ? 'Write a reply…' : 'You can reply once this person messages again (24-hour rule)'}" ${d.windowOpen ? '' : 'disabled'}></textarea><button class="btn primary" ${d.windowOpen ? '' : 'disabled'}>${ic('send')}Send</button></form>`;
      const bodyEl = $('#chat .chat-body');
      bodyEl.scrollTop = bodyEl.scrollHeight;
      const ta = $('#chat textarea');
      ta.value = draft;
      $('#chat form').onsubmit = run(async (e) => {
        e.preventDefault();
        await api(`/contacts/${encodeURIComponent(openContact)}/send`, { method: 'POST', body: { text: ta.value } });
        ta.value = '';
        toast('Queued — it sends within a few seconds');
        setTimeout(() => loadChat(), 2500);
      });
      $('#pause').onclick = run(async () => {
        await api(`/contacts/${encodeURIComponent(openContact)}/pause`, { method: 'POST', body: { minutes: paused ? 0 : 1440 } });
        loadChat();
      });
      $('#forget').onclick = run(async () => {
        if (!confirm('Delete this person and their conversation history from this dashboard?')) return;
        await api(`/contacts/${encodeURIComponent(openContact)}`, { method: 'DELETE' });
        openContact = null;
        views.inbox();
      });
    });
    let t;
    $('#search').oninput = () => {
      clearTimeout(t);
      t = setTimeout(run(loadThreads), 250);
    };
    await loadThreads();
    loadChat();
    refreshTimer = setInterval(() => {
      if (!visible()) return;
      run(loadThreads)();
      if (document.activeElement?.tagName !== 'TEXTAREA') loadChat(true);
    }, 20000);
  };

  // ---------- scheduler ----------

  const toLocalInput = (ms) => {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  };

  const thumb = (m) => `<span class="thumb">${m.kind === 'video' ? `<video src="${esc(m.url)}" muted preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="" loading="lazy">`}</span>`;

  function postForm(post, defaults = {}) {
    let media = post ? [...post.media] : [];
    const at = post && post.scheduled_at > Date.now() ? post.scheduled_at : defaults.at ?? Date.now() + 3600000;
    const box = openModal(`
      ${modalHead(post ? 'Edit post' : 'Schedule a post')}
      <form class="form" id="post-form">
        <div class="cols">
          <label>Type<select name="type">${Object.entries(POST_TYPES).map(([k, v]) => `<option value="${k}" ${post?.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label>Publish at<input type="datetime-local" name="at" value="${toLocalInput(at)}" required></label>
        </div>
        <label>Media <span class="hint" id="media-hint"></span><input type="file" id="files" multiple accept="image/*,video/mp4,video/quicktime"></label>
        <div class="thumbs" id="thumbs"></div>
        <label data-for="caption">Caption <span class="hint">Up to 2200 characters. Stories have no caption.</span><textarea name="caption" rows="5">${esc(post?.caption ?? '')}</textarea></label>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div>
      </form>`);
    const f = $('#post-form', box);
    const draw = () => {
      $('#thumbs', box).innerHTML = media.map((m, i) => `<span class="thumb">${m.kind === 'video' ? `<video src="${esc(m.url)}" muted preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="">`}<button type="button" data-rm="${i}" aria-label="Remove">×</button></span>`).join('');
      $$('[data-rm]', box).forEach((b) => (b.onclick = () => {
        media.splice(Number(b.dataset.rm), 1);
        draw();
      }));
    };
    const sync = () => {
      const t = f.type.value;
      $('[data-for=caption]', box).hidden = t === 'STORIES';
      $('#media-hint', box).textContent = { IMAGE: 'One image. PNG/WebP are converted to JPEG.', CAROUSEL: '2 to 20 images or videos.', REELS: 'One MP4/MOV video.', STORIES: 'One image or video.' }[t];
    };
    f.type.onchange = sync;
    sync();
    draw();
    $('#files', box).onchange = run(async (e) => {
      if (!e.target.files.length) return;
      const form = new FormData();
      for (const file of e.target.files) form.append('files', file);
      $('#save', box).disabled = true;
      toast('Uploading…');
      try {
        const up = await api('/upload', { method: 'POST', form });
        media.push(...up.map(({ url, kind }) => ({ url, kind })));
        draw();
        toast('Uploaded');
      } finally {
        $('#save', box).disabled = false;
        e.target.value = '';
      }
    });
    $('#cancel', box).onclick = closeModal;
    f.onsubmit = run(async (e) => {
      e.preventDefault();
      const body = { type: f.type.value, caption: f.type.value === 'STORIES' ? '' : f.caption.value, media, scheduled_at: new Date(f.at.value).getTime() };
      await api(post ? `/posts/${post.id}` : '/posts', { method: post ? 'PUT' : 'POST', body });
      closeModal();
      toast(post ? 'Post updated' : 'Post scheduled');
      route();
    });
  }

  // ---------- activity ----------

  views.activity = async () => {
    const g = gen;
    const [outbox, logs] = await Promise.all([api('/outbox'), api('/logs')]);
    if (g !== gen) return;
    const KIND = { dm: 'DM', private_reply: 'DM reply to comment', comment_reply: 'Public reply' };
    const cls = { sent: 'ok', pending: 'accent', sending: 'accent', failed: 'bad', skipped: 'warn' };
    main.innerHTML = `
      <div class="stack">
        <section class="card"><div class="card-head"><h2>Sent replies</h2></div>${outbox.length ? `<div class="table-wrap"><table>
          <tr><th>When</th><th>To</th><th>Type</th><th>Message</th><th>Automation</th><th>Status</th></tr>
          ${outbox.map((o) => `<tr>
            <td style="white-space:nowrap">${when(o.created_at)}</td>
            <td>${esc(o.username ? '@' + o.username : o.igsid || '')}</td>
            <td>${KIND[o.kind]}</td>
            <td class="clip">${esc((o.preview || '').slice(0, 160))}</td>
            <td>${esc(o.rule_name || (o.source === 'manual' ? 'Manual reply' : ''))}</td>
            <td><span class="pill ${cls[o.status]}">${o.status}</span>${o.error ? `<div class="small ${o.status === 'failed' ? 'error' : 'muted'}">${esc(o.error)}</div>` : ''}</td>
          </tr>`).join('')}</table></div>` : '<div class="empty">Nothing sent yet.</div>'}
        </section>
        <section class="card"><div class="card-head"><h2>System log</h2></div>${logs.length ? `<div class="table-wrap"><table>
          ${logs.map((l) => `<tr><td style="white-space:nowrap">${when(l.created_at)}</td><td><span class="pill ${{ info: '', warn: 'warn', error: 'bad' }[l.level]}">${l.level}</span></td><td class="clip" style="max-width:none">${esc(l.message)}</td></tr>`).join('')}</table></div>` : '<div class="empty">No log entries.</div>'}
        </section>
      </div>`;
  };

  // ---------- settings ----------

  views.settings = async () => {
    const g = gen;
    const s = await api('/settings');
    if (g !== gen) return;
    main.innerHTML = `
      <form class="card form" id="settings-form" style="max-width:660px">
        <label class="check"><input type="checkbox" class="switch" name="automation_enabled" ${s.automation_enabled ? 'checked' : ''}> Automations are running</label>
        <label>Maximum replies per hour <span class="hint">A safety cap. Extra replies wait in the queue instead of being dropped.</span><input type="number" name="dm_hourly_limit" min="1" max="1000" value="${s.dm_hourly_limit}"></label>
        <label>Pause automation after I reply by hand (minutes) <span class="hint">When you answer someone from the Instagram app, automations stay quiet in that chat for this long. 0 turns this off.</span><input type="number" name="human_pause_min" min="0" max="10080" value="${s.human_pause_min}"></label>
        <label>Maximum automated replies per person per hour <span class="hint">Stops a loop with another auto-responder, or one person triggering endless replies.</span><input type="number" name="contact_hourly_limit" min="1" max="100" value="${s.contact_hourly_limit}"></label>
        <label class="check"><input type="checkbox" class="switch" name="poll_comments" ${s.poll_comments ? 'checked' : ''}> Check for new comments through the API</label>
        <p class="hint">Comment webhooks only work once Meta grants your app Advanced Access. Until then this check finds new comments by itself. Leaving it on with webhooks is safe: each comment is handled once.</p>
        <div class="cols">
          <label>Check every (seconds)<input type="number" name="poll_interval_sec" min="30" max="3600" value="${s.poll_interval_sec}"></label>
          <label>Recent posts to watch<input type="number" name="poll_media_count" min="1" max="50" value="${s.poll_media_count}"></label>
        </div>
        <div class="row"><button class="btn primary">Save settings</button></div>
      </form>`;
    $('#settings-form').onsubmit = run(async (e) => {
      e.preventDefault();
      const f = e.target;
      await api('/settings', { method: 'PUT', body: {
        automation_enabled: f.automation_enabled.checked ? 1 : 0, poll_comments: f.poll_comments.checked ? 1 : 0,
        dm_hourly_limit: f.dm_hourly_limit.value, human_pause_min: f.human_pause_min.value, contact_hourly_limit: f.contact_hourly_limit.value,
        poll_interval_sec: f.poll_interval_sec.value, poll_media_count: f.poll_media_count.value,
      } });
      await refreshChrome(true);
    }, 'Settings saved');
  };

  // On phones the bottom bar holds five tabs; the rest live behind "More".
  $('#nav-more').onclick = (e) => popover(e.currentTarget, $$('#nav a[data-more]').map((a) => ({
    icon: { rules: 'zap', activity: 'activity', settings: 'settings' }[a.dataset.view], label: a.textContent.trim(), href: a.getAttribute('href'),
  })));

  // Shared with builder.js, which adds the Flows pages.
  window.DMA = {
    $, $$, esc, ic, api, toast, run, debounce, openModal, closeModal, modalHead, popover, closePop, views, main,
    ago, num, when, route: () => route(), gen: () => gen, guard: null, postForm, IG, POST_TYPES,
    setRefresh: (t) => { clearInterval(refreshTimer); refreshTimer = t; }, visible,
  };

  mount();
  start();
})();
