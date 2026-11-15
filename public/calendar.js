/* Monthly content calendar (the list stays as a tab).
   - In the Instagram Scheduler (window.DMA) it shows Instagram posts only.
   - On the home page (window.CALHOST) it shows Instagram and LinkedIn together; creating or editing an Instagram post
     opens the Instagram Scheduler, a LinkedIn post opens the LinkedIn composer. */
(() => {
  const D = window.DMA || window.CALHOST;
  if (!D) return;
  const { $, $$, esc, ic, api, toast, run, views, main, POST_TYPES, popover } = D;
  const CFG = D.calendar || {};
  const PLATS = CFG.platforms || ['instagram'];
  const multi = PLATS.length > 1;
  const HASH = CFG.hashBase || 'posts';
  const igNew = (k, at) => (CFG.igNew ? CFG.igNew(k, at) : D.postForm(null, { at }));
  const igEdit = (post) => (CFG.igEdit ? CFG.igEdit(post) : D.postForm(post));
  const modalOpen = () => !!document.querySelector('#modal:not([hidden])');

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
  const LI_TYPES = { text: 'Text', image: 'Image', video: 'Video', poll: 'Poll' };
  const PLATFORMS = { all: 'All', instagram: 'Instagram', linkedin: 'LinkedIn' };
  const typeLabel = (it) => (it.platform === 'linkedin' ? LI_TYPES[it.type] : POST_TYPES[it.type]) || it.type || 'Post';
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // The LinkedIn scheduler lives at /linkedin; the platform login signs you in there too.
  async function li(path, opts = {}) {
    const res = await fetch('/linkedin/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `LinkedIn answered ${res.status}`);
    return j;
  }
  const liUrl = (urn) => (urn ? `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/` : '');
  const liThumb = (p) => {
    if (p.status === 'published' || p.type !== 'image') return ''; // media is deleted from the server once LinkedIn has it
    try { const m = JSON.parse(p.media_json || '[]')[0]; return m ? `/linkedin/api/media/${Number(m.id)}` : ''; } catch { return ''; }
  };

  const today = () => keyOf(new Date());
  let month = null; // first day of the month on screen
  let selected = today();
  let mode = store.get('cal_mode', 'month');
  let plat = multi ? store.get('cal_platform', 'all') : 'instagram';
  let data = { posts: [], instagram: [], linkedin: [] };

  /** "#calendar/linkedin" (e.g. from the LinkedIn app) opens the home calendar filtered to that platform. */
  function readHashPlatform() {
    if (!multi) return;
    const [base, p] = location.hash.slice(1).split('/');
    if (base === HASH && PLATFORMS[p]) plat = p;
  }
  function setPlatform(p) {
    plat = p;
    store.set('cal_platform', p);
    history.replaceState(null, '', `#${HASH}/${p}`);
    views.posts();
  }
  const shows = (p) => PLATS.includes(p) && (plat === 'all' || plat === p);

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

  const fromIg = (p) => ({
    platform: 'instagram', kind: 'post', id: p.id, at: p.status === 'published' && p.published_at ? p.published_at : p.scheduled_at, status: p.status, type: p.type,
    caption: p.caption, thumb: p.media[0]?.kind === 'image' ? p.media[0].url : '', video: p.media[0]?.kind === 'video' ? p.media[0].url : '',
    error: p.error, post: p, permalink: p.instagram?.permalink || '', likes: p.instagram?.likes, comments: p.instagram?.comments,
  });
  const fromLi = (p) => ({
    platform: 'linkedin', kind: 'li', id: p.id, at: p.status === 'published' && p.published_at ? p.published_at : p.when_at, status: p.status, type: p.type,
    caption: p.text, thumb: liThumb(p), error: p.error, post: p, permalink: liUrl(p.urn), account: p.account_name,
  });

  /** Everything shown on the calendar, as one list: posts made here, posts made directly on Instagram, and LinkedIn posts. */
  function items() {
    const out = [];
    if (shows('instagram')) {
      out.push(...data.posts.map(fromIg));
      for (const m of data.instagram) out.push({ platform: 'instagram', kind: 'ig', id: m.id, at: m.at, status: 'instagram', type: m.type, caption: m.caption, thumb: m.thumb, permalink: m.permalink, likes: m.likes, comments: m.comments });
    }
    if (shows('linkedin')) out.push(...data.linkedin.map(fromLi));
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
  const find = (kind, id) => items().find((it) => it.kind === kind && String(it.id) === String(id));

  function gridDays() {
    const first = new Date(month);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7)); // weeks start on Monday
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }

  /** The home calendar sends "#posts/new/2026-11-20" or "#posts/edit/12" here: open that day, then the post form. */
  function takeDeepLink() {
    if (multi) return null;
    const [base, act, arg] = location.hash.slice(1).split('/');
    if (base !== 'posts' || (act !== 'new' && act !== 'edit')) return null;
    history.replaceState(null, '', '#posts');
    if (act === 'new' && /^\d{4}-\d{2}-\d{2}$/.test(arg || '')) {
      selected = arg;
      const d = dayOf(arg);
      month = new Date(d.getFullYear(), d.getMonth(), 1);
    }
    return { act, arg };
  }
  async function followDeepLink(link) {
    if (!link) return;
    if (link.act === 'new') return igNew(selected, (!isPast(selected) && defaultTime(selected)) || undefined);
    const p = data.posts.find((x) => String(x.id) === link.arg) || (await api('/posts')).find((x) => String(x.id) === link.arg);
    if (p && (p.status === 'scheduled' || p.status === 'failed')) igEdit(p);
  }

  views.posts = async () => {
    const g = D.gen();
    readHashPlatform();
    const link = takeDeepLink();
    if (!month) { const n = new Date(); month = new Date(n.getFullYear(), n.getMonth(), 1); }
    if (mode === 'list') { await renderList(g); return followDeepLink(link); }
    const days = gridDays();
    const from = days[0].getTime();
    const to = new Date(days[41].getFullYear(), days[41].getMonth(), days[41].getDate() + 1).getTime();
    const [ig, lin] = await Promise.all([
      shows('instagram') ? api(`/calendar?from=${from}&to=${to}`) : { posts: [], instagram: [] },
      shows('linkedin') ? li(`/calendar?from=${from}&to=${to}`).then((r) => ({ list: r }), (e) => ({ list: [], error: e.message })) : { list: [] },
    ]);
    if (g !== D.gen()) return;
    data = { ...ig, linkedin: lin.list, liError: lin.error };
    renderMonth(days);
    D.setRefresh(setInterval(() => D.visible() && !modalOpen() && !$('.cal-chip.dragging') && run(views.posts)(), 60000));
    await followDeepLink(link);
  };

  /** New post on a day: straight to the right composer, or ask which platform when showing both. */
  function newPost(k, anchor) {
    const at = defaultTime(k) ?? undefined;
    const ig = () => igNew(k, at);
    const lin = () => location.assign(`/linkedin/?date=${encodeURIComponent(k)}`);
    if (!shows('linkedin')) return ig();
    if (!shows('instagram')) return lin();
    popover(anchor, [{ cap: 'Schedule a post on' }, { icon: 'image', label: 'Instagram', onClick: ig }, { icon: 'linkedin', label: 'LinkedIn', onClick: lin }]);
  }

  function header(extra = '') {
    return `<div class="cal-head">
      ${mode === 'month' ? `<div class="cal-nav">
        <button class="icon-btn" type="button" id="cal-prev" aria-label="Previous month">${ic('right')}</button>
        <h2 id="cal-title">${month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h2>
        <button class="icon-btn" type="button" id="cal-next" aria-label="Next month">${ic('right')}</button>
        <button class="btn small" type="button" id="cal-today">Today</button>
      </div>` : '<div class="cal-nav"><h2>All posts</h2></div>'}
      ${multi ? `<div class="seg" role="tablist" aria-label="Platform">
        ${Object.entries(PLATFORMS).map(([k, l]) => `<button type="button" role="tab" data-plat="${k}" aria-selected="${plat === k}" class="${plat === k ? 'on' : ''}">${k === 'all' ? '' : `<span class="cal-pf pf-${k}" aria-hidden="true"></span>`}${l}</button>`).join('')}
      </div>` : ''}
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
    $$('[data-plat]').forEach((b) => (b.onclick = () => setPlatform(b.dataset.plat)));
    $('#cal-new').onclick = (e) => newPost(isPast(selected) || !defaultTime(selected) ? today() : selected, e.currentTarget);
    if ($('#cal-prev')) {
      $('#cal-prev').onclick = () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); views.posts(); };
      $('#cal-next').onclick = () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); views.posts(); };
      $('#cal-today').onclick = () => { const n = new Date(); month = new Date(n.getFullYear(), n.getMonth(), 1); selected = today(); views.posts(); };
    }
  }

  const movable = (it) => (it.kind === 'post' || it.kind === 'li') && (it.status === 'scheduled' || it.status === 'failed');
  const pf = (it) => (multi ? `<span class="cal-pf pf-${it.platform}" title="${PLATFORMS[it.platform]}"></span>` : '');
  const chip = (it) => {
    const st = STATUS[it.status];
    return `<div class="cal-chip st-${it.status}" ${movable(it) ? 'draggable="true"' : ''} data-kind="${it.kind}" data-id="${esc(it.id)}"
      title="${esc(`${multi ? PLATFORMS[it.platform] + ' · ' : ''}${st.label} · ${time(it.at)} · ${typeLabel(it)}${it.account ? ' · ' + it.account : ''}${it.caption ? ' · ' + it.caption.slice(0, 80) : ''}`)}" tabindex="0">
      ${pf(it)}<span class="cal-st">${ic(st.icon)}</span><span class="cal-time">${time(it.at)}</span><span class="cal-cap">${esc((it.caption || typeLabel(it)).split('\n')[0])}</span></div>`;
  };

  function renderMonth(days) {
    const map = byDay();
    const m = month.getMonth();
    const inMonth = items().filter((it) => new Date(it.at).getMonth() === m && new Date(it.at).getFullYear() === month.getFullYear());
    const count = (s) => inMonth.filter((it) => it.status === s).length;
    const perPlat = (p) => inMonth.filter((it) => it.platform === p).length;
    const dows = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString([], { weekday: 'short' }));
    if (keyOf(dayOf(selected)).slice(0, 7) !== keyOf(month).slice(0, 7) && !days.some((d) => keyOf(d) === selected)) selected = keyOf(month);
    const sum = [
      ...(multi && plat === 'all' ? ['instagram', 'linkedin'].map((p) => perPlat(p) ? `<span class="cal-key"><span class="cal-pf pf-${p}"></span>${perPlat(p)} ${PLATFORMS[p]}</span>` : '') : []),
      ...['scheduled', 'published', 'instagram', 'failed'].map((s) => count(s) ? `<span class="cal-key st-${s}"><span class="cal-st">${ic(STATUS[s].icon)}</span>${count(s)} ${s === 'instagram' ? 'on Instagram' : STATUS[s].label.toLowerCase()}</span>` : ''),
    ].join('');
    main.innerHTML = `
      <div class="stack">
        <section class="card cal">
          ${header(`<div class="cal-sum">${sum}</div>`)}
          ${data.error ? `<p class="small muted">Posts made directly on Instagram could not be loaded: ${esc(data.error)}</p>` : ''}
          ${data.liError ? `<p class="small muted">LinkedIn posts could not be loaded: ${esc(data.liError)}</p>` : ''}
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
          <p class="cal-tip small muted">Click a day to see its posts, or <b>+</b> to schedule one. Drag a scheduled post to another day to move it (it keeps its time).${multi ? ' Instagram and LinkedIn posts both move this way.' : ''}</p>
        </section>
        <section class="card" id="cal-agenda"></section>
      </div>`;
    bindHeader();
    renderAgenda(map);
    bindGrid(map);
  }

  const editBtn = (it) => {
    if (!movable(it)) return '';
    const label = it.status === 'failed' ? 'Retry / edit' : 'Edit';
    return it.kind === 'li' ? `<a class="btn small" href="/linkedin/?edit=${Number(it.id)}">${label}</a>` : `<button class="btn small" type="button" data-edit="${it.id}">${label}</button>`;
  };

  function renderAgenda(map) {
    const box = $('#cal-agenda');
    const list = map.get(selected) || [];
    const d = dayOf(selected);
    box.innerHTML = `
      <div class="card-head"><div><h2>${esc(d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))}</h2><p>${list.length ? `${list.length} post${list.length === 1 ? '' : 's'}` : 'Nothing planned on this day.'}</p></div>
        ${!isPast(selected) && defaultTime(selected) ? `<button class="btn" type="button" id="ag-new">${ic('plus')}Schedule on this day</button>` : ''}</div>
      ${list.map((it) => `
        <div class="ag-row">
          <span class="ag-thumb">${it.thumb ? `<img src="${esc(it.thumb)}" alt="" loading="lazy">` : it.video ? `<video src="${esc(it.video)}" muted preload="metadata"></video>` : ic(it.platform === 'linkedin' ? 'linkedin' : 'image')}</span>
          <div class="grow">
            <div class="ag-top"><b>${time(it.at)}</b>${multi ? `<span class="cal-key">${pf(it)}${PLATFORMS[it.platform]}</span>` : ''}<span class="muted">${esc(typeLabel(it))}${it.account ? ` · ${esc(it.account)}` : ''}</span><span class="cal-key st-${it.status}"><span class="cal-st">${ic(STATUS[it.status].icon)}</span>${STATUS[it.status].label}</span>
              ${it.likes !== undefined && it.likes !== null ? `<span class="muted small">${D.num(it.likes)} likes · ${D.num(it.comments)} comments</span>` : ''}</div>
            <div class="ag-cap">${esc(it.caption || 'No caption')}</div>
            ${it.error ? `<div class="small error">${esc(it.error)}</div>` : ''}
          </div>
          <div class="cal-actions">
            ${editBtn(it)}
            ${it.permalink ? `<a class="btn small" href="${esc(it.permalink)}" target="_blank" rel="noopener noreferrer">View ↗</a>` : ''}
            ${(it.kind === 'post' || it.kind === 'li') && it.status !== 'publishing' ? `<button class="btn small danger" type="button" data-del="${it.kind}:${it.id}" aria-label="Delete">${ic('trash')}</button>` : ''}
          </div>
        </div>`).join('')}`;
    if ($('#ag-new')) $('#ag-new').onclick = (e) => newPost(selected, e.currentTarget);
    bindPostActions(box);
  }

  function bindPostActions(box) {
    $$('[data-edit]', box).forEach((b) => (b.onclick = () => igEdit(data.posts.find((p) => p.id == b.dataset.edit))));
    $$('[data-del]', box).forEach((b) => (b.onclick = run(async () => {
      const [kind, id] = b.dataset.del.split(':');
      const where = kind === 'li' ? 'LinkedIn' : 'Instagram';
      if (!confirm(`Remove this post from the calendar? A post that is already published stays on ${where}.`)) return;
      if (kind === 'li') await li(`/posts/${id}`, { method: 'DELETE' });
      else await api(`/posts/${id}`, { method: 'DELETE' });
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
      if (add) return newPost(add.dataset.add, add);
      const c = e.target.closest('.cal-chip');
      if (c) {
        const it = find(c.dataset.kind, c.dataset.id);
        if (it && movable(it)) {
          if (it.kind === 'li') return location.assign(`/linkedin/?edit=${Number(it.id)}`);
          return igEdit(it.post);
        }
      }
      const day = e.target.closest('[data-day]');
      if (day) select(day.dataset.day);
    });
    grid.addEventListener('keydown', (e) => {
      const c = e.target.closest('.cal-chip');
      if (c && e.key === 'Enter') c.click();
    });
    // Drag a scheduled post onto another day: same time of day, new date.
    let drag = null;
    grid.addEventListener('dragstart', (e) => {
      const c = e.target.closest('.cal-chip[draggable]');
      if (!c) return;
      drag = find(c.dataset.kind, c.dataset.id);
      c.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `${c.dataset.kind}:${c.dataset.id}`);
    });
    grid.addEventListener('dragend', () => { drag = null; $$('.cal-chip.dragging, .cal-day.drop', grid).forEach((x) => x.classList.remove('dragging', 'drop')); });
    grid.addEventListener('dragover', (e) => {
      const day = e.target.closest('.cal-day');
      if (!drag || !day || isPast(day.dataset.day)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      $$('.cal-day.drop', grid).forEach((x) => x !== day && x.classList.remove('drop'));
      day.classList.add('drop');
    });
    grid.addEventListener('drop', (e) => {
      const day = e.target.closest('.cal-day');
      const it = drag;
      if (!day || !it || isPast(day.dataset.day)) return;
      e.preventDefault();
      const old = new Date(it.at);
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
      if (keyOf(new Date(at)) === keyOf(old) && Math.abs(at - it.at) < 60_000) return;
      run(async () => {
        if (it.kind === 'li') await li(`/posts/${it.id}/reschedule`, { method: 'POST', body: { whenAt: at } });
        else await api(`/posts/${it.id}/reschedule`, { method: 'POST', body: { scheduled_at: at } });
        toast(`Moved to ${new Date(at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}${note}`);
        selected = keyOf(new Date(at));
        views.posts();
      })();
    });
  }

  async function renderList(g) {
    const [igPosts, lin] = await Promise.all([
      shows('instagram') ? api('/posts') : [],
      shows('linkedin') ? li('/posts').then((r) => ({ list: r.filter((p) => p.status !== 'draft') }), (e) => ({ list: [], error: e.message })) : { list: [] },
    ]);
    if (g !== D.gen()) return;
    data = { posts: igPosts, instagram: [], linkedin: lin.list, liError: lin.error };
    const upcoming = (it) => it.status === 'scheduled' || it.status === 'publishing';
    const rows = [...igPosts.map(fromIg), ...lin.list.map(fromLi)]
      .sort((a, b) => (upcoming(a) !== upcoming(b) ? (upcoming(a) ? -1 : 1) : upcoming(a) ? a.at - b.at : b.at - a.at));
    const pill = (it) => `<span class="cal-key st-${it.status}"><span class="cal-st">${ic(STATUS[it.status].icon)}</span>${STATUS[it.status].label}</span>`;
    main.innerHTML = `
      <section class="card cal">
        ${header()}
        ${lin.error ? `<p class="small muted">LinkedIn posts could not be loaded: ${esc(lin.error)}</p>` : ''}
        ${rows.length ? `<div class="table-wrap"><table>
          <tr><th>Media</th>${multi ? '<th>Platform</th>' : ''}<th>Type</th><th>Caption</th><th>When</th><th>Status</th><th></th></tr>
          ${rows.map((it) => `<tr>
            <td><span class="ag-thumb">${it.thumb ? `<img src="${esc(it.thumb)}" alt="" loading="lazy">` : it.video ? `<video src="${esc(it.video)}" muted preload="metadata"></video>` : ic(it.platform === 'linkedin' ? 'linkedin' : 'image')}</span></td>
            ${multi ? `<td><span class="cal-key">${pf(it)}${PLATFORMS[it.platform]}</span>${it.account ? `<div class="small muted">${esc(it.account)}</div>` : ''}</td>` : ''}
            <td>${esc(typeLabel(it))}${it.platform === 'instagram' && it.post.media.length > 1 ? ` · ${it.post.media.length}` : ''}</td>
            <td class="clip">${esc(String(it.caption || '').slice(0, 140))}${String(it.caption || '').length > 140 ? '…' : ''}</td>
            <td style="white-space:nowrap">${D.when(it.at)}</td>
            <td>${pill(it)}${it.error ? `<div class="small error">${esc(it.error)}</div>` : ''}</td>
            <td><div class="cal-actions">${editBtn(it)}${it.status !== 'publishing' ? `<button class="btn small danger" data-del="${it.kind}:${it.id}" type="button" aria-label="Delete">${ic('trash')}</button>` : ''}</div></td>
          </tr>`).join('')}</table></div>` : '<div class="empty">Nothing scheduled yet.</div>'}
      </section>`;
    bindHeader();
    bindPostActions(main);
    D.setRefresh(setInterval(() => D.visible() && !modalOpen() && run(views.posts)(), 30000));
  }
})();
