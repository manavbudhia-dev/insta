import fs from 'node:fs';
import db, { tokenFor } from './db.js';
import { createPost, shareStats, uploadImage, uploadVideo, waitForVideo } from './linkedin.js';
import { checkExpiry } from './settings.js';
import { runAuto } from './autogen.js';
import { emitPosts } from './events.js';
import { pathOf, mediaIds, deleteMedia, sweepOrphans } from './media.js';

const MAX_ATTEMPTS = 3;
let busy = false, syncingStats = false, stopping = false;
export const stop = () => { stopping = true; };
export const isBusy = () => busy;

// Timers must never crash the server: Node exits on an unhandled rejection or an exception thrown from a timer.
const safe = (name, fn) => async () => { try { await fn(); } catch (e) { console.error(`${name} failed:`, e?.message || e); } };

export function start() {
  // A crash mid-request may or may not have posted. Never auto-repost; ask a human to check.
  db.prepare("update posts set status='failed', error='Server restarted while publishing. Check LinkedIn before retrying.' where status='publishing'").run();
  const tick = safe('Publishing', publishDue), stats = safe('Stats sync', refreshStats),
    expiry = safe('Expiry check', checkExpiry), sweep = safe('Media cleanup', async () => sweepOrphans()),
    auto = safe('Auto content', async () => { await runAuto(); emitPosts(); });
  setInterval(tick, 30_000);
  setInterval(stats, 60 * 60_000);
  setInterval(expiry, 60 * 60_000);
  setInterval(sweep, 6 * 60 * 60_000);
  // Auto content: look for empty slots every 30 minutes (does nothing unless switched on).
  setInterval(auto, 30 * 60_000);
  setTimeout(auto, 60_000);
  sweep(); expiry(); tick();
}

// Uploads any media that isn't on LinkedIn yet and returns the post's "content" block.
// Uploaded URNs are saved on the post, so a retry doesn't upload the same file twice.
async function buildContent(post, acc, token) {
  if (post.type === 'poll') {
    const p = JSON.parse(post.poll_json);
    return { poll: { question: p.question, options: p.options.map((text) => ({ text })), settings: { duration: p.duration } } };
  }
  if (post.type !== 'image' && post.type !== 'video') return undefined;

  const items = JSON.parse(post.media_json);
  for (const it of items) {
    if (it.urn) continue;
    const m = db.prepare('select * from media where id=?').get(it.id);
    if (!m || !fs.existsSync(pathOf(m))) throw new Error('The attached file is missing on the server. Delete this post and schedule it again.');
    it.urn = m.kind === 'video'
      ? await uploadVideo({ token, owner: acc.urn, file: pathOf(m), size: m.size })
      : await uploadImage({ token, owner: acc.urn, file: pathOf(m) });
    db.prepare('update posts set media_json=? where id=?').run(JSON.stringify(items), post.id);
  }
  if (post.type === 'video') {
    await waitForVideo({ token, urn: items[0].urn });
    return { media: { id: items[0].urn, ...(items[0].label ? { title: items[0].label } : {}) } };
  }
  const img = (i) => ({ id: i.urn, ...(i.label ? { altText: i.label } : {}) });
  return items.length === 1 ? { media: img(items[0]) } : { multiImage: { images: items.map(img) } };
}

async function publishDue() {
  if (busy || stopping) return;
  busy = true;
  try {
    const due = db.prepare("select id from posts where status='scheduled' and when_at<=? order by when_at").all(Date.now());
    for (const { id } of due) {
      if (stopping) break;
      // Atomic claim: two workers can never publish the same row.
      const claim = db.prepare("update posts set status='publishing', attempts=attempts+1 where id=? and status='scheduled'").run(id);
      if (!claim.changes) continue;
      emitPosts(); // card shows "Publishing…" right away
      try { await publishOne(id); }
      catch (e) { console.error(`Post ${id}:`, e?.message || e); } // one bad post must not stop the rest of the queue
      finally { emitPosts(); } // published / failed / retry-later
    }
  } finally { busy = false; }
}

async function publishOne(id) {
  const post = db.prepare('select * from posts where id=?').get(id);
  let urn = null;
  try {
    const acc = db.prepare('select * from accounts where id=?').get(post.account_id);
    if (!acc) throw Object.assign(new Error('Account was removed'), { auth: true });
    const token = tokenFor(acc);
    const content = await buildContent(post, acc, token);
    urn = await createPost({ token, author: acc.urn, text: post.text, content });
  } catch (e) {
    const retry = e.retryable && post.attempts < MAX_ATTEMPTS;
    // "and status='publishing'" so a later change by a person is never overwritten by a stale result.
    db.prepare("update posts set status=?, error=?, when_at=? where id=? and status='publishing'")
      .run(retry ? 'scheduled' : 'failed', String(e.message || e).slice(0, 500), retry ? Date.now() + post.attempts * 5 * 60_000 : post.when_at, id);
    return;
  }
  // From here on the post IS on LinkedIn. Nothing below may turn it back into "failed" (that invites a duplicate on retry).
  db.prepare("update posts set status='published', urn=?, published_at=?, error=null where id=?").run(urn || null, Date.now(), id);
  try { deleteMedia(mediaIds(post)); } catch (e) { console.error(`Post ${id}: media cleanup failed:`, e.message); }
}

async function refreshStats() {
  if (syncingStats) return; // hourly timer and the manual refresh button must not run together
  syncingStats = true;
  try {
    const rows = db.prepare(`select p.id, p.urn, a.urn as author, a.id as aid from posts p join accounts a on a.id=p.account_id
      where p.status='published' and a.kind='organization' and p.urn is not null and p.urn!=''`).all();
    for (const r of rows) {
      try {
        const acc = db.prepare('select * from accounts where id=?').get(r.aid);
        const s = await shareStats(tokenFor(acc), r.author, r.urn);
        if (s) db.prepare('update posts set impressions=?, clicks=?, likes=?, comments=?, shares=? where id=?')
          .run(s.impressionCount || 0, s.clickCount || 0, s.likeCount || 0, s.commentCount || 0, s.shareCount || 0, r.id);
      } catch { /* stats are best-effort */ }
    }
  } finally { syncingStats = false; }
}
export { publishDue, refreshStats };
