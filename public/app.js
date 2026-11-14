/* DM Autopilot dashboard — dependency-free single-page app. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const main = $('#main');

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
  const lines = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);

  async function api(path, opts = {}) {
    const init = { method: opts.method ?? 'GET', headers: {} };
    if (opts.form) init.body = opts.form;
    else if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch('/api' + path, init);
    if (res.status === 401 && path !== '/login') {
      showLogin();
      throw new Error('Please sign in again');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
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
  const run = (fn, okMsg) => async (...args) => {
    try {
      await fn(...args);
      if (okMsg) toast(okMsg);
    } catch (e) {
      toast(e.message, true);
    }
  };

  function openModal(html) {
    $('#modal-box').innerHTML = html;
    $('#modal').hidden = false;
    return $('#modal-box');
  }
  function closeModal() {
    $('#modal').hidden = true;
    $('#modal-box').innerHTML = '';
  }
  $('#modal').addEventListener('mousedown', (e) => e.target.id === 'modal' && closeModal());

  // ---------- session ----------

  function showLogin() {
    $('#app').hidden = true;
    $('#login').hidden = false;
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
  $('#logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' });
    showLogin();
  });

  // ---------- routing ----------

  const views = {};
  let refreshTimer;
  function route() {
    const name = (location.hash || '#overview').slice(1).split('/')[0];
    const view = views[name] ? name : 'overview';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    clearInterval(refreshTimer);
    run(views[view])();
  }
  window.addEventListener('hashchange', route);

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

  // ---------- overview ----------

  views.overview = async () => {
    const s = await api('/status');
    const a = s.account;
    $('#side-account').textContent = a ? '@' + a.username : 'Not connected';
    const c = s.config;
    const daysLeft = a && a.tokenExpiresAt ? Math.floor((a.tokenExpiresAt - Date.now()) / 86400000) : null;
    const tokenNote = daysLeft === null ? 'access token does not expire' : daysLeft < 0 ? 'access token has EXPIRED — reconnect' : `access token valid for ${daysLeft} more days — reconnect before then`;
    const metaReady = c.appId && c.appSecret && c.configId;
    const item = (state, html) => `<li><span class="dot ${state}">${state === 'ok' ? '✓' : state === 'bad' ? '!' : ''}</span><div>${html}</div></li>`;
    const webhookSeen = s.health.lastWebhookAt > 0;

    main.innerHTML = `
      <div class="head">
        <div><h1>Overview</h1><p class="muted">${a ? `Connected as <b>@${esc(a.username)}</b> · ${a.followers.toLocaleString()} followers` : 'Connect your Instagram professional account to begin.'}</p></div>
        <div class="row">
          <span class="pill ${s.automationEnabled ? 'ok' : 'warn'}">${s.automationEnabled ? 'Automation on' : 'Automation paused'}</span>
          <button class="btn" id="toggle-auto">${s.automationEnabled ? 'Pause all' : 'Resume'}</button>
        </div>
      </div>
      <div class="stack">
        <div class="grid">
          <div class="stat"><b>${s.stats.inbound24h}</b><span>Received · 24h</span></div>
          <div class="stat"><b>${s.stats.sent24h}</b><span>Replies sent · 24h</span></div>
          <div class="stat"><b>${s.stats.pending}</b><span>Queued</span></div>
          <div class="stat"><b>${s.stats.failed24h}</b><span>Failed · 24h</span></div>
          <div class="stat"><b>${s.stats.contacts}</b><span>Contacts</span></div>
          <div class="stat"><b>${s.stats.scheduledPosts}</b><span>Scheduled posts</span></div>
        </div>
        <div class="card">
          <h2>Setup checklist</h2>
          <ul class="checklist">
            ${item(c.https ? 'ok' : 'bad', `Public HTTPS address: <code>${esc(c.baseUrl)}</code>${c.https ? '' : ' — Meta requires https. Set <code>BASE_URL</code>.'}`)}
            ${item(metaReady ? 'ok' : 'bad', metaReady ? 'Meta app ID, app secret and login configuration ID are set' : 'Set <code>META_APP_ID</code>, <code>META_APP_SECRET</code> and <code>META_CONFIG_ID</code> in <code>.env</code>, then restart')}
            ${item('', `Login configuration permissions: ${c.permissions.map((p) => `<code>${esc(p)}</code>`).join(' ')}`)}
            ${item(c.verifyToken ? 'ok' : 'bad', `Webhook callback URL <code>${esc(c.webhookUrl)}</code>${c.verifyToken ? ' with the verify token from <code>.env</code>' : ' — set <code>WEBHOOK_VERIFY_TOKEN</code>'}`)}
            ${item('', `Redirect URL for the login configuration: <code>${esc(c.redirectUri)}</code>`)}
            ${item('', `Privacy policy URL for the Meta dashboard: <code>${esc(c.privacyUrl)}</code>`)}
            ${item(!a ? 'bad' : daysLeft !== null && daysLeft <= 7 ? 'warn' : 'ok', a ? `Account connected · ${tokenNote}` : 'Instagram account not connected yet')}
            ${item(a?.webhooksSubscribed ? 'ok' : 'warn', a?.webhooksSubscribed ? `Subscribed to webhooks: ${esc(a.webhooksSubscribed)}` : 'Account not subscribed to webhooks yet')}
            ${item(webhookSeen ? 'ok' : 'warn', webhookSeen ? `Last webhook received ${ago(s.health.lastWebhookAt)}` : 'No webhook received yet — send your account a DM from another account to test (the Meta app must be in Live mode)')}
            ${item(s.health.lastPollError ? 'bad' : s.health.lastPollAt ? 'ok' : '', s.health.lastPollError ? `Comment polling error: ${esc(s.health.lastPollError)}` : `Comment check last ran ${ago(s.health.lastPollAt)}${s.health.lastCommentWebhookAt ? ' · comment webhooks are also arriving' : ''}`)}
          </ul>
        </div>
        <div class="card">
          <h2>Instagram account</h2>
          ${a ? `
            <div class="row spread">
              <div class="row">${a.picture ? `<img src="${esc(a.picture)}" alt="" width="44" height="44" style="border-radius:50%">` : ''}<div><b>${esc(a.name || a.username)}</b><div class="muted small">@${esc(a.username)}</div></div></div>
              <div class="row">
                ${a.accounts.length > 1 ? `<select id="pick-account" style="width:auto" aria-label="Active Instagram account">${a.accounts.map((x) => `<option value="${esc(x.id)}" ${x.id === a.id ? 'selected' : ''}>@${esc(x.username)}</option>`).join('')}</select>` : ''}
                <button class="btn" id="resub">Re-subscribe webhooks</button>
                <a class="btn" href="/auth/instagram">Reconnect</a>
                <button class="btn danger" id="disconnect">Disconnect</button>
              </div>
            </div>` : `
            <p>Sign in with Instagram or Facebook, choose your business portfolio and tick your Instagram account. Alternatively, paste a token generated under <i>API setup with Unified login → Generate access tokens</i> in the Meta App Dashboard.</p>
            <div class="row" style="margin-bottom:14px"><a class="btn primary" href="/auth/instagram">Connect Instagram account</a></div>
            <form id="token-form" class="row"><input name="token" placeholder="…or paste an access token" style="flex:1;min-width:220px" autocomplete="off"><button class="btn">Save token</button></form>`}
        </div>
      </div>`;

    $('#toggle-auto').onclick = run(async () => {
      await api('/settings', { method: 'PUT', body: { automation_enabled: s.automationEnabled ? 0 : 1 } });
      views.overview();
    });
    if (a) {
      $('#resub').onclick = run(() => api('/account/subscribe', { method: 'POST' }), 'Subscribed');
      if ($('#pick-account')) $('#pick-account').onchange = run(async (e) => {
        await api('/account/select', { method: 'POST', body: { id: e.target.value } });
        views.overview();
      }, 'Switched account');
      $('#disconnect').onclick = run(async () => {
        if (!confirm('Disconnect this Instagram account? Automations stop until you reconnect.')) return;
        await api('/account/disconnect', { method: 'POST' });
        views.overview();
      });
    } else {
      $('#token-form').onsubmit = run(async (e) => {
        e.preventDefault();
        await api('/account/token', { method: 'POST', body: { token: e.target.token.value } });
        toast('Instagram account connected');
        views.overview();
      });
    }
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
    const [rules, media] = await Promise.all([api('/rules'), api('/media')]);
    main.innerHTML = `
      <div class="head">
        <div><h1>Automations</h1><p class="muted">Each rule watches for a trigger and sends a reply. The first matching rule wins.</p></div>
        <button class="btn primary" id="new-rule">New automation</button>
      </div>
      <div class="card">${rules.length ? rules.map((r) => `
        <div class="rule">
          <div class="row spread">
            <div class="row"><b>${esc(r.name)}</b><span class="pill ${r.enabled ? 'ok' : ''}">${r.enabled ? 'On' : 'Off'}</span><span class="pill">${r.hits} triggered</span></div>
            <div class="row">
              <button class="btn small" data-toggle="${r.id}">${r.enabled ? 'Turn off' : 'Turn on'}</button>
              <button class="btn small" data-edit="${r.id}">Edit</button>
              <button class="btn small danger" data-del="${r.id}">Delete</button>
            </div>
          </div>
          <div class="small">${triggerSummary(r, media)}</div>
          ${r.reply_text ? `<div class="reply">↳ DM: ${esc(r.reply_text)}</div>` : ''}
          ${r.buttons.length ? `<div class="row">${r.buttons.map((b) => `<span class="pill accent">${esc(b.title)}</span>`).join('')}</div>` : ''}
          ${r.quick_replies.length ? `<div class="row">${r.quick_replies.map((q) => `<span class="pill">${esc(q)}</span>`).join('')}</div>` : ''}
          ${r.comment_replies.length ? `<div class="reply">↳ Public reply: ${esc(r.comment_replies[0])}${r.comment_replies.length > 1 ? ` (+${r.comment_replies.length - 1} variants)` : ''}</div>` : ''}
        </div>`).join('') : '<div class="empty">No automations yet. Create one to start replying automatically.</div>'}
      </div>`;

    $('#new-rule').onclick = () => ruleForm(null, media);
    main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => ruleForm(rules.find((r) => r.id == b.dataset.edit), media)));
    main.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = run(async () => {
      await api(`/rules/${b.dataset.toggle}/toggle`, { method: 'POST' });
      views.rules();
    })));
    main.querySelectorAll('[data-del]').forEach((b) => (b.onclick = run(async () => {
      if (!confirm('Delete this automation?')) return;
      await api(`/rules/${b.dataset.del}`, { method: 'DELETE' });
      views.rules();
    })));
  };

  function ruleForm(rule, media) {
    const r = rule ?? { name: '', trigger_type: 'dm', match_mode: 'contains', keywords: [], reply_text: '', buttons: [], quick_replies: [], comment_replies: [], cooldown_minutes: 0, priority: 0, enabled: 1, media_id: null };
    const btn = (i) => r.buttons[i] ?? { title: '', url: '' };
    const box = openModal(`
      <h2>${rule ? 'Edit automation' : 'New automation'}</h2>
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
        <label class="check"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}> Turned on</label>
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
      views.rules();
    });
  }

  // ---------- inbox ----------

  let openContact = null;
  views.inbox = async () => {
    main.innerHTML = `
      <div class="head"><div><h1>Inbox</h1><p class="muted">Conversations and comments handled by your automations.</p></div></div>
      <div class="card inbox">
        <div class="threads"><input id="search" placeholder="Search people…"><div id="threads"></div></div>
        <div class="chat" id="chat"><div class="empty">Select a conversation.</div></div>
      </div>`;
    const loadThreads = async () => {
      const list = await api('/contacts?q=' + encodeURIComponent($('#search').value));
      $('#threads').innerHTML = list.length ? list.map((c) => `
        <div class="thread ${c.igsid === openContact ? 'active' : ''}" data-id="${esc(c.igsid)}">
          <b>${esc(c.username ? '@' + c.username : c.name || c.igsid)}</b>
          <span>${esc(c.last_text || '')}</span>
          <span>${ago(c.last_at)}</span>
        </div>`).join('') : '<div class="empty">No conversations yet.</div>';
      $('#threads').querySelectorAll('.thread').forEach((el) => (el.onclick = () => {
        openContact = el.dataset.id;
        loadThreads();
        loadChat();
      }));
    };
    const loadChat = run(async (keepDraft) => {
      if (!openContact) return;
      const draft = keepDraft ? $('#chat textarea')?.value ?? '' : '';
      const d = await api(`/contacts/${encodeURIComponent(openContact)}/messages`);
      const c = d.contact;
      const paused = c.paused_until > Date.now();
      const KIND = { comment: 'comment', private_reply: 'DM reply to comment', comment_reply: 'public reply', story_reply: 'story reply', story_mention: 'story mention' };
      $('#chat').innerHTML = `
        <div class="chat-head row spread">
          <div><b>${esc(c.username ? '@' + c.username : c.name || c.igsid)}</b> <span class="pill ${d.windowOpen ? 'ok' : ''}">${d.windowOpen ? '24h window open' : 'Window closed'}</span>${paused ? ' <span class="pill warn">Automation paused</span>' : ''}</div>
          <div class="row"><button class="btn small" id="pause">${paused ? 'Resume automation' : 'Pause automation 24h'}</button><button class="btn small danger" id="forget">Delete</button></div>
        </div>
        <div class="chat-body">${d.messages.map((m) => `
          <div class="bubble ${m.direction === 'out' ? 'out' : ''}">${esc(m.text || '')}<small>${KIND[m.kind] ? KIND[m.kind] + ' · ' : ''}${m.direction === 'out' ? (m.source === 'auto' ? 'automation · ' : m.source === 'human' ? 'sent from Instagram · ' : 'you · ') : ''}${when(m.created_at)}</small></div>`).join('') || '<div class="empty">No messages.</div>'}
        </div>
        <form class="chat-foot"><textarea placeholder="${d.windowOpen ? 'Write a reply…' : 'You can reply once this person messages again (24-hour rule)'}" ${d.windowOpen ? '' : 'disabled'}></textarea><button class="btn primary" ${d.windowOpen ? '' : 'disabled'}>Send</button></form>`;
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
      run(loadThreads)();
      if (document.activeElement?.tagName !== 'TEXTAREA') loadChat(true);
    }, 15000);
  };

  // ---------- scheduler ----------

  const POST_TYPES = { IMAGE: 'Photo', CAROUSEL: 'Carousel', REELS: 'Reel', STORIES: 'Story' };
  const toLocalInput = (ms) => {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  };

  views.posts = async () => {
    const posts = await api('/posts');
    const pill = (p) => ({ scheduled: '<span class="pill accent">Scheduled</span>', publishing: '<span class="pill warn">Publishing…</span>', published: '<span class="pill ok">Published</span>', failed: '<span class="pill bad">Failed</span>' }[p.status]);
    main.innerHTML = `
      <div class="head">
        <div><h1>Scheduler</h1><p class="muted">Queue photos, carousels, reels and stories. Times are in your local timezone.</p></div>
        <button class="btn primary" id="new-post">Schedule a post</button>
      </div>
      <div class="card table-wrap">${posts.length ? `<table>
        <tr><th>Media</th><th>Type</th><th>Caption</th><th>When</th><th>Status</th><th></th></tr>
        ${posts.map((p) => `<tr>
          <td><div class="thumbs">${p.media.slice(0, 3).map(thumb).join('')}${p.media.length > 3 ? `<span class="muted small">+${p.media.length - 3}</span>` : ''}</div></td>
          <td>${POST_TYPES[p.type]}</td>
          <td class="clip">${esc(p.caption.slice(0, 140))}${p.caption.length > 140 ? '…' : ''}</td>
          <td style="white-space:nowrap">${when(p.status === 'published' ? p.published_at : p.scheduled_at)}</td>
          <td>${pill(p)}${p.error ? `<div class="small error">${esc(p.error)}</div>` : ''}</td>
          <td><div class="row">${p.status === 'scheduled' || p.status === 'failed' ? `<button class="btn small" data-edit="${p.id}">${p.status === 'failed' ? 'Retry / edit' : 'Edit'}</button>` : ''}${p.status !== 'publishing' ? `<button class="btn small danger" data-del="${p.id}">Delete</button>` : ''}</div></td>
        </tr>`).join('')}</table>` : '<div class="empty">Nothing scheduled yet.</div>'}
      </div>`;
    $('#new-post').onclick = () => postForm(null);
    main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => postForm(posts.find((p) => p.id == b.dataset.edit))));
    main.querySelectorAll('[data-del]').forEach((b) => (b.onclick = run(async () => {
      if (!confirm('Remove this post from the scheduler? (A published post stays on Instagram.)')) return;
      await api(`/posts/${b.dataset.del}`, { method: 'DELETE' });
      views.posts();
    })));
    refreshTimer = setInterval(() => !$('#modal').hidden || run(views.posts)(), 20000);
  };

  const thumb = (m) => `<span class="thumb">${m.kind === 'video' ? `<video src="${esc(m.url)}" muted preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="" loading="lazy">`}</span>`;

  function postForm(post) {
    let media = post ? [...post.media] : [];
    const at = post && post.scheduled_at > Date.now() ? post.scheduled_at : Date.now() + 3600000;
    const box = openModal(`
      <h2>${post ? 'Edit post' : 'Schedule a post'}</h2>
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
      box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => {
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
      toast('Post scheduled');
      views.posts();
    });
  }

  // ---------- activity ----------

  views.activity = async () => {
    const [outbox, logs] = await Promise.all([api('/outbox'), api('/logs')]);
    const KIND = { dm: 'DM', private_reply: 'DM reply to comment', comment_reply: 'Public reply' };
    const cls = { sent: 'ok', pending: 'accent', failed: 'bad', skipped: 'warn' };
    main.innerHTML = `
      <div class="head"><div><h1>Activity</h1><p class="muted">Every reply the system queued, and what happened to it.</p></div></div>
      <div class="stack">
        <div class="card table-wrap"><h2>Sent replies</h2>${outbox.length ? `<table>
          <tr><th>When</th><th>To</th><th>Type</th><th>Message</th><th>Automation</th><th>Status</th></tr>
          ${outbox.map((o) => `<tr>
            <td style="white-space:nowrap">${when(o.created_at)}</td>
            <td>${esc(o.username ? '@' + o.username : o.igsid || '')}</td>
            <td>${KIND[o.kind]}</td>
            <td class="clip">${esc((o.preview || '').slice(0, 160))}</td>
            <td>${esc(o.rule_name || (o.source === 'manual' ? 'Manual reply' : ''))}</td>
            <td><span class="pill ${cls[o.status]}">${o.status}</span>${o.error ? `<div class="small ${o.status === 'failed' ? 'error' : 'muted'}">${esc(o.error)}</div>` : ''}</td>
          </tr>`).join('')}</table>` : '<div class="empty">Nothing sent yet.</div>'}
        </div>
        <div class="card table-wrap"><h2>System log</h2>${logs.length ? `<table>
          ${logs.map((l) => `<tr><td style="white-space:nowrap">${when(l.created_at)}</td><td><span class="pill ${{ info: '', warn: 'warn', error: 'bad' }[l.level]}">${l.level}</span></td><td class="clip" style="max-width:none">${esc(l.message)}</td></tr>`).join('')}</table>` : '<div class="empty">No log entries.</div>'}
        </div>
      </div>`;
  };

  // ---------- settings ----------

  views.settings = async () => {
    const s = await api('/settings');
    main.innerHTML = `
      <div class="head"><div><h1>Settings</h1><p class="muted">Safety limits and how comments are collected.</p></div></div>
      <form class="card form" id="settings-form" style="max-width:620px">
        <label class="check"><input type="checkbox" name="automation_enabled" ${s.automation_enabled ? 'checked' : ''}> Automations are running</label>
        <label>Maximum replies per hour <span class="hint">A safety cap. Extra replies wait in the queue instead of being dropped.</span><input type="number" name="dm_hourly_limit" min="1" max="1000" value="${s.dm_hourly_limit}"></label>
        <label>Pause automation after I reply by hand (minutes) <span class="hint">When you answer someone from the Instagram app, automations stay quiet in that chat for this long. 0 turns this off.</span><input type="number" name="human_pause_min" min="0" max="10080" value="${s.human_pause_min}"></label>
        <label class="check"><input type="checkbox" name="poll_comments" ${s.poll_comments ? 'checked' : ''}> Check for new comments through the API</label>
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
        dm_hourly_limit: f.dm_hourly_limit.value, human_pause_min: f.human_pause_min.value,
        poll_interval_sec: f.poll_interval_sec.value, poll_media_count: f.poll_media_count.value,
      } });
    }, 'Settings saved');
  };

  start();
})();
