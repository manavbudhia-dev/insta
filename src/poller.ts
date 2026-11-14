import { db, firstTime, getNum, getSetting, log, opt, setSetting } from './db.js';
import { handleComment } from './engine.js';
import { acct, connected, ig } from './instagram.js';

/**
 * Comment webhooks need Advanced Access (App Review). Until the app has that, this poller
 * reads comments through the API instead, which Standard Access allows for your own account.
 * It only fetches a post's comments when its comment count has changed, to stay well inside rate limits.
 */

interface Media {
  id: string;
  caption?: string;
  permalink?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  comments_count?: number;
  timestamp?: string;
}

export async function refreshMedia(limit = opt('poll_media_count')): Promise<Media[]> {
  const res = await ig.get<{ data: Media[] }>(`${acct()}/media`, {
    fields: 'id,caption,permalink,media_type,media_url,thumbnail_url,comments_count,timestamp',
    limit: Math.max(1, Math.min(50, limit)),
  });
  return res.data ?? [];
}

const upsertMedia = db.prepare(`
  INSERT INTO media_cache (id, caption, permalink, media_type, thumbnail, comments_count, timestamp, updated_at)
  VALUES (@id, @caption, @permalink, @media_type, @thumbnail, @comments_count, @timestamp, @updated_at)
  ON CONFLICT(id) DO UPDATE SET caption = excluded.caption, permalink = excluded.permalink, media_type = excluded.media_type,
    thumbnail = excluded.thumbnail, comments_count = excluded.comments_count, timestamp = excluded.timestamp, updated_at = excluded.updated_at
`);

export async function pollOnce(): Promise<void> {
  const media = await refreshMedia();
  const connectedAt = getNum('connected_at', Date.now());
  for (const m of media) {
    const cached = db.prepare('SELECT comments_count FROM media_cache WHERE id = ?').get(m.id) as { comments_count: number } | undefined;
    const count = m.comments_count ?? 0;
    const changed = !cached ? count > 0 : count !== cached.comments_count;
    if (changed && opt('poll_comments')) {
      await pollComments(m.id, connectedAt);
    }
    upsertMedia.run({
      id: m.id, caption: m.caption ?? '', permalink: m.permalink ?? '', media_type: m.media_type ?? '',
      thumbnail: m.thumbnail_url ?? (m.media_type === 'VIDEO' ? '' : m.media_url ?? ''),
      comments_count: count, timestamp: m.timestamp ? Date.parse(m.timestamp) : null, updated_at: Date.now(),
    });
  }
}

async function pollComments(mediaId: string, connectedAt: number): Promise<void> {
  let next: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res: any = next
      ? await ig.next(next)
      : await ig.get(`/${mediaId}/comments`, { fields: 'id,text,timestamp,username,from,parent_id', limit: 50 });
    for (const c of res.data ?? []) {
      const ts = c.timestamp ? Date.parse(c.timestamp) : Date.now();
      // Never act on comments made before the account was connected, or too old for a private reply.
      if (ts < connectedAt || Date.now() - ts > 7 * 86400_000) {
        firstTime(`comment:${c.id}`);
        continue;
      }
      handleComment({ ...c, mediaId });
    }
    next = res.paging?.next;
    if (!next) break;
  }
}

let timer: NodeJS.Timeout | undefined;
let running = false;

async function loop(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (connected()) {
      await pollOnce();
      setSetting('last_poll_at', Date.now());
      setSetting('last_poll_error', '');
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (getSetting('last_poll_error') !== msg) log('warn', `Comment polling failed: ${msg}`);
    setSetting('last_poll_error', msg);
  } finally {
    running = false;
    timer = setTimeout(loop, Math.max(30, opt('poll_interval_sec')) * 1000);
    timer.unref();
  }
}

export function startPoller(): void {
  timer = setTimeout(loop, 5000);
  timer.unref();
}
