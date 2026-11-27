/* Owner's Clients page: one row per client instance, with a switch per tool. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NAMES = { dm: 'IG DMs', scheduler: 'IG Scheduler', linkedin: 'LinkedIn', whatsapp: 'WhatsApp' };
  const ago = (ms) => {
    if (!ms) return 'no activity yet';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 3600) return `active ${Math.max(1, Math.floor(s / 60))}m ago`;
    if (s < 86400) return `active ${Math.floor(s / 3600)}h ago`;
    return `active ${Math.floor(s / 86400)}d ago`;
  };
  let timer;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => (t.hidden = true), 3500);
  }
  async function api(path, opts = {}) {
    const r = await fetch('/api/clients' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 401) { location.replace('/?next=/clients'); throw new Error('Not signed in'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Something went wrong (${r.status})`);
    return j;
  }

  let apps = ['dm', 'scheduler', 'linkedin', 'whatsapp'];
  function row(c) {
    const meta = c.online
      ? [c.account?.instagram ? `Instagram @${c.account.instagram}` : `Instagram @${c.ig} · not connected yet`, c.account?.whatsapp ? `WhatsApp ${c.account.whatsapp}` : '', ago(c.lastActivityAt)].filter(Boolean)
      : [`Offline: ${c.error}`];
    const allOff = c.online && apps.every((a) => !c.apps?.[a]);
    return `<div class="panel cl${c.online ? '' : ' off'}" data-name="${esc(c.name)}">
      <div class="cl-name"><b>${esc(c.name)}</b> ${c.online ? (allOff ? '<span class="pill warn">Everything off</span>' : '<span class="pill ok">Online</span>') : '<span class="pill bad">Offline</span>'}
        <div><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url.replace(/^https?:\/\//, ''))}</a></div>
        <div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div></div>
      <div class="cl-toggles">${apps.map((a) => `<label class="tg${c.apps?.[a] ? ' on' : ''}"><span class="sw"><input type="checkbox" data-app="${a}" ${c.apps?.[a] ? 'checked' : ''} ${c.online ? '' : 'disabled'} aria-label="${esc(NAMES[a])} for ${esc(c.name)}"><i></i></span><span class="t">${esc(NAMES[a])}</span></label>`).join('')}</div>
    </div>`;
  }

  async function load() {
    const d = await api('/');
    apps = d.apps;
    const f = $('#upsell');
    if (document.activeElement?.form !== f) { f.message.value = d.upsell.message || ''; f.contact.value = d.upsell.contact || ''; }
    $('#list').innerHTML = d.clients.length
      ? d.clients.map(row).join('')
      : '<div class="panel empty">No clients yet. On the server run <code>scripts/client.sh add &lt;name&gt; &lt;instagram_username&gt;</code> and they appear here.</div>';
  }

  $('#list').addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-app]');
    if (!input) return;
    const card = input.closest('[data-name]');
    const name = card.dataset.name;
    input.disabled = true;
    try {
      await api('/' + encodeURIComponent(name), { method: 'PUT', body: { apps: { [input.dataset.app]: input.checked } } });
      input.closest('.tg').classList.toggle('on', input.checked);
      toast(`${NAMES[input.dataset.app]} ${input.checked ? 'unlocked' : 'locked'} for ${name}`);
    } catch (err) {
      input.checked = !input.checked;
      toast(err.message, true);
    } finally {
      input.disabled = false;
    }
  });
  $('#upsell').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/upsell', { method: 'PUT', body: { message: e.target.message.value, contact: e.target.contact.value } });
      const bad = r.results.filter((x) => !x.ok);
      toast(bad.length ? `Saved; ${bad.length} client(s) offline will get it next time you save` : 'Saved for all clients', !!bad.length);
    } catch (err) { toast(err.message, true); }
  };
  $('#refresh').onclick = () => load().catch((err) => toast(err.message, true));
  load().catch((err) => { $('#list').innerHTML = `<div class="panel empty">${esc(err.message)}</div>`; });
})();
