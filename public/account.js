/* Account: the login list (Google and email-link sign-in), alert and daily-summary emails. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let t;
  const toast = (msg, bad = false) => { const el = $('#toast'); el.textContent = msg; el.className = 'toast' + (bad ? ' bad' : ''); el.hidden = false; clearTimeout(t); t = setTimeout(() => (el.hidden = true), 3500); };
  async function api(path, opts = {}) {
    const r = await fetch('/api/account' + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (r.status === 401) { location.replace('/?next=/account'); throw new Error('Not signed in'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Something went wrong (${r.status})`);
    return j;
  }
  const sw = (name, on, disabled) => `<span class="sw"><input type="checkbox" name="${name}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}><i></i></span>`;

  async function load() {
    const a = await api('/');
    const ways = [a.google ? '<span class="pill ok">Google</span>' : '<span class="pill">Google not set up</span>', a.emailLink ? '<span class="pill ok">Email link</span>' : '<span class="pill">Email link not set up</span>', '<span class="pill ok">Password</span>'];
    $('#body').innerHTML = `
      <form class="panel" id="emails-f">
        <div class="panel-head"><h2>Who can sign in</h2><div style="display:flex;gap:6px;flex-wrap:wrap">${ways.join('')}</div></div>
        <div class="cl-up" style="grid-template-columns:minmax(0,1fr) auto">
          <label>Email addresses <span class="muted small">(comma separated)</span><input type="text" name="emails" value="${esc(a.emails.join(', '))}" placeholder="you@gmail.com, team@company.com"></label>
          <button class="btn primary" type="submit">Save</button>
        </div>
        <p class="hint">These addresses can sign in with Google or an email link, and receive the emails below. The password always works too.${a.managed ? '' : ' On a fresh server this list starts with OWNER_EMAIL.'}</p>
      </form>
      <form class="panel" id="notif-f">
        <div class="panel-head"><h2>Emails</h2>${a.emailReady ? '' : '<span class="pill warn">Email not set up on the server</span>'}</div>
        <div class="cl-grid" style="gap:10px">
          <label class="tg${a.alerts ? ' on' : ''}" style="justify-content:flex-start">${sw('alerts', a.alerts, !a.emailReady)}<span class="t" style="white-space:normal">Problem alerts <span class="muted small" style="font-weight:400">· failed posts or replies, expiring connections (at most one email an hour)</span></span></label>
          <label class="tg${a.summary ? ' on' : ''}" style="justify-content:flex-start">${sw('summary', a.summary, !a.emailReady)}<span class="t" style="white-space:normal">Daily summary <span class="muted small" style="font-weight:400">· every day after ${a.summaryHour}:00 (${esc(a.summaryTz)})</span></span></label>
        </div>
        <div class="lock-acts"><button class="btn" type="button" id="test" ${a.emailReady ? '' : 'disabled'}>Send a test email</button></div>
      </form>`;
    $('#emails-f').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('/', { method: 'PUT', body: { emails: e.target.emails.value } }); e.target.emails.value = r.emails.join(', '); toast('Saved'); } catch (err) { toast(err.message, true); }
    };
    $('#notif-f').addEventListener('change', async (e) => {
      const i = e.target.closest('input[type=checkbox]');
      if (!i) return;
      try { await api('/', { method: 'PUT', body: { [i.name]: i.checked } }); i.closest('.tg').classList.toggle('on', i.checked); toast('Saved'); } catch (err) { i.checked = !i.checked; toast(err.message, true); }
    });
    $('#test').onclick = async () => { try { await api('/test-email', { method: 'POST' }); toast('Test email sent'); } catch (err) { toast(err.message, true); } };
  }
  load().catch((e) => { $('#body').innerHTML = `<div class="panel empty">${esc(e.message)}</div>`; });
})();
