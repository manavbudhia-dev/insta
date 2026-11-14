import { db, firstTime, getNum, getSetting, log, opt, setSetting } from './db.js';
import { handleComment } from './engine.js';
import { acct, connected, ig, IgError } from './instagram.js';

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

const RESCAN_MS = Number(process.env.COMMENT_RESCAN_MS ?? 10 * 60_000);

/** The background loop and the dashboard's refresh button share one run instead of doubling the API calls. */
let current: Promise<void> | null = null;
export function pollOnce(): Promise<void> {
  return (current ??= pollNow().finally(() => {
    current = null;
  }));
}

async function pollNow(): Promise<void> {
  const media = await refreshMedia();
  const connectedAt = getNum('connected_at', Date.now());
  let firstError: unknown;
  for (const m of media) {
    try {
      const cached = db.prepare('SELECT comments_count, comments_polled_at FROM media_cache WHERE id = ?').get(m.id) as
        { comments_count: number; comments_polled_at: number } | undefined;
      const count = m.comments_count ?? 0;
      const changed = !cached ? count > 0 : count !== cached.comments_count;
      // The count alone can miss comments (one deleted + one added leaves it unchanged), so a post that is still
      // young enough for private replies is also re-read every few minutes. Older posts rely on the count.
      const ts = m.timestamp ? Date.parse(m.timestamp) : 0;
      const recent = ts > 0 && Date.now() - ts < 7 * 86400_000 && count > 0;
      const due = recent && Date.now() - (cached?.comments_polled_at ?? 0) > RESCAN_MS;
      let polled = false;
      if ((changed || due) && opt('poll_comments')) {
        await pollComments(m.id, connectedAt);
        polled = true;
      }
      upsertMedia.run({
        id: m.id, caption: m.caption ?? '', permalink: m.permalink ?? '', media_type: m.media_type ?? '',
        thumbnail: m.thumbnail_url ?? (m.media_type === 'VIDEO' ? '' : m.media_url ?? ''),
        comments_count: count, timestamp: m.timestamp ? Date.parse(m.timestamp) : null, updated_at: Date.now(),
      });
      if (polled) db.prepare('UPDATE media_cache SET comments_polled_at = ? WHERE id = ?').run(Date.now(), m.id);
    } catch (e) {
      // One post that errors must not starve the others. Its cache row is left alone so it is retried next round.
      firstError ??= e;
    }
  }
  if (firstError) throw firstError;
}

/** Some API setups reject the `from` field; learn that once and stop asking for it. */
let withFrom = true;

async function fetchComments(mediaId: string): Promise<any> {
  const fields = (withFrom ? 'id,text,timestamp,username,from,parent_id' : 'id,text,timestamp,username,parent_id');
  try {
    return await ig.get(`/${mediaId}/comments`, { fields, limit: 50 });
  } catch (e) {
    if (withFrom && (e as IgError).code === 100) {
      withFrom = false;
      log('warn', 'Comments API rejected the "from" field; continuing without it');
      return fetchComments(mediaId);
    }
    throw e;
  }
}

async function pollComments(mediaId: string, connectedAt: number): Promise<void> {
  let next: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res: any = next
      ? await ig.next(next)
      : await fetchComments(mediaId);
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
