/* WhatsApp Automation dashboard: overview, inbox, auto-reply rules, template broadcasts, templates, activity and settings. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString();
  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const ago = (ms) => {
    if (!ms) return '';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
  };
  const main = $('#main');

  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 4000);
  }

  async function api(path, opts = {}) {
    const r = await fetch('/whatsapp/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) {
      location.assign('/?next=' + encodeURIComponent('/whatsapp/' + location.hash));
      throw new Error('Not signed in');
    }
    if (!r.ok) throw new Error(j.error || `Something went wrong (${r.status})`);
    return j;
  }
  const run = (fn) => (...a) => Promise.resolve().then(() => fn(...a)).catch((e) => toast(e.message, true));
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed: select and copy it by hand', true); }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) copy(b.dataset.copy);
  });

  function modal(html, onReady) {
    const back = document.createElement('div');
    back.className = 'wa modal-back';
    back.innerHTML = `<div class="panel modal" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    $$('[data-close]', back).forEach((b) => (b.onclick = close));
    onReady?.(back, close);
    ($('input, textarea, select', back) || $('button', back))?.focus();
    return close;
  }

  let status = null;
  function renderConn() {
    const c = $('#conn');
    if (!status) return;
    if (!status.configured) { c.className = 'pill warn'; c.textContent = 'Not connected'; }
    else if (!status.automation) { c.className = 'pill warn'; c.textContent = 'Automation paused'; }
    else { c.className = 'pill ok'; c.textContent = status.display?.phone ? `Active · ${status.display.phone}` : 'Active'; }
    const b = $('#badge');
    b.hidden = !status.awaiting;
    b.textContent = status.awaiting;
  }
  async function loadStatus() {
    status = await api('/status');
    renderConn();
    return status;
  }

  // ---------------- overview ----------------
  async function overview() {
    const s = await loadStatus();
    const setup = !s.configured
      ? `<div class="panel"><h2>Connect your WhatsApp number</h2>
          <p class="hint">Uses Meta's official WhatsApp Cloud API, so there's no risk of the number getting banned for automation.</p>
          <ol class="steps" style="margin-top:12px">
            <li>In your Meta app, add the <b>WhatsApp</b> product and a phone number.</li>
            <li>Create a <b>System User</b> in Business Settings with <b>whatsapp_business_messaging</b> and <b>whatsapp_business_management</b>, and generate a permanent token.</li>
            <li>Paste the phone number ID, WhatsApp Business Account ID and token in <b>Settings</b>.</li>
            <li>Set the webhook URL and verify token shown in Settings, and subscribe to <b>messages</b>.</li>
          </ol>
          <div class="acts" style="margin-top:14px"><a class="btn wa-btn" href="#settings">Open settings</a></div></div>`
      : '';
    const lastHook = s.lastWebhookAt ? `Last webhook ${ago(s.lastWebhookAt)}` : 'No webhook received yet';
    main.innerHTML = `<div class="stack">
      ${setup}
      <div class="kpis">
        <div class="kpi"><b>${num(s.received7d)}</b><span>Messages received (7 days)</span></div>
        <div class="kpi"><b>${num(s.autoSent7d)}</b><span>Auto-replies sent (7 days)</span></div>
        <div class="kpi"><b>${num(s.awaiting)}</b><span>Awaiting your reply</span></div>
        <div class="kpi"><b>${num(s.contacts)}</b><span>Contacts</span></div>
      </div>
      <div class="grid2">
        <div class="panel"><div class="panel-head"><h2>Status</h2></div><div class="list">
          <div class="row"><span class="dot ${s.configured ? 'wa' : 'warn'}">●</span><span class="txt"><b>${s.configured ? esc(s.display?.name || 'Connected') : 'Not connected'}</b><span>${esc(s.display?.phone || 'Add your number in Settings')}${s.display?.quality ? ` · quality ${esc(s.display.quality)}` : ''}</span></span></div>
          <div class="row"><span class="dot ${s.automation ? 'wa' : 'warn'}">●</span><span class="txt"><b>Automation ${s.automation ? 'on' : 'paused'}</b><span>${num(s.rulesOn)} auto-reply rule${s.rulesOn === 1 ? '' : 's'} active</span></span>
            <button class="btn small" type="button" id="toggle-auto">${s.automation ? 'Pause' : 'Resume'}</button></div>
          <div class="row"><span class="dot ${s.lastWebhookAt ? 'wa' : 'warn'}">●</span><span class="txt"><b>Webhook</b><span>${esc(lastHook)}</span></span></div>
          <div class="row"><span class="dot ${s.failed24h ? 'bad' : 'wa'}">●</span><span class="txt"><b>${num(s.failed24h)} failed in 24 hours</b><span>${num(s.pending)} waiting in the queue</span></span>${s.failed24h ? '<a class="btn small" href="#activity">View</a>' : ''}</div>
        </div></div>
        <div class="panel"><div class="panel-head"><h2>Quick actions</h2></div><div class="list">
          <a class="row" href="#rules"><span class="dot wa">↩</span><span class="txt"><b>Auto-replies</b><span>Welcome message, keyword replies with buttons</span></span></a>
          <a class="row" href="#broadcasts"><span class="dot wa">📣</span><span class="txt"><b>Broadcasts</b><span>${s.nextBroadcast ? `Next: ${esc(s.nextBroadcast.name)}, ${esc(when(s.nextBroadcast.scheduled_at))}` : 'Send an approved template to a list'}</span></span></a>
          <a class="row" href="#inbox"><span class="dot wa">💬</span><span class="txt"><b>Inbox</b><span>Reply by hand; the bot pauses for that chat</span></span></a>
          <a class="row" href="#settings"><span class="dot wa">⚡</span><span class="txt"><b>n8n</b><span>Send events to n8n, or send WhatsApp messages from n8n</span></span></a>
        </div></div>
      </div></div>`;
    $('#toggle-auto').onclick = run(async () => {
      await api('/settings', { method: 'PUT', body: { automation: !s.automation } });
      toast(s.automation ? 'Automation paused' : 'Automation resumed');
      overview();
    });
  }

  // ---------------- inbox ----------------
  let current = null;
  let threadTimer;
  async function inbox(waId) {
    clearInterval(threadTimer);
    if (waId) current = waId;
    main.innerHTML = `<div class="inbox">
      <div class="clist">
        <div class="acts"><input type="search" id="q" placeholder="Search name or number" aria-label="Search contacts" style="flex:1"><button class="btn small wa-btn" id="new-chat" type="button">New</button></div>
        <div class="items" id="items"><div class="skeleton"></div></div>
      </div>
      <div class="panel thread" id="thread"><div class="empty" style="margin:auto">Pick a conversation</div></div>
    </div>`;
    let qTimer;
    $('#q').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(run(loadContacts), 250); };
    $('#new-chat').onclick = () => newChat();
    await loadContacts();
    if (current) await openThread(current);
    threadTimer = setInterval(() => {
      if (document.visibilityState !== 'visible' || tab() !== 'inbox') return;
      run(loadContacts)();
      if (current) run(() => openThread(current, true))();
    }, 8000);
  }
  async function loadContacts() {
    const q = $('#q')?.value || '';
    const list = await api('/contacts' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    const box = $('#items');
    if (!box) return;
    box.innerHTML = list.length
      ? list.map((c) => `<button type="button" class="citem${c.wa_id === current ? ' on' : ''}" data-wa="${esc(c.wa_id)}">
          <span class="avatar">${esc((c.name || '#').trim()[0]?.toUpperCase() || '#')}</span>
          <span class="txt"><b>${esc(c.name || '+' + c.wa_id)}</b><span>${esc(c.last_text || '')}</span></span>
          <span class="muted small">${esc(ago(c.last_at))}</span>${c.awaiting ? '<span class="unread" title="Awaiting reply"></span>' : ''}</button>`).join('')
      : '<div class="empty">No conversations yet. When someone messages your WhatsApp number, they show up here.</div>';
    $$('.citem', box).forEach((b) => (b.onclick = run(() => { current = b.dataset.wa; history.replaceState(null, '', `#inbox/${current}`); $$('.citem').forEach((x) => x.classList.toggle('on', x === b)); return openThread(current); })));
  }
  function bubble(m) {
    const tick = m.direction === 'out' ? ({ sent: '✓', delivered: '✓✓', read: '✓✓ read', failed: '✕ failed' }[m.status] || '') : '';
    const src = m.direction === 'out' && m.source && m.source !== 'manual' ? ` · ${m.source}` : '';
    return `<div class="bubble ${m.direction === 'in' ? 'in' : 'out'}">${esc(m.text || `[${m.type}]`)}<small>${esc(ago(m.created_at))}${esc(src)}${tick ? ' · ' + esc(tick) : ''}</small>${m.error ? `<small class="err">${esc(m.error)}</small>` : ''}</div>`;
  }
  async function openThread(waId, refresh = false) {
    const box = $('#thread');
    if (!box) return;
    const d = await api(`/contacts/${encodeURIComponent(waId)}/messages`);
    const c = d.contact;
    const msgs = $('#msgs');
    const atBottom = !msgs || msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
    const draft = $('#reply')?.value || '';
    const queued = d.queued.map((q) => `<div class="bubble q">${esc(q.preview || q.kind)}<small>${esc(q.status === 'pending' || q.status === 'sending' ? 'sending…' : q.status)}</small>${q.error ? `<small class="err">${esc(q.error)}</small>` : ''}</div>`).join('');
    const html = `<div class="thread-head">
        <div><b>${esc(c.name || '+' + c.wa_id)}</b><div class="muted small">+${esc(c.wa_id)} · ${c.window_open ? '<span class="tag ok">24h window open</span>' : '<span class="tag warn">Window closed: template only</span>'}${c.opted_out ? '<span class="tag bad">Opted out</span>' : ''}</div></div>
        <div class="acts"><label class="inline small" title="Stop automatic replies for this chat"><span class="switch"><input type="checkbox" id="pause" ${c.paused ? 'checked' : ''}><span></span></span>Bot paused</label></div>
      </div>
      <div class="msgs" id="msgs">${d.messages.map(bubble).join('') || '<div class="empty">No messages yet</div>'}${queued}</div>
      <div class="composer">
        ${c.window_open
          ? `<div class="line"><textarea id="reply" placeholder="Type a reply…" maxlength="4096" aria-label="Reply"></textarea><button class="btn wa-btn" id="send" type="button">Send</button></div>
             <div class="acts"><button class="btn small ghost" id="send-tpl" type="button">Send a template instead</button><span class="hint">Replying by hand pauses the bot for this chat for a while (see Settings).</span></div>`
          : `<div class="acts"><span class="hint" style="flex:1">It's been more than 24 hours since they wrote, so WhatsApp only allows an approved template.</span><button class="btn wa-btn" id="send-tpl" type="button">Send template</button></div>`}
      </div>`;
    if (refresh && box.dataset.sig === JSON.stringify([d.messages.length, d.queued.map((q) => q.status), d.messages.map((m) => m.status), c.window_open, c.paused])) return;
    box.dataset.sig = JSON.stringify([d.messages.length, d.queued.map((q) => q.status), d.messages.map((m) => m.status), c.window_open, c.paused]);
    box.innerHTML = html;
    if ($('#reply')) $('#reply').value = draft;
    const m2 = $('#msgs');
    if (atBottom || !refresh) m2.scrollTop = m2.scrollHeight;
    $('#pause').onchange = run(async (e) => { await api(`/contacts/${encodeURIComponent(waId)}`, { method: 'PUT', body: { paused: e.target.checked } }); toast(e.target.checked ? 'Bot paused for this chat' : 'Bot back on for this chat'); });
    const send = run(async () => {
      const text = $('#reply').value.trim();
      if (!text) return;
      $('#send').disabled = true;
      try { await api(`/contacts/${encodeURIComponent(waId)}/send`, { method: 'POST', body: { text } }); $('#reply').value = ''; } finally { $('#send').disabled = false; }
      await openThread(waId);
      setTimeout(run(() => openThread(waId, true)), 2500);
    });
    if ($('#send')) {
      $('#send').onclick = send;
      $('#reply').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); };
    }
    $('#send-tpl').onclick = () => templateSender(waId);
  }
  async function templateSender(waId) {
    const { templates } = await api('/templates');
    const ok = templates.filter((t) => t.status === 'APPROVED' && (!t.header_type || t.header_type === 'TEXT'));
    if (!ok.length) return toast('No approved templates. Sync them on the Templates tab first.', true);
    modal(`<h2>Send a template</h2><form class="f" id="tf">
      ${waId ? '' : '<label>Phone number (with country code)<input type="text" name="to" required placeholder="919876543210"></label>'}
      <label>Template<select name="t">${ok.map((t, i) => `<option value="${i}">${esc(t.name)} (${esc(t.language)})</option>`).join('')}</select></label>
      <p class="hint" id="tbody"></p><div id="tparams" class="f"></div>
      <div class="acts"><button class="btn wa-btn" type="submit">Send</button><button class="btn ghost" type="button" data-close>Cancel</button></div></form>`, (root, close) => {
      const f = $('#tf', root);
      const draw = () => {
        const t = ok[Number(f.t.value)];
        $('#tbody', root).textContent = t.body;
        $('#tparams', root).innerHTML = Array.from({ length: t.params }, (_, i) => `<label>Variable {{${i + 1}}}<input type="text" name="p${i}" required maxlength="1000"></label>`).join('');
      };
      f.t.onchange = draw;
      draw();
      f.onsubmit = run(async (e) => {
        e.preventDefault();
        const t = ok[Number(f.t.value)];
        const params = Array.from({ length: t.params }, (_, i) => f[`p${i}`].value.trim());
        const to = waId || f.to.value.trim();
        const r = await api(`/contacts/${encodeURIComponent(to)}/send`, { method: 'POST', body: { template: t.name, language: t.language, params } });
        close();
        toast('Template queued');
        current = r.wa_id;
        if (tab() === 'inbox') { history.replaceState(null, '', `#inbox/${current}`); inbox(current); }
      });
    });
  }
  const newChat = run(() => templateSender(null));

  // ---------------- rules ----------------
  async function rules() {
    const list = await api('/rules');
    main.innerHTML = `<div class="stack">
      <div class="panel"><div class="panel-head"><div><h2>Auto-replies</h2><p class="hint">One reply per incoming message: the welcome rule for someone's very first message, otherwise the highest-priority matching keyword rule. "STOP" and "START" are handled for you (opt-out).</p></div>
        <button class="btn wa-btn" id="add" type="button">Add rule</button></div>
      <div class="list" id="rlist">${list.length ? list.map((r) => `<div class="row rule">
          <label class="switch" title="On / off"><input type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''} aria-label="Enable ${esc(r.name)}"><span></span></label>
          <div class="body"><b>${esc(r.name)}</b>
            <div style="margin-top:4px">${r.trigger_type === 'welcome' ? '<span class="tag ok">Welcome (first message)</span>' : r.match_mode === 'any' ? '<span class="tag">Any message</span>' : r.keywords.map((k) => `<span class="tag">${esc(r.match_mode === 'exact' ? `= ${k}` : k)}</span>`).join('')}
              ${r.buttons.map((b) => `<span class="tag ok">▢ ${esc(b)}</span>`).join('')}${r.priority ? `<span class="tag">priority ${r.priority}</span>` : ''}${r.cooldown_minutes ? `<span class="tag">cooldown ${r.cooldown_minutes}m</span>` : ''}</div>
            <p>${esc(r.reply_text)}</p></div>
          <div class="acts"><span class="muted small">${num(r.hits)} sent</span><button class="btn small" data-edit="${r.id}" type="button">Edit</button><button class="btn small danger" data-del="${r.id}" type="button">Delete</button></div>
        </div>`).join('') : '<div class="empty">No rules yet. Start with a welcome message and a few keyword replies (e.g. "price", "hours", "location").</div>'}</div></div></div>`;
    $('#add').onclick = () => ruleForm();
    $$('[data-toggle]').forEach((el) => (el.onchange = run(async () => { await api(`/rules/${el.dataset.toggle}`, { method: 'PUT', body: { enabled: el.checked } }); toast(el.checked ? 'Rule on' : 'Rule off'); })));
    $$('[data-edit]').forEach((el) => (el.onclick = () => ruleForm(list.find((r) => r.id === Number(el.dataset.edit)))));
    $$('[data-del]').forEach((el) => (el.onclick = run(async () => {
      if (!confirm('Delete this rule?')) return;
      await api(`/rules/${el.dataset.del}`, { method: 'DELETE' });
      rules();
    })));
  }
  function ruleForm(r) {
    const v = r || { name: '', trigger_type: 'message', match_mode: 'contains', keywords: [], reply_text: '', buttons: [], cooldown_minutes: 0, priority: 0, enabled: 1 };
    modal(`<h2>${r ? 'Edit rule' : 'New auto-reply'}</h2><form class="f" id="rf">
      <label>Name<input type="text" name="name" required maxlength="80" value="${esc(v.name)}" placeholder="Price enquiry"></label>
      <div class="two"><label>When<select name="trigger_type"><option value="message">A message matches</option><option value="welcome">Someone writes for the first time</option></select></label>
        <label id="mode-l">Match<select name="match_mode"><option value="contains">Contains a keyword</option><option value="exact">Is exactly a keyword</option><option value="any">Any message (fallback)</option></select></label></div>
      <label id="kw-l"><span>Keywords <span class="muted small">(comma separated)</span></span><input type="text" name="keywords" value="${esc(v.keywords.join(', '))}" placeholder="price, cost, rate"></label>
      <label>Reply<textarea name="reply_text" required maxlength="4096" placeholder="Hi {{first_name}}! Our plans start at ₹999/month.">${esc(v.reply_text)}</textarea>
        <span class="hint">Use {{first_name}}, {{name}} or {{phone}}. *bold*, _italic_ work as in WhatsApp.</span></label>
      <label><span>Quick-reply buttons <span class="muted small">(optional, up to 3, max 20 characters each)</span></span>
        <div class="three">${[0, 1, 2].map((i) => `<input type="text" name="b${i}" maxlength="20" value="${esc(v.buttons[i] || '')}" placeholder="Button ${i + 1}">`).join('')}</div>
        <span class="hint">Tapping a button sends its title back as a message, so you can add a rule for each button title.</span></label>
      <div class="two"><label>Cooldown per person (minutes)<input type="number" name="cooldown_minutes" min="0" max="10080" value="${Number(v.cooldown_minutes)}"></label>
        <label>Priority<input type="number" name="priority" min="-100" max="100" value="${Number(v.priority)}"></label></div>
      <div class="acts"><button class="btn wa-btn" type="submit">Save</button><button class="btn ghost" type="button" data-close>Cancel</button></div></form>`, (root, close) => {
      const f = $('#rf', root);
      f.trigger_type.value = v.trigger_type;
      f.match_mode.value = v.match_mode;
      const sync = () => {
        const welcome = f.trigger_type.value === 'welcome';
        $('#mode-l', root).hidden = welcome;
        $('#kw-l', root).hidden = welcome || f.match_mode.value === 'any';
      };
      f.trigger_type.onchange = sync;
      f.match_mode.onchange = sync;
      sync();
      f.onsubmit = run(async (e) => {
        e.preventDefault();
        const body = {
          name: f.name.value, trigger_type: f.trigger_type.value, match_mode: f.match_mode.value,
          keywords: f.keywords.value.split(',').map((s) => s.trim()).filter(Boolean), reply_text: f.reply_text.value,
          buttons: [f.b0.value, f.b1.value, f.b2.value].map((s) => s.trim()).filter(Boolean),
          cooldown_minutes: Number(f.cooldown_minutes.value), priority: Number(f.priority.value), enabled: r ? !!r.enabled : true,
        };
        await api(r ? `/rules/${r.id}` : '/rules', { method: r ? 'PUT' : 'POST', body });
        close();
        toast('Saved');
        rules();
      });
    });
  }

  // ---------------- broadcasts ----------------
  async function broadcasts() {
    const [list, { templates }] = await Promise.all([api('/broadcasts'), api('/templates')]);
    const ok = templates.filter((t) => t.status === 'APPROVED' && (!t.header_type || t.header_type === 'TEXT'));
    const statusTag = (s) => `<span class="tag ${{ done: 'ok', running: 'warn', scheduled: '', cancelled: 'bad' }[s] ?? ''}">${esc(s)}</span>`;
    main.innerHTML = `<div class="stack">
      <div class="panel"><div class="panel-head"><div><h2>New broadcast</h2><p class="hint">Sends an approved template to a list. People who replied STOP are skipped automatically.</p></div></div>
      ${ok.length ? `<form class="f" id="bf">
        <div class="two"><label>Name<input type="text" name="name" maxlength="80" placeholder="Diwali offer" required></label>
          <label>Template<select name="t">${ok.map((t, i) => `<option value="${i}">${esc(t.name)} (${esc(t.language)})</option>`).join('')}</select></label></div>
        <p class="hint" id="bbody"></p>
        <label><span>Recipients <span class="muted small" id="fmt"></span></span><textarea name="recipients" rows="6" placeholder="919876543210"></textarea>
          <span class="hint" id="bcheck">One per line. Numbers need a country code${'' /* default cc */}.</span></label>
        <div class="two"><label>When<select name="when"><option value="now">Send now</option><option value="later">Schedule</option></select></label>
          <label id="at-l" hidden>Date and time<input type="datetime-local" name="at"></label></div>
        <div class="acts"><button class="btn wa-btn" type="submit">Create broadcast</button></div></form>`
        : '<div class="empty">No approved templates yet. Create one in WhatsApp Manager, wait for approval, then sync on the Templates tab.</div>'}</div>
      <div class="panel"><div class="panel-head"><h2>Broadcasts</h2><button class="btn small" id="refresh" type="button">Refresh</button></div>
        ${list.length ? `<div class="tbl"><table><thead><tr><th>Name</th><th>Status</th><th>When</th><th>Total</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Failed</th><th>Skipped</th><th></th></tr></thead><tbody>
          ${list.map((b) => `<tr><td><b>${esc(b.name)}</b><div class="muted small">${esc(b.template)}</div></td><td>${statusTag(b.status)}</td><td class="small">${esc(when(b.scheduled_at))}</td>
            <td>${num(b.total)}</td><td>${num(b.sent)}</td><td>${num(b.delivered)}</td><td>${num(b.read)}</td><td>${num(b.failed)}</td><td>${num(b.skipped)}</td>
            <td>${b.status === 'scheduled' || b.status === 'running' ? `<button class="btn small danger" data-cancel="${b.id}" type="button">Cancel</button>` : `<button class="btn small ghost" data-bdel="${b.id}" type="button">Remove</button>`}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No broadcasts yet</div>'}</div></div>`;
    $('#refresh').onclick = run(broadcasts);
    $$('[data-cancel]').forEach((b) => (b.onclick = run(async () => { if (!confirm('Cancel this broadcast? Messages already sent stay sent.')) return; await api(`/broadcasts/${b.dataset.cancel}/cancel`, { method: 'POST' }); broadcasts(); })));
    $$('[data-bdel]').forEach((b) => (b.onclick = run(async () => { await api(`/broadcasts/${b.dataset.bdel}`, { method: 'DELETE' }); broadcasts(); })));
    const f = $('#bf');
    if (!f) return;
    const tpl = () => ok[Number(f.t.value)];
    const draw = () => {
      const t = tpl();
      $('#bbody').textContent = t.body;
      $('#fmt').textContent = t.params ? `(number, ${Array.from({ length: t.params }, (_, i) => `{{${i + 1}}}`).join(', ')})` : '(one number per line)';
      f.recipients.placeholder = t.params ? `919876543210, ${Array.from({ length: t.params }, (_, i) => `value${i + 1}`).join(', ')}` : '919876543210';
    };
    let checkTimer;
    const check = () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(run(async () => {
        if (!f.recipients.value.trim()) return ($('#bcheck').textContent = 'One per line. Numbers need a country code.');
        const t = tpl();
        const r = await api('/broadcasts/preview', { method: 'POST', body: { template: t.name, language: t.language, recipients: f.recipients.value } });
        $('#bcheck').textContent = `${num(r.valid)} valid recipient${r.valid === 1 ? '' : 's'}` + (r.invalidCount ? ` · ${num(r.invalidCount)} line${r.invalidCount === 1 ? '' : 's'} skipped (e.g. "${r.invalid[0]}")` : '');
      }), 400);
    };
    f.t.onchange = () => { draw(); check(); };
    f.recipients.oninput = check;
    f.when.onchange = () => ($('#at-l').hidden = f.when.value !== 'later');
    draw();
    f.onsubmit = run(async (e) => {
      e.preventDefault();
      const t = tpl();
      if (f.when.value === 'later' && !f.at.value) throw new Error('Pick a date and time');
      const body = { name: f.name.value, template: t.name, language: t.language, recipients: f.recipients.value, scheduled_at: f.when.value === 'later' ? new Date(f.at.value).toISOString() : null };
      const r = await api('/broadcasts', { method: 'POST', body });
      toast(`Broadcast created for ${num(r.total)} recipient${r.total === 1 ? '' : 's'}${r.invalid ? ` (${r.invalid} skipped)` : ''}`);
      broadcasts();
    });
  }

  // ---------------- templates ----------------
  async function templates() {
    const { templates: list, syncedAt } = await api('/templates');
    const tag = (s) => `<span class="tag ${s === 'APPROVED' ? 'ok' : s === 'REJECTED' || s === 'DISABLED' ? 'bad' : 'warn'}">${esc(s.toLowerCase())}</span>`;
    main.innerHTML = `<div class="panel"><div class="panel-head"><div><h2>Message templates</h2><p class="hint">Create and edit templates in WhatsApp Manager; Meta reviews them. Templates are the only way to start a chat or write after 24 hours. ${syncedAt ? `Last synced ${esc(ago(syncedAt))}.` : ''}</p></div>
      <div class="acts"><button class="btn" id="tsend" type="button">Send to a number</button><button class="btn wa-btn" id="sync" type="button">Sync from WhatsApp</button></div></div>
      ${list.length ? `<div class="tbl"><table><thead><tr><th>Name</th><th>Status</th><th>Category</th><th>Body</th><th>Variables</th></tr></thead><tbody>
        ${list.map((t) => `<tr><td><b>${esc(t.name)}</b><div class="muted small">${esc(t.language)}${t.header_type ? ` · ${esc(t.header_type.toLowerCase())} header` : ''}</div></td><td>${tag(t.status)}</td><td class="small">${esc((t.category || '').toLowerCase())}</td><td class="small" style="white-space:pre-wrap;max-width:420px">${esc(t.body)}</td><td>${t.params}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No templates synced yet.</div>'}</div>`;
    $('#sync').onclick = run(async () => {
      $('#sync').disabled = true;
      try { const r = await api('/templates/sync', { method: 'POST' }); toast(`Synced ${r.count} template${r.count === 1 ? '' : 's'}`); } finally { $('#sync').disabled = false; }
      templates();
    });
    $('#tsend').onclick = newChat;
  }

  // ---------------- activity ----------------
  async function activity() {
    const d = await api('/activity');
    main.innerHTML = `<div class="grid2">
      <div class="panel"><div class="panel-head"><h2>Failed messages</h2></div><div class="list">
        ${d.failed.length ? d.failed.map((f) => `<div class="row"><span class="dot bad">!</span><span class="txt"><b>+${esc(f.wa_id)} · ${esc(f.source)}</b><span title="${esc(f.error)}">${esc(f.error || '')}</span><span>${esc(f.preview || '')}</span></span><span class="acts"><span class="when">${esc(ago(f.created_at))}</span><button class="btn small" data-retry="${f.id}" type="button">Retry</button></span></div>`).join('') : '<div class="empty ok">Nothing failed</div>'}
      </div></div>
      <div class="panel"><div class="panel-head"><h2>Log</h2></div><div class="list">
        ${d.logs.length ? d.logs.map((l) => `<div class="row"><span class="dot ${l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : 'wa'}">•</span><span class="txt"><b style="white-space:normal">${esc(l.message.replace(/^WhatsApp:\s*/, ''))}</b></span><span class="when">${esc(ago(l.created_at))}</span></div>`).join('') : '<div class="empty">No events yet</div>'}
      </div></div></div>`;
    $$('[data-retry]').forEach((b) => (b.onclick = run(async () => { await api(`/outbox/${b.dataset.retry}/retry`, { method: 'POST' }); toast('Queued again'); activity(); })));
  }

  // ---------------- settings ----------------
  async function settings() {
    const s = await api('/settings');
    const copyRow = (v) => `<div class="copyrow"><span class="copy">${esc(v)}</span><button class="btn small" type="button" data-copy="${esc(v)}">Copy</button></div>`;
    main.innerHTML = `<div class="grid2">
      <div class="stack">
        <form class="panel f" id="conn-f"><h2>WhatsApp Cloud API</h2>
          ${s.display.phone ? `<div class="row"><span class="dot wa">✓</span><span class="txt"><b>${esc(s.display.name || '')} · ${esc(s.display.phone)}</b><span>Quality ${esc(s.display.quality || '—')}${s.display.tier ? ` · limit ${esc(s.display.tier)}` : ''}</span></span></div>` : ''}
          <div class="two"><label>Phone number ID<input type="text" name="phoneId" value="${esc(s.phoneId)}" inputmode="numeric" placeholder="1234567890123456"></label>
            <label>WhatsApp Business Account ID<input type="text" name="wabaId" value="${esc(s.wabaId)}" inputmode="numeric" placeholder="1029384756123456"></label></div>
          <p class="hint" style="margin-top:-6px">Both are on your Meta app's WhatsApp &gt; API Setup page.</p>
          <label><span>Permanent access token ${s.tokenSet ? '<span class="tag ok">saved</span>' : ''}</span><input type="password" name="token" autocomplete="off" placeholder="${s.tokenSet ? 'Leave empty to keep the saved token' : 'EAAG… (System User token)'}"></label>
          <label><span>App secret ${s.appSecretSet ? '<span class="tag ok">saved</span>' : s.appSecretFromEnv ? '<span class="tag">using META_APP_SECRET</span>' : '<span class="tag bad">missing</span>'}</span><input type="password" name="appSecret" autocomplete="off" placeholder="Only if WhatsApp is in a different Meta app than Instagram"></label>
          <div class="acts"><button class="btn wa-btn" type="submit">Save</button><button class="btn" type="button" id="test">Test connection</button><button class="btn" type="button" id="sub" title="Makes WhatsApp send this account's webhooks to your Meta app">Subscribe app to WABA</button></div>
        </form>
        <div class="panel f"><h2>Webhook</h2>
          <p class="hint" style="margin:0">In your Meta app: WhatsApp &gt; Configuration &gt; Webhook. Paste these, click Verify and save, then subscribe to the <b>messages</b> field.</p>
          <label>Callback URL${copyRow(s.webhookUrl)}</label>
          <label>Verify token${copyRow(s.verifyToken)}</label>
        </div>
      </div>
      <div class="stack">
        <form class="panel f" id="auto-f"><h2>Automation</h2>
          <label class="inline"><span class="switch"><input type="checkbox" name="automation" ${s.automation ? 'checked' : ''}><span></span></span>Automatic replies on</label>
          <label class="inline"><span class="switch"><input type="checkbox" name="markRead" ${s.markRead ? 'checked' : ''}><span></span></span>Mark incoming messages as read (blue ticks)</label>
          <div class="two"><label>Pause bot after a manual reply (minutes)<input type="number" name="humanPauseMin" min="0" max="10080" value="${s.humanPauseMin}"></label>
            <label>Auto-replies per contact per hour<input type="number" name="contactHourlyLimit" min="1" max="100" value="${s.contactHourlyLimit}"></label></div>
          <div class="two"><label>Messages per hour (all)<input type="number" name="hourlyLimit" min="1" max="100000" value="${s.hourlyLimit}"></label>
            <label>Default country code<input type="text" name="defaultCc" maxlength="4" value="${esc(s.defaultCc)}" placeholder="91"><span class="hint">Added to 10-digit numbers in broadcasts.</span></label></div>
          <label><span>Reply when someone sends STOP <span class="muted small">(empty = no reply)</span></span><textarea name="stopReply" rows="2" maxlength="1000">${esc(s.stopReply)}</textarea></label>
          <div class="acts"><button class="btn wa-btn" type="submit">Save</button></div>
        </form>
        <form class="panel f" id="n8n-f"><h2>n8n</h2>
          <p class="hint" style="margin:0"><b>Events to n8n:</b> every incoming message, sent / failed reply and opt-out is POSTed (signed) to this URL. Use the Production URL of an n8n Webhook node.</p>
          <label>n8n webhook URL<input type="url" name="hookUrl" value="${esc(s.hookUrl)}" placeholder="https://n8n.example.com/webhook/whatsapp"></label>
          ${s.hookSecret ? `<label><span>Signing secret <span class="muted small">(header X-Autopilot-Signature = sha256 HMAC of the body)</span></span>${copyRow(s.hookSecret)}</label>` : ''}
          ${s.hookLast ? `<p class="hint">Last delivery: ${esc(s.hookLast.event)} · ${s.hookLast.ok ? 'OK' : esc(s.hookLast.error || 'failed')} · ${esc(ago(s.hookLast.at))}</p>` : ''}
          <div class="acts"><button class="btn wa-btn" type="submit">Save</button><button class="btn" type="button" id="hook-test" ${s.hookUrl ? '' : 'disabled'}>Send test event</button>${s.hookSecret ? '<button class="btn ghost" type="button" id="hook-rot">New secret</button>' : ''}</div>
          <hr class="sep">
          <p class="hint" style="margin:0"><b>Send from n8n:</b> an HTTP Request node, POST to the URL below with header <code>Authorization: Bearer &lt;API key&gt;</code> and JSON <code>{"to":"919876543210","text":"Hi"}</code> or <code>{"to":"…","template":"order_update","language":"en_US","params":["Asha","#1042"]}</code>.</p>
          <label>Send URL${copyRow(s.sendUrl)}</label>
          <div class="acts"><button class="btn" type="button" id="key">${s.apiKeySet ? 'Create a new API key' : 'Create API key'}</button>${s.apiKeySet ? '<span class="tag ok">key active</span>' : ''}</div>
          <div id="keybox"></div>
        </form>
      </div></div>`;

    const save = async (body) => { await api('/settings', { method: 'PUT', body }); toast('Saved'); };
    $('#conn-f').onsubmit = run(async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { phoneId: f.phoneId.value.trim(), wabaId: f.wabaId.value.trim() };
      if (f.token.value.trim()) body.token = f.token.value.trim();
      if (f.appSecret.value.trim()) body.appSecret = f.appSecret.value.trim();
      await save(body);
      if (body.token && body.phoneId) await api('/settings/test', { method: 'POST' }).then(() => toast('Connected')).catch((er) => toast(er.message, true));
      settings();
      loadStatus();
    });
    $('#test').onclick = run(async () => { const r = await api('/settings/test', { method: 'POST' }); toast(`Connected: ${r.info.display_phone_number || ''} ${r.info.verified_name || ''}`); settings(); loadStatus(); });
    $('#sub').onclick = run(async () => { await api('/settings/subscribe', { method: 'POST' }); toast('App subscribed to the WhatsApp Business Account'); });
    $('#auto-f').onsubmit = run(async (e) => {
      e.preventDefault();
      const f = e.target;
      await save({ automation: f.automation.checked, markRead: f.markRead.checked, humanPauseMin: Number(f.humanPauseMin.value), contactHourlyLimit: Number(f.contactHourlyLimit.value), hourlyLimit: Number(f.hourlyLimit.value), defaultCc: f.defaultCc.value.trim(), stopReply: f.stopReply.value });
      loadStatus();
    });
    $('#n8n-f').onsubmit = run(async (e) => { e.preventDefault(); await save({ hookUrl: e.target.hookUrl.value.trim() }); settings(); });
    $('#hook-test').onclick = run(async () => { const r = await api('/settings/hook-test', { method: 'POST' }); toast(r.ok ? 'n8n got the test event' : `n8n did not accept it: ${r.error}`, !r.ok); });
    if ($('#hook-rot')) $('#hook-rot').onclick = run(async () => { if (!confirm('Make a new signing secret? Update it in n8n afterwards.')) return; await api('/settings/hook-secret', { method: 'POST' }); settings(); });
    $('#key').onclick = run(async () => {
      if (s.apiKeySet && !confirm('Create a new key? The old one stops working right away.')) return;
      const r = await api('/settings/api-key', { method: 'POST' });
      $('#keybox').innerHTML = `<label><span>Your API key <span class="muted small">(shown once, store it in n8n credentials)</span></span><div class="copyrow"><span class="copy">${esc(r.key)}</span><button class="btn small" type="button" data-copy="${esc(r.key)}">Copy</button></div></label>`;
    });
  }

  // ---------------- router ----------------
  const views = { overview, inbox, rules, broadcasts, templates, activity, settings };
  const tab = () => (location.hash.slice(1).split('/')[0] || 'overview');
  async function route() {
    clearInterval(threadTimer);
    const t = views[tab()] ? tab() : 'overview';
    $$('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === t));
    try {
      if (t === 'inbox') await inbox(decodeURIComponent(location.hash.split('/')[1] || '') || null);
      else await views[t]();
    } catch (e) {
      main.innerHTML = `<div class="panel empty">${esc(e.message)}</div>`;
    }
  }
  addEventListener('hashchange', route);
  setInterval(() => { if (document.visibilityState === 'visible') loadStatus().catch(() => {}); }, 30000);
  loadStatus().then(route).catch((e) => { main.innerHTML = `<div class="panel empty">${esc(e.message)}</div>`; });
})();
