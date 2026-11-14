/* DM Autopilot — Insights: conversation & automation metrics plus Instagram post performance. */
(() => {
  const D = window.DMA;
  if (!D) return;
  const { $, $$, esc, ic, api, run, views, main } = D;

  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  let days = Number(store.get('ins_days', '30')) || 30;
  const S1 = 'var(--s1)';
  const S2 = 'var(--s2)';
  const compact = (n) => (n == null ? '—' : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : Math.abs(n) >= 1e4 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K` : Math.round(n).toLocaleString());
  const dur = (ms) => (ms == null ? '—' : ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3600_000).toFixed(1).replace(/\.0$/, '')} h`);
  const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
  // A change is only meaningful against a period with some history; tiny bases give silly numbers like +5000%.
  const pct = (cur, prev) => (prev >= 5 ? Math.round(((cur - prev) / prev) * 100) : null);

  /** Stat tile: label, value, optional signed change vs the previous period (arrow + text, never colour alone). */
  const tile = (label, value, change, { goodUp = true, hint = '' } = {}) => {
    const dir = change == null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
    const good = dir === 'flat' ? '' : (dir === 'up') === goodUp ? 'good' : 'bad';
    return `<div class="kpi"><span class="kpi-l">${esc(label)}</span><b class="kpi-v">${value}</b>
      ${change != null ? `<span class="kpi-d ${good}">${dir === 'up' ? ic('up') : dir === 'down' ? ic('dn') : ''}${change > 0 ? '+' : ''}${change}% <em>vs previous ${days} days</em></span>` : hint ? `<span class="kpi-d"><em>${esc(hint)}</em></span>` : ''}</div>`;
  };

  // ------------------------------------------------------------------ charts (SVG, drawn to the container's width)

  /** A round tick step so that four steps cover v: 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500 ... */
  function niceStep(v) {
    const raw = Math.max(1, v / 4);
    const p = 10 ** Math.floor(Math.log10(raw));
    for (const m of p >= 10 ? [1, 1.5, 2, 2.5, 3, 5, 10] : [1, 2, 3, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }
  const niceMax = (v) => niceStep(v) * 4;
  const observers = new WeakMap();
  function responsive(el, draw) {
    draw();
    observers.get(el)?.disconnect();
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - w) > 4) { w = el.clientWidth; draw(); } });
    ro.observe(el);
    observers.set(el, ro);
  }

  /** Line chart with hover crosshair. series: [{ name, color, values }], one shared y axis. */
  function lineChart(el, { labels, series, height = 230, fmt = compact, area = series.length === 1, zero = true }) {
    responsive(el, () => {
      const W = Math.max(280, el.clientWidth);
      const H = height;
      const longest = Math.max(...series.map((s) => `${s.name} ${fmt(Math.max(0, ...s.values.filter((v) => v != null)))}`.length));
      const m = { l: 38, r: series.length > 1 ? Math.min(160, 16 + longest * 6.8) : 16, t: 12, b: 26 };
      const iw = W - m.l - m.r;
      const ih = H - m.t - m.b;
      const n = labels.length;
      const all = series.flatMap((s) => s.values.filter((v) => v != null));
      // Counts start at zero; levels such as follower totals zoom to their range so change is visible.
      let lo = 0;
      let max = niceMax(Math.max(1, ...all));
      if (!zero && all.length) {
        const mn = Math.min(...all);
        const mx = Math.max(...all);
        let step = niceStep(Math.max(4, (mx - mn) * 1.2));
        lo = Math.max(0, Math.floor(mn / step) * step);
        if (lo + 4 * step < mx) { step = niceStep((mx - lo) * 1.05); lo = Math.max(0, Math.floor(mn / step) * step); }
        max = lo + 4 * step;
      }
      const x = (i) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
      const y = (v) => m.t + ih - ((v - lo) / (max - lo)) * ih;
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (max - lo));
      const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
      const path = (vals) => vals.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p}`).join('');
      const ends = series.map((s) => { const i = s.values.findLastIndex((v) => v != null); return i < 0 ? null : { s, i, v: s.values[i], yy: y(s.values[i]) }; }).filter(Boolean);
      const collide = ends.length > 1 && ends.some((a, i) => ends.some((b, j) => i < j && Math.abs(a.yy - b.yy) < 14));
      el.innerHTML = `
        ${series.length > 1 ? `<div class="iv-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : ''}
        <div class="iv-plot"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(' and '))} over time">
          ${ticks.map((t) => `<line class="iv-grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="iv-tick" x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('')}
          ${labels.map((l, i) => (i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every / 2) ? `<text class="iv-tick" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(shortDate(l))}</text>` : '').join('')}
          ${series.map((s) => `${area ? `<path d="${path(s.values)}L${x(s.values.findLastIndex((v) => v != null))},${y(lo)}L${x(s.values.findIndex((v) => v != null))},${y(lo)}Z" fill="${s.color}" opacity=".1"/>` : ''}
            <path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('')}
          ${ends.map((e) => `<circle cx="${x(e.i)}" cy="${e.yy}" r="4" fill="${e.s.color}" stroke="var(--chart-bg)" stroke-width="2"/>`).join('')}
          ${series.length > 1 && !collide ? ends.map((e) => `<text class="iv-end" x="${x(e.i) + 9}" y="${e.yy + 4}">${esc(e.s.name)} ${fmt(e.v)}</text>`).join('') : ''}
          <line class="iv-cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
          <g class="hov"></g>
          <rect class="iv-hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/>
        </svg><div class="iv-tip" hidden></div></div>`;
      const svg = $('svg', el);
      const tip = $('.iv-tip', el);
      const cross = $('.iv-cross', el);
      const hov = $('.hov', el);
      const show = (i) => {
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
        hov.innerHTML = series.map((s) => (s.values[i] == null ? '' : `<circle cx="${x(i)}" cy="${y(s.values[i])}" r="4" fill="${s.color}" stroke="var(--chart-bg)" stroke-width="2"/>`)).join('');
        tip.innerHTML = `<b>${esc(new Date(`${labels[i]}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }))}</b>${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}<em>${s.values[i] == null ? '—' : fmt(s.values[i])}</em></span>`).join('')}`;
        tip.hidden = false;
        const px = (x(i) / W) * svg.clientWidth;
        tip.style.left = `${Math.min(svg.clientWidth - tip.offsetWidth - 4, Math.max(4, px - tip.offsetWidth / 2))}px`;
      };
      const hide = () => { cross.setAttribute('visibility', 'hidden'); hov.innerHTML = ''; tip.hidden = true; };
      const hit = $('.iv-hit', el);
      hit.addEventListener('pointermove', (e) => {
        const r = svg.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        show(Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1)))));
      });
      hit.addEventListener('pointerleave', hide);
    });
  }

  /** Column chart, one series. items: [{ label, value, sub }]. */
  function columns(el, items, { height = 200, fmt = compact, name = 'Value' } = {}) {
    responsive(el, () => {
      const W = Math.max(280, el.clientWidth);
      const H = height;
      const m = { l: 38, r: 10, t: 18, b: 22 };
      const iw = W - m.l - m.r;
      const ih = H - m.t - m.b;
      const max = niceMax(Math.max(1, ...items.map((i) => i.value)));
      const band = iw / Math.max(1, items.length);
      const bw = Math.min(24, Math.max(4, band - 4));
      const y = (v) => m.t + ih - (v / max) * ih;
      const top = items.reduce((b, it, i) => (it.value > (items[b]?.value ?? -1) ? i : b), 0);
      el.innerHTML = `<div class="iv-plot"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(name)} per post">
        ${[0, 0.5, 1].map((f) => `<line class="iv-grid" x1="${m.l}" x2="${W - m.r}" y1="${y(f * max)}" y2="${y(f * max)}"/><text class="iv-tick" x="${m.l - 8}" y="${y(f * max) + 4}" text-anchor="end">${fmt(f * max)}</text>`).join('')}
        ${items.map((it, i) => {
          const cx = m.l + band * i + band / 2;
          const h = Math.max(it.value > 0 ? 2 : 0, (it.value / max) * ih);
          const r = Math.min(4, h / 2, bw / 2);
          const x0 = cx - bw / 2;
          const y0 = m.t + ih - h;
          return `<path class="iv-col" d="M${x0},${m.t + ih}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + bw - r}Q${x0 + bw},${y0} ${x0 + bw},${y0 + r}V${m.t + ih}Z" fill="${S1}"/>
            ${i === top && it.value > 0 ? `<text class="iv-end" x="${cx}" y="${y0 - 5}" text-anchor="middle">${fmt(it.value)}</text>` : ''}
            <rect class="iv-hitc" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}" fill="transparent"/>`;
        }).join('')}
        <line class="iv-base" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/>
      </svg><div class="iv-tip" hidden></div></div>`;
      const svg = $('svg', el);
      const tip = $('.iv-tip', el);
      $$('.iv-hitc', el).forEach((r) => {
        r.addEventListener('pointerenter', () => {
          const it = items[Number(r.dataset.i)];
          tip.innerHTML = `<b>${esc(it.label)}</b><span><i style="background:${S1}"></i>${esc(name)}<em>${fmt(it.value)}</em></span>${it.sub ? `<span class="muted">${esc(it.sub)}</span>` : ''}`;
          tip.hidden = false;
          const px = ((Number(r.getAttribute('x')) + band / 2) / W) * svg.clientWidth;
          tip.style.left = `${Math.min(svg.clientWidth - tip.offsetWidth - 4, Math.max(4, px - tip.offsetWidth / 2))}px`;
          $$('.iv-col', el)[Number(r.dataset.i)]?.classList.add('on');
        });
        r.addEventListener('pointerleave', () => { tip.hidden = true; $$('.iv-col.on', el).forEach((c) => c.classList.remove('on')); });
      });
    });
  }

  /** Weekday x hour heatmap, one blue ramp (empty cells recede to the surface). */
  function heatmap(el, heat) {
    const max = Math.max(...heat.flat());
    const step = (v) => (v <= 0 ? 0 : Math.min(5, 1 + Math.floor((v / max) * 4.999)));
    const dows = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString([], { weekday: 'short' }));
    const hourLabel = (h) => new Date(2024, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
    el.innerHTML = `<div class="heat" role="img" aria-label="Messages by weekday and hour">
        <span></span>${Array.from({ length: 24 }, (_, h) => `<span class="hh">${h % 3 === 0 ? esc(hourLabel(h)) : ''}</span>`).join('')}
        ${heat.map((row, d) => `<span class="hd">${esc(dows[d])}</span>${row.map((v, h) => `<i class="h${step(v)}" data-t="${esc(`${dows[d]} ${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${v} message${v === 1 ? '' : 's'}`)}"></i>`).join('')}`).join('')}
      </div>
      <div class="heat-foot"><span class="heat-tip muted small" aria-live="polite">${max ? 'Hover a square for details' : 'No messages in this period yet'}</span>
        <span class="heat-key small muted">Fewer <i class="h0"></i><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i><i class="h5"></i> More</span></div>`;
    const out = $('.heat-tip', el);
    $$('.heat i', el).forEach((c) => c.addEventListener('pointerenter', () => (out.textContent = c.dataset.t)));
  }

  /** The busiest two-hour window, as a posting-time suggestion. */
  function bestWindow(heat) {
    let best = null;
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      const v = heat[d][h] + heat[d][(h + 1) % 24];
      if (!best || v > best.v) best = { d, h, v };
    }
    if (!best?.v) return '';
    const day = new Date(2024, 0, 1 + best.d).toLocaleDateString([], { weekday: 'long' });
    const t = (h) => new Date(2024, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
    return `${day}s, ${t(best.h)}–${t((best.h + 2) % 24)}`;
  }

  const barList = (rows, total) => rows.length ? rows.map((r) => `
    <div class="bl-row"><div class="bl-name"><span>${esc(r.name)}</span>${r.tag ? `<span class="pill">${esc(r.tag)}</span>` : ''}</div>
      <div class="bl-track"><i style="width:${Math.max(2, (r.n / Math.max(1, total)) * 100)}%"></i></div><b>${compact(r.n)}</b></div>`).join('') : '';

  const dataTable = (head, rows) => `<details class="dt"><summary>Show as table</summary><div class="table-wrap"><table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div></details>`;

  // ------------------------------------------------------------------ page

  views.insights = async () => {
    const g = D.gen();
    const tz = -new Date().getTimezoneOffset();
    const a = await api(`/insights?days=${days}&tz=${tz}`);
    if (g !== D.gen()) return;
    const t = a.totals;
    const replies = t.autoReplies.value + t.manualReplies.value;
    const autoShare = replies ? Math.round((t.autoReplies.value / replies) * 100) : null;
    const del = a.delivery;
    const attempted = (del.sent || 0) + (del.failed || 0) + (del.skipped || 0);
    const rate = attempted ? Math.round(((del.sent || 0) / attempted) * 100) : null;
    const best = bestWindow(a.heat);
    const autoTotal = a.automations.reduce((s, r) => s + r.n, 0);

    main.innerHTML = `
      <div class="stack ins">
        <div class="ins-bar">
          <div class="seg" role="tablist" aria-label="Period">${[7, 30, 90].map((d) => `<button type="button" role="tab" data-days="${d}" aria-selected="${d === days}" class="${d === days ? 'on' : ''}">Last ${d} days</button>`).join('')}</div>
          <button class="btn small" type="button" id="ins-refresh">${ic('refresh')}Refresh</button>
        </div>

        <section class="card">
          <div class="card-head"><div><h2>Conversations</h2><p>Direct messages, comments and the replies your account sent.</p></div></div>
          <div class="kpis">
            ${tile('DMs received', compact(t.received.value), pct(t.received.value, t.received.prev))}
            ${tile('Replies sent', compact(replies), pct(replies, t.autoReplies.prev + t.manualReplies.prev), { hint: autoShare != null ? `${autoShare}% automated` : '' })}
            ${tile('Comments received', compact(t.comments.value), pct(t.comments.value, t.comments.prev))}
            ${tile('Median first reply', dur(a.response.median), null, { hint: a.response.count ? `${a.response.within5m}% answered within 5 min` : 'No answered messages yet' })}
            ${tile('New contacts', compact(t.newContacts.value), pct(t.newContacts.value, t.newContacts.prev))}
            ${tile('Delivered', rate == null ? '—' : `${rate}%`, null, { hint: attempted ? `${compact(del.sent || 0)} of ${compact(attempted)} queued messages` : 'Nothing sent yet' })}
          </div>
          <h3 class="ins-h">Messages per day</h3>
          <div class="chart-box" id="ch-msgs"></div>
          ${dataTable(['Date', 'DMs received', 'Replies sent'], a.daily.dates.map((d, i) => [d, a.daily.received[i], a.daily.sent[i]]))}
        </section>

        <div class="ins-2">
          <section class="card">
            <div class="card-head"><div><h2>When people message you</h2><p>${best ? `Busiest: <b>${esc(best)}</b>. Posting just before then catches your audience online.` : 'Fills in as messages arrive.'}</p></div></div>
            <div id="ch-heat"></div>
          </section>
          <section class="card">
            <div class="card-head"><div><h2>Top automations</h2><p>Automated replies sent in the last ${days} days.</p></div></div>
            ${barList(a.automations.map((r) => ({ name: r.name, n: r.n, tag: r.kind === 'flow' ? 'Flow' : 'Rule' })), Math.max(...a.automations.map((r) => r.n), 1)) || '<div class="empty">No automated replies in this period.</div>'}
            ${autoTotal ? `<p class="small muted" style="margin-top:12px">${compact(autoTotal)} automated replies in total${t.commentReplies.value ? ` · ${compact(t.commentReplies.value)} public comment replies` : ''}.</p>` : ''}
          </section>
        </div>

        <div class="ins-2">
          <section class="card">
            <div class="card-head"><div><h2>Flows</h2><p>People who started each flow in the last ${days} days.</p></div><a class="link" href="#flows">Open flows</a></div>
            ${a.flows.length ? `<div class="table-wrap"><table class="num-t"><tr><th>Flow</th><th>Started</th><th>Finished</th><th>Active</th><th>Dropped</th><th>Done</th></tr>
              ${a.flows.map((f) => `<tr><td><a href="#flow/${f.id}">${esc(f.name)}</a>${f.enabled ? '' : ' <span class="pill">Off</span>'}</td><td>${compact(f.started)}</td><td>${compact(f.finished)}</td><td>${compact(f.active)}</td><td>${compact(f.dropped)}</td>
                <td>${f.started ? `${Math.round((f.finished / f.started) * 100)}%` : '—'}</td></tr>`).join('')}</table></div>` : '<div class="empty">No flows yet. <a class="link" href="#flows">Build one</a></div>'}
          </section>
          <section class="card">
            <div class="card-head"><div><h2>Delivery</h2><p>What happened to messages queued in the last ${days} days.</p></div><a class="link" href="#activity">Activity</a></div>
            <div class="dl">
              ${[['sent', 'Delivered', 'check'], ['skipped', 'Skipped', 'pause'], ['failed', 'Failed', 'x'], ['pending', 'Waiting', 'calendar']].map(([k, l, i]) => `<div class="dl-i st-${k}"><span class="cal-st">${ic(i)}</span><b>${compact(del[k] || 0)}</b><span>${l}</span></div>`).join('')}
            </div>
            ${a.reasons.length ? `<h3 class="ins-h">Most common reasons</h3>${a.reasons.map((r) => `<div class="reason"><span class="pill ${r.status === 'failed' ? 'bad' : 'warn'}">${r.status}</span><span class="grow">${esc(r.error)}</span><b>${compact(r.n)}</b></div>`).join('')}` : ''}
            ${a.tags.length ? `<h3 class="ins-h">Contact tags</h3><div class="row">${a.tags.map((x) => `<span class="pill accent">${esc(x.name)} · ${compact(x.n)}</span>`).join('')}</div>` : ''}
          </section>
        </div>

        <div id="ig-part"><section class="card"><div class="empty">${ic('refresh')} Loading Instagram data…</div></section></div>
      </div>`;

    lineChart($('#ch-msgs'), { labels: a.daily.dates, series: [{ name: 'DMs received', color: S1, values: a.daily.received }, { name: 'Replies sent', color: S2, values: a.daily.sent }] });
    heatmap($('#ch-heat'), a.heat);
    $$('[data-days]').forEach((b) => (b.onclick = () => { days = Number(b.dataset.days); store.set('ins_days', String(days)); views.insights(); }));
    $('#ins-refresh').onclick = run(() => views.insights());

    try {
      const ig = await api(`/insights/instagram?days=${days}`);
      if (g !== D.gen()) return;
      renderInstagram(ig);
    } catch (e) {
      if (g !== D.gen()) return;
      $('#ig-part').innerHTML = `<section class="card"><div class="card-head"><h2>Instagram</h2></div><p class="error">Could not load Instagram data: ${esc(e.message)}</p></section>`;
    }
  };

  function renderInstagram(ig) {
    const box = $('#ig-part');
    if (!ig.connected) {
      box.innerHTML = `<section class="card"><div class="card-head"><h2>Instagram</h2></div><div class="empty">Connect your Instagram account to see followers and post performance.<br><a class="btn primary" href="/auth/instagram">Connect Instagram account</a></div></section>`;
      return;
    }
    const posts = ig.media.filter((m) => m.media_product_type !== 'STORY');
    const avg = (f) => (posts.length ? posts.reduce((s, m) => s + (f(m) || 0), 0) / posts.length : null);
    const avgLikes = avg((m) => m.like_count);
    const avgComments = avg((m) => m.comments_count);
    const followers = ig.account.followers;
    const eng = followers && avgLikes != null ? (((avgLikes + avgComments) / followers) * 100).toFixed(2) : null;
    const f = ig.followers;
    const fChange = f.length > 1 && f[0].value ? f.at(-1).value - f[0].value : null;
    const ins = ig.insights;
    const T = ins.totals || {};
    const hasPostInsights = posts.some((m) => m.insights);
    const engagement = (m) => (m.insights?.total_interactions ?? ((m.like_count || 0) + (m.comments_count || 0)));
    const typeName = (m) => (m.media_product_type === 'REELS' ? 'Reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : m.media_type === 'VIDEO' ? 'Video' : 'Photo');
    const sorted = [...posts].sort((a, b) => engagement(b) - engagement(a));

    box.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>Instagram · @${esc(ig.account.username)}</h2><p>Followers and how your recent posts performed.</p></div></div>
        <div class="kpis">
          ${tile('Followers', compact(followers), null, { hint: fChange != null ? `${fChange >= 0 ? '+' : ''}${compact(fChange)} in this period` : '' })}
          ${tile('Posts', compact(ig.account.mediaCount ?? posts.length), null)}
          ${tile('Avg likes per post', avgLikes == null ? '—' : compact(avgLikes), null, { hint: posts.length ? `last ${posts.length} posts` : '' })}
          ${tile('Avg comments per post', avgComments == null ? '—' : compact(avgComments), null)}
          ${tile('Engagement rate', eng == null ? '—' : `${eng}%`, null, { hint: 'likes + comments per post ÷ followers' })}
        </div>
        <div class="ins-2 flat">
          <div><h3 class="ins-h">Followers</h3>${f.length > 1 ? '<div class="chart-box" id="ch-fol"></div>' : `<div class="empty small">The app records your follower count every hour${ig.trackingSince ? ` (since ${esc(shortDate(ig.trackingSince))})` : ''}. The chart fills in from tomorrow.</div>`}</div>
          <div><h3 class="ins-h">Engagement per post</h3>${posts.length ? '<div class="chart-box" id="ch-posts"></div>' : '<div class="empty small">No posts yet.</div>'}</div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Reach & views</h2><p>${ins.available ? `From Instagram Insights, last ${ins.span} days${days > 30 ? ' (Instagram allows at most 30 days)' : ''}. Instagram can take up to 48 hours to update these.` : 'From Instagram Insights.'}</p></div></div>
        ${ins.available ? `
          <div class="kpis">
            ${[['views', 'Views'], ['accounts_engaged', 'Accounts engaged'], ['total_interactions', 'Interactions'], ['saves', 'Saves'], ['shares', 'Shares'], ['profile_links_taps', 'Profile link taps']].filter(([k]) => T[k] != null).map(([k, l]) => tile(l, compact(T[k]), null)).join('')}
          </div>
          <h3 class="ins-h">Reach per day</h3>
          ${ins.reach.length ? `<div class="chart-box" id="ch-reach"></div>${dataTable(['Date', 'Reach'], ins.reach.map((r) => [r.date, r.value]))}` : '<div class="empty small">No reach data for this period yet.</div>'}`
        : ins.needsPermission ? `<div class="perm">
            <p><b>Turn on Instagram Insights</b> to see reach, views, saves and shares here.</p>
            <ol><li>In the Meta dashboard open <i>API setup with Unified login → Configure your app</i>, open your configuration and choose <i>Edit permissions</i>.</li>
              <li>Add <code>instagram_manage_insights</code> and save.</li><li>Come back and reconnect your account so the new permission is granted.</li></ol>
            <a class="btn primary" href="/auth/instagram">${ic('link')}Reconnect Instagram</a></div>`
        : `<p class="error">Instagram did not return insights: ${esc(ins.error)}</p>`}
      </section>

      <section class="card">
        <div class="card-head"><div><h2>Top posts</h2><p>Your last ${posts.length} posts, best first.</p></div></div>
        ${sorted.length ? `<div class="table-wrap"><table class="num-t posts-t">
          <tr><th>Post</th><th>Type</th><th>Posted</th><th>Likes</th><th>Comments</th>${hasPostInsights ? '<th>Reach</th><th>Saves</th><th>Shares</th>' : ''}<th>Engagement</th><th></th></tr>
          ${sorted.map((m) => `<tr>
            <td><div class="pt"><span class="ag-thumb">${m.thumbnail_url || (m.media_type !== 'VIDEO' && m.media_url) ? `<img src="${esc(m.thumbnail_url || m.media_url)}" alt="" loading="lazy">` : ic('image')}</span><span class="pt-cap">${esc((m.caption || 'No caption').split('\n')[0].slice(0, 70))}</span></div></td>
            <td>${typeName(m)}</td><td style="white-space:nowrap">${esc(m.timestamp ? new Date(m.timestamp).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '')}</td>
            <td>${compact(m.like_count)}</td><td>${compact(m.comments_count)}</td>
            ${hasPostInsights ? `<td>${compact(m.insights?.reach)}</td><td>${compact(m.insights?.saved)}</td><td>${compact(m.insights?.shares)}</td>` : ''}
            <td><b>${compact(engagement(m))}</b></td>
            <td>${m.permalink ? `<a class="btn small" href="${esc(m.permalink)}" target="_blank" rel="noopener noreferrer">View ↗</a>` : ''}</td></tr>`).join('')}
        </table></div>` : '<div class="empty">No posts yet.</div>'}
      </section>`;

    if (f.length > 1) lineChart($('#ch-fol'), { labels: f.map((x) => x.date), series: [{ name: 'Followers', color: S1, values: f.map((x) => x.value) }], height: 200, area: false, zero: false });
    if (posts.length) {
      const chrono = [...posts].reverse();
      columns($('#ch-posts'), chrono.map((m) => ({ label: m.timestamp ? new Date(m.timestamp).toLocaleDateString([], { day: 'numeric', month: 'short' }) : 'Post', value: engagement(m), sub: (m.caption || '').split('\n')[0].slice(0, 60) })), { name: hasPostInsights ? 'Interactions' : 'Likes + comments' });
    }
    if (ins.available && ins.reach.length) lineChart($('#ch-reach'), { labels: ins.reach.map((r) => r.date), series: [{ name: 'Reach', color: S1, values: ins.reach.map((r) => r.value) }] });
  }
})();
