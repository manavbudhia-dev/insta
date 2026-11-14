/* DM Autopilot — monthly content calendar (replaces the list-only scheduler; the list stays as a tab). */
(() => {
  const D = window.DMA;
  if (!D) return;
  const { $, $$, esc, ic, api, toast, run, views, main, postForm, POST_TYPES } = D;

  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayOf = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const STATUS = {
    scheduled: { label: 'Scheduled', icon: 'calendar' },
    publishing: { label: 'Publishing', icon: 'refresh' },
    published: { label: 'Published', icon: 'check' },
    failed: { label: 'Failed', icon: 'x' },
    instagram: { label: 'On Instagram', icon: 'image' },
  };
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  const today = () => keyOf(new Date());
  let month = null; // first day of the month on screen
  let selected = today();
  let mode = store.get('cal_mode', 'month');
  let data = { posts: [], instagram: [] };

  /** A sensible default time for a new post on a given day: 10:00, or the next full hour if that has passed. */
  function defaultTime(k) {
    const d = dayOf(k);
    d.setHours(10, 0, 0, 0);
    if (d.getTime() > Date.now() + 10 * 60_000) return d.getTime();
    const n = new Date();
    n.setMinutes(0, 0, 0);
    n.setHours(n.getHours() + 1);
    return keyOf(n) === k ? n.getTime() : null;
  }
  const isPast = (k) => k < today();

  /** Everything shown on the calendar, as one list: posts made here and posts made directly on Instagram. */
  function items() {
    const out = data.posts.map((p) => ({
      kind: 'post', id: p.id, at: p.status === 'published' && p.published_at ? p.published_at : p.scheduled_at, status: p.status, type: p.type,
      caption: p.caption, thumb: p.media[0]?.kind === 'image' ? p.media[0].url : '', video: p.media[0]?.kind === 'video' ? p.media[0].url : '',
      error: p.error, post: p, permalink: p.instagram?.permalink || '', likes: p.instagram?.likes, comments: p.instagram?.comments,
    }));
    for (const m of data.instagram) out.push({ kind: 'ig', id: m.id, at: m.at, status: 'instagram', type: m.type, caption: m.caption, thumb: m.thumb, permalink: m.permalink, likes: m.likes, comments: m.comments });
    return out.sort((a, b) => a.at - b.at);
  }
  const byDay = () => {
    const map = new Map();
    for (const it of items()) {
      const k = keyOf(new Date(it.at));
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(it);
    }
    return map;
  };

  function gridDays() {
    const first = new Date(month);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7)); // weeks start on Monday
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }

  views.posts = async () => {
    const g = D.gen();
    if (!month) { const n = new Date(); month = new Date(n.getFullYear(), n.getMonth(), 1); }
    if (mode === 'list') return renderList(g);
    const days = gridDays();
    const from = days[0].getTime();
    const to = new Date(days[41].getFullYear(), days[41].getMonth(), days[41].getDate() + 1).getTime();
    data = await api(`/calendar?from=${from}&to=${to}`);
    if (g !== D.gen()) return;
    renderMonth(days);
    D.setRefresh(setInterval(() => D.visible() && $('#modal').hidden && !$('.cal-chip.dragging') && run(views.posts)(), 60000));
  };

  function header(extra = '') {
    return `<div class="cal-head">
      ${mode === 'month' ? `<div class="cal-nav">
        <button class="icon-btn" type="button" id="cal-prev" aria-label="Previous month">${ic('right')}</button>
        <h2 id="cal-title">${month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h2>
        <button class="icon-btn" type="button" id="cal-next" aria-label="Next month">${ic('right')}</button>
        <button class="btn small" type="button" id="cal-today">Today</button>
      </div>` : '<div class="cal-nav"><h2>All posts</h2></div>'}
      <div class="seg" role="tablist" aria-label="View">
        <button type="button" role="tab" data-mode="month" aria-selected="${mode === 'month'}" class="${mode === 'month' ? 'on' : ''}">${ic('calendar')}Month</button>
        <button type="button" role="tab" data-mode="list" aria-selected="${mode === 'list'}" class="${mode === 'list' ? 'on' : ''}">${ic('activity')}List</button>
      </div>
      ${extra}
      <button class="btn primary" id="cal-new" type="button">${ic('plus')}Schedule post</button>
    </div>`;
  }
  function bindHeader() {
    $$('[data-mode]').forEach((b) => (b.onclick = () => { mode = b.dataset.mode; store.set('cal_mode', mode); views.posts(); }));
    $('#cal-new').onclick = () => postForm(null, { at: defaultTime(isPast(selected) ? today() : selected) ?? undefined });
    if ($('#cal-prev')) {
      $('#cal-prev').onclick = () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); views.posts(); };
      $('#cal-next').onclick = () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); views.posts(); };
      $('#cal-today').onclick = () => { const n = new Date(); month = new Date(n.getFullYear(), n.getMonth(), 1); selected = today(); views.posts(); };
    }
  }

  const chip = (it) => {
    const st = STATUS[it.status];
    const movable = it.kind === 'post' && (it.status === 'scheduled' || it.status === 'failed');
    return `<div class="cal-chip st-${it.status}" ${movable ? 'draggable="true"' : ''} data-${it.kind === 'post' ? 'pid' : 'ig'}="${esc(it.id)}"
      title="${esc(`${st.label} · ${time(it.at)} · ${POST_TYPES[it.type] || it.type}${it.caption ? ' · ' + it.caption.slice(0, 80) : ''}`)}" tabindex="0">
      <span class="cal-st">${ic(st.icon)}</span><span class="cal-time">${time(it.at)}</span><span class="cal-cap">${esc((it.caption || POST_TYPES[it.type] || 'Post').split('\n')[0])}</span></div>`;
  };

  function renderMonth(days) {
    const map = byDay();
    const m = month.getMonth();
    const inMonth = items().filter((it) => new Date(it.at).getMonth() === m && new Date(it.at).getFullYear() === month.getFullYear());
    const count = (s) => inMonth.filter((it) => it.status === s).length;
    const dows = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString([], { weekday: 'short' }));
    if (keyOf(dayOf(selected)).slice(0, 7) !== keyOf(month).slice(0, 7) && !days.some((d) => keyOf(d) === selected)) selected = keyOf(month);
    main.innerHTML = `
      <div class="stack">
        <section class="card cal">
          ${header(`<div class="cal-sum">${['scheduled', 'published', 'instagram', 'failed'].map((s) => count(s) ? `<span class="cal-key st-${s}"><span class="cal-st">${ic(STATUS[s].icon)}</span>${count(s)} ${s === 'instagram' ? 'on Instagram' : STATUS[s].label.toLowerCase()}</span>` : '').join('')}</div>`)}
          ${data.error ? `<p class="small muted">Posts made directly on Instagram could not be loaded: ${esc(data.error)}</p>` : ''}
          <div class="cal-grid" role="grid" aria-labelledby="cal-title">
            ${dows.map((d) => `<div class="cal-dow" role="columnheader">${esc(d)}</div>`).join('')}
            ${days.map((d) => {
              const k = keyOf(d);
              const list = map.get(k) || [];
              const cls = [d.getMonth() !== m && 'other', k === today() && 'today', isPast(k) && 'past', k === selected && 'sel'].filter(Boolean).join(' ');
              return `<div class="cal-day ${cls}" role="gridcell" data-day="${k}" aria-label="${esc(d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))}, ${list.length} post${list.length === 1 ? '' : 's'}">
                <div class="cal-dhead"><button type="button" class="cal-dnum" data-select="${k}">${d.getDate()}</button>
                  ${!isPast(k) && defaultTime(k) ? `<button type="button" class="cal-add" data-add="${k}" aria-label="Schedule a post on ${esc(d.toLocaleDateString([], { day: 'numeric', month: 'long' }))}">${ic('plus')}</button>` : ''}</div>
                <div class="cal-items">${list.slice(0, 3).map(chip).join('')}${list.length > 3 ? `<button type="button" class="cal-more" data-select="${k}">+${list.length - 3} more</button>` : ''}</div>
                <div class="cal-dots" aria-hidden="true">${list.slice(0, 4).map((it) => `<i class="st-${it.status}"></i>`).join('')}</div>
              </div>`;
            }).join('')}
          </div>
          <p class="cal-tip small muted">Click a day to see its posts, or <b>+</b> to schedule one. Drag a scheduled post to another day to move it (it keeps its time).</p>
        </section>
        <section class="card" id="cal-agenda"></section>
      </div>`;
    bindHeader();
    renderAgenda(map);
    bindGrid(map);
  }

  function renderAgenda(map) {
    const box = $('#cal-agenda');
    const list = map.get(selected) || [];
    const d = dayOf(selected);
    box.innerHTML = `
      <div class="card-head"><div><h2>${esc(d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))}</h2><p>${list.length ? `${list.length} post${list.length === 1 ? '' : 's'}` : 'Nothing planned on this day.'}</p></div>
        ${!isPast(selected) && defaultTime(selected) ? `<button class="btn" type="button" id="ag-new">${ic('plus')}Schedule on this day</button>` : ''}</div>
      ${list.map((it) => `
        <div class="ag-row">
          <span class="ag-thumb">${it.thumb ? `<img src="${esc(it.thumb)}" alt="" loading="lazy">` : it.video ? `<video src="${esc(it.video)}" muted preload="metadata"></video>` : ic('image')}</span>
          <div class="grow">
            <div class="ag-top"><b>${time(it.at)}</b><span class="muted">${POST_TYPES[it.type] || it.type}</span><span class="cal-key st-${it.status}"><span class="cal-st">${ic(STATUS[it.status].icon)}</span>${STATUS[it.status].label}</span>
              ${it.likes !== undefined && it.likes !== null ? `<span class="muted small">${D.num(it.likes)} likes · ${D.num(it.comments)} comments</span>` : ''}</div>
            <div class="ag-cap">${esc(it.caption || 'No caption')}</div>
            ${it.error ? `<div class="small error">${esc(it.error)}</div>` : ''}
          </div>
          <div class="row" style="flex-wrap:nowrap">
            ${it.kind === 'post' && (it.status === 'scheduled' || it.status === 'failed') ? `<button class="btn small" type="button" data-edit="${it.id}">${it.status === 'failed' ? 'Retry / edit' : 'Edit'}</button>` : ''}
            ${it.permalink ? `<a class="btn small" href="${esc(it.permalink)}" target="_blank" rel="noopener noreferrer">View ↗</a>` : ''}
            ${it.kind === 'post' && it.status !== 'publishing' ? `<button class="btn small danger" type="button" data-del="${it.id}" aria-label="Delete">${ic('trash')}</button>` : ''}
          </div>
        </div>`).join('')}`;
    if ($('#ag-new')) $('#ag-new').onclick = () => postForm(null, { at: defaultTime(selected) });
    bindPostActions(box);
  }

  function bindPostActions(box) {
    $$('[data-edit]', box).forEach((b) => (b.onclick = () => postForm(data.posts.find((p) => p.id == b.dataset.edit))));
    $$('[data-del]', box).forEach((b) => (b.onclick = run(async () => {
      if (!confirm('Remove this post from the calendar? A post that is already published stays on Instagram.')) return;
      await api(`/posts/${b.dataset.del}`, { method: 'DELETE' });
      toast('Post removed');
      views.posts();
    })));
  }

  function bindGrid(map) {
    const grid = $('.cal-grid');
    const select = (k) => {
      selected = k;
      $$('.cal-day', grid).forEach((c) => c.classList.toggle('sel', c.dataset.day === k));
      renderAgenda(map);
      if (innerWidth <= 700) $('#cal-agenda').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    grid.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) return postForm(null, { at: defaultTime(add.dataset.add) });
      const c = e.target.closest('.cal-chip');
      if (c?.dataset.pid) {
        const p = data.posts.find((x) => x.id == c.dataset.pid);
        if (p && (p.status === 'scheduled' || p.status === 'failed')) return postForm(p);
      }
      const day = e.target.closest('[data-day]');
      if (day) select(day.dataset.day);
    });
    grid.addEventListener('keydown', (e) => {
      const c = e.target.closest('.cal-chip');
      if (c && e.key === 'Enter') c.click();
    });
    // Drag a scheduled post onto another day: same time of day, new date.
    let dragId = null;
    grid.addEventListener('dragstart', (e) => {
      const c = e.target.closest('.cal-chip[draggable]');
      if (!c) return;
      dragId = c.dataset.pid;
      c.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    grid.addEventListener('dragend', () => { dragId = null; $$('.cal-chip.dragging, .cal-day.drop', grid).forEach((x) => x.classList.remove('dragging', 'drop')); });
    grid.addEventListener('dragover', (e) => {
      const day = e.target.closest('.cal-day');
      if (!dragId || !day || isPast(day.dataset.day)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      $$('.cal-day.drop', grid).forEach((x) => x !== day && x.classList.remove('drop'));
      day.classList.add('drop');
    });
    grid.addEventListener('drop', (e) => {
      const day = e.target.closest('.cal-day');
      const p = data.posts.find((x) => x.id == dragId);
      if (!day || !p || isPast(day.dataset.day)) return;
      e.preventDefault();
      const old = new Date(p.scheduled_at);
      const next = dayOf(day.dataset.day);
      next.setHours(old.getHours(), old.getMinutes(), 0, 0);
      let at = next.getTime();
      let note = '';
      if (at < Date.now() + 2 * 60_000) {
        const n = new Date(Date.now() + 15 * 60_000);
        n.setMinutes(Math.ceil(n.getMinutes() / 15) * 15, 0, 0);
        at = n.getTime();
        note = ` at ${time(at)} (that time had already passed)`;
      }
      if (keyOf(new Date(at)) === keyOf(old) && Math.abs(at - p.scheduled_at) < 60_000) return;
      run(async () => {
        await api(`/posts/${p.id}/reschedule`, { method: 'POST', body: { scheduled_at: at } });
        toast(`Moved to ${new Date(at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}${note}`);
        selected = keyOf(new Date(at));
        views.posts();
      })();
    });
  }

  async function renderList(g) {
    const posts = await api('/posts');
    if (g !== D.gen()) return;
    const pill = (p) => `<span class="cal-key st-${p.status}"><span class="cal-st">${ic(STATUS[p.status].icon)}</span>${STATUS[p.status].label}</span>`;
    main.innerHTML = `
      <section class="card cal">
        ${header()}
        ${posts.length ? `<div class="table-wrap"><table>
          <tr><th>Media</th><th>Type</th><th>Caption</th><th>When</th><th>Status</th><th></th></tr>
          ${posts.map((p) => `<tr>
            <td><span class="ag-thumb">${p.media[0]?.kind === 'image' ? `<img src="${esc(p.media[0].url)}" alt="" loading="lazy">` : p.media[0] ? `<video src="${esc(p.media[0].url)}" muted preload="metadata"></video>` : ''}</span></td>
            <td>${POST_TYPES[p.type]}${p.media.length > 1 ? ` · ${p.media.length}` : ''}</td>
            <td class="clip">${esc(p.caption.slice(0, 140))}${p.caption.length > 140 ? '…' : ''}</td>
            <td style="white-space:nowrap">${D.when(p.status === 'published' ? p.published_at : p.scheduled_at)}</td>
            <td>${pill(p)}${p.error ? `<div class="small error">${esc(p.error)}</div>` : ''}</td>
            <td><div class="row" style="flex-wrap:nowrap">${p.status === 'scheduled' || p.status === 'failed' ? `<button class="btn small" data-edit="${p.id}" type="button">${p.status === 'failed' ? 'Retry / edit' : 'Edit'}</button>` : ''}${p.status !== 'publishing' ? `<button class="btn small danger" data-del="${p.id}" type="button" aria-label="Delete">${ic('trash')}</button>` : ''}</div></td>
          </tr>`).join('')}</table></div>` : '<div class="empty">Nothing scheduled yet.</div>'}
      </section>`;
    data = { posts, instagram: [] };
    bindHeader();
    bindPostActions(main);
    D.setRefresh(setInterval(() => D.visible() && $('#modal').hidden && run(views.posts)(), 30000));
  }
})();
