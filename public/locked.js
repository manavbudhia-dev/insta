/* Shown instead of a mini app the owner has not switched on for this workspace: what it does, and how to unlock it. */
(() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const INFO = {
    dm: { name: 'Instagram DM Automation', cls: 'dm', points: ['Instant auto-replies to DMs, comments and story replies', 'Comment-to-DM with links and buttons', 'Visual flows and a shared inbox'] },
    scheduler: { name: 'Instagram Scheduler', cls: 'sched', points: ['Plan photos, carousels, reels and stories', 'A content calendar that publishes on time', 'Post insights in one place'] },
    linkedin: { name: 'LinkedIn Scheduler', cls: 'li', points: ['Schedule text, image, video and poll posts', 'Profiles and company pages', 'AI-written drafts and analytics'] },
    whatsapp: { name: 'WhatsApp Automation', cls: 'wa', points: ['Auto-replies with quick-reply buttons', 'Template broadcasts with delivery stats', 'A shared WhatsApp inbox'] },
  };
  /** A contact can be a phone number (opens WhatsApp), an email, or a link. */
  function contactLink(c, appName) {
    c = String(c || '').trim();
    if (!c) return null;
    const text = encodeURIComponent(`Hi! I'd like to unlock ${appName} in my Autopilot dashboard.`);
    const digits = c.replace(/[\s()+.-]/g, '');
    if (/^\d{8,15}$/.test(digits)) return { href: `https://wa.me/${digits}?text=${text}`, label: 'Message us on WhatsApp' };
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return { href: `mailto:${c}?subject=${encodeURIComponent('Unlock ' + appName)}&body=${text}`, label: 'Email us' };
    if (/^https?:\/\//i.test(c)) return { href: c, label: 'Contact us' };
    return null;
  }
  async function start() {
    const id = new URLSearchParams(location.search).get('app');
    const info = INFO[id] || { name: 'This app', cls: '', points: [] };
    let view = null;
    try {
      const r = await fetch('/api/apps', { headers: { Accept: 'application/json' } });
      if (r.status === 401) return location.replace('/?next=' + encodeURIComponent('/locked?app=' + (id || '')));
      view = await r.json();
    } catch { /* show the generic text */ }
    if (view && id && view.apps?.[id]) return location.replace({ dm: '/dm/', scheduler: '/scheduler/', linkedin: '/linkedin/', whatsapp: '/whatsapp/' }[id]);
    const msg = view?.upsell?.message || "This tool isn't part of your plan yet. Get in touch to unlock it.";
    const link = contactLink(view?.upsell?.contact, info.name);
    const contactText = view?.upsell?.contact && !link ? `<p class="muted">Contact: <b>${esc(view.upsell.contact)}</b></p>` : '';
    document.getElementById('card').innerHTML = `
      <div class="lock-top"><span class="app-ico ${info.cls}"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span><span class="pill warn">Locked</span></div>
      <h1>${esc(info.name)}</h1>
      <p class="muted">${esc(msg)}</p>
      ${info.points.length ? `<ul class="lock-points">${info.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      ${contactText}
      <div class="lock-acts">${view?.managed ? '<button class="btn primary" type="button" id="request">Request unlock</button>' : ''}${link ? `<a class="btn${view?.managed ? '' : ' primary'}" href="${esc(link.href)}" target="_blank" rel="noopener">${esc(link.label)}</a>` : ''}<a class="btn ghost" href="/">Back to home</a></div>
      <p class="muted small" id="req-msg" hidden></p>`;
    const req = document.getElementById('request');
    if (req) req.onclick = async () => {
      req.disabled = true;
      const msg = document.getElementById('req-msg');
      try {
        const r = await fetch('/api/apps/unlock-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: id }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not send the request');
        req.textContent = 'Request sent ✓';
        msg.textContent = "We've let your account manager know. You'll see the tool here as soon as it's switched on.";
      } catch (e) {
        req.disabled = false;
        msg.textContent = e.message;
      }
      msg.hidden = false;
    };
  }
  start();
})();
