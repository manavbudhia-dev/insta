import { db, log, prune } from './db.js';
import { acct, checkTokenExpiry, connected, ig, type IgError } from './instagram.js';

export interface PostMedia {
  url: string;
  kind: 'image' | 'video';
}
interface Post {
  id: number;
  type: 'IMAGE' | 'REELS' | 'STORIES' | 'CAROUSEL';
  caption: string;
  media: string;
  scheduled_at: number;
  status: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = Number(process.env.CONTAINER_POLL_MS ?? 15_000);

/** Wait for Instagram to finish downloading and processing a media container. */
async function waitUntilReady(containerId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const s = await ig.get<{ status_code?: string; status?: string }>(`/${containerId}`, { fields: 'status_code,status' });
    if (s.status_code === 'FINISHED' || s.status_code === 'PUBLISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
      throw new Error(`Instagram could not process the media (${s.status ?? s.status_code})`);
    }
    await sleep(POLL_MS);
  }
  throw new Error('Timed out waiting for Instagram to process the media');
}

async function createContainer(params: Record<string, string | boolean>): Promise<string> {
  const r = await ig.post<{ id: string }>(`${acct()}/media`, params);
  return r.id;
}

export async function publish(post: Post): Promise<string> {
  const media: PostMedia[] = JSON.parse(post.media);
  if (!media.length) throw new Error('Post has no media');
  let containerId: string;

  if (post.type === 'CAROUSEL') {
    if (media.length < 2) throw new Error('A carousel needs at least 2 items');
    const children: string[] = [];
    for (const m of media.slice(0, 20)) {
      const id = await createContainer(
        m.kind === 'video'
          ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: true }
          : { image_url: m.url, is_carousel_item: true },
      );
      if (m.kind === 'video') await waitUntilReady(id);
      children.push(id);
    }
    containerId = await createContainer({ media_type: 'CAROUSEL', children: children.join(','), caption: post.caption });
  } else if (post.type === 'REELS') {
    if (media[0].kind !== 'video') throw new Error('A reel needs a video file');
    containerId = await createContainer({ media_type: 'REELS', video_url: media[0].url, caption: post.caption });
  } else if (post.type === 'STORIES') {
    containerId = await createContainer(
      media[0].kind === 'video'
        ? { media_type: 'STORIES', video_url: media[0].url }
        : { media_type: 'STORIES', image_url: media[0].url },
    );
  } else {
    if (media[0].kind !== 'image') throw new Error('An image post needs an image file');
    containerId = await createContainer({ image_url: media[0].url, caption: post.caption });
  }

  await waitUntilReady(containerId);
  return publishContainer(containerId, post.caption);
}

const PUBLISH_RETRY_MS = Number(process.env.PUBLISH_RETRY_MS ?? 5_000);

/**
 * A container can only be published once, so retrying media_publish is safe: if an earlier attempt that looked
 * like a failure (timeout, reset) actually went through, Instagram refuses the second one. Before every retry the
 * container is checked, so a post that did publish is recorded as published instead of failed.
 * Returns '' when the post is live but its media id could not be found (e.g. stories).
 */
async function publishContainer(containerId: string, caption: string): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(PUBLISH_RETRY_MS * attempt);
    try {
      return (await ig.post<{ id: string }>(`${acct()}/media_publish`, { creation_id: containerId })).id;
    } catch (e) {
      last = e;
      const status = await ig.get<{ status_code?: string }>(`/${containerId}`, { fields: 'status_code' }).catch(() => null);
      if (status?.status_code === 'PUBLISHED') return findPublishedId(caption);
      const err = e as IgError;
      if (!err.ambiguous && !err.transient) throw e;
    }
  }
  throw last;
}

/** Match on caption so another recent post is never mistaken for this one; with no caption nothing is stored. */
async function findPublishedId(caption: string): Promise<string> {
  if (!caption.trim()) return '';
  try {
    const r = await ig.get<{ data?: { id: string; caption?: string; timestamp?: string }[] }>(`${acct()}/media`, { fields: 'id,caption,timestamp', limit: 5 });
    const hit = (r.data ?? []).find((m) => m.caption === caption && m.timestamp && Date.now() - Date.parse(m.timestamp) < 15 * 60_000);
    return hit?.id ?? '';
  } catch {
    return '';
  }
}

async function runPost(post: Post): Promise<void> {
  // Claim the row first so a slow publish can never be picked up twice.
  const claimed = db.prepare("UPDATE posts SET status = 'publishing', started_at = ?, error = NULL WHERE id = ? AND status = 'scheduled'").run(Date.now(), post.id);
  if (!claimed.changes) return;
  try {
    const id = await publish(post);
    db.prepare("UPDATE posts SET status = 'published', ig_media_id = ?, published_at = ? WHERE id = ?").run(id || null, Date.now(), post.id);
    log('info', `Published scheduled ${post.type.toLowerCase()} post #${post.id}`);
  } catch (e) {
    db.prepare("UPDATE posts SET status = 'failed', error = ? WHERE id = ?").run((e as Error).message, post.id);
    log('error', `Scheduled post #${post.id} failed: ${(e as Error).message}`);
  }
}

function tick(): void {
  if (!connected()) return;
  const due = db.prepare("SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 3").all(Date.now()) as Post[];
  for (const p of due) void runPost(p);
}

export function startScheduler(): void {
  // A post interrupted by a restart is marked failed rather than retried, so it can never publish twice.
  const stuck = db.prepare("UPDATE posts SET status = 'failed', error = 'Interrupted by a server restart — check Instagram, then retry if it did not publish' WHERE status = 'publishing'").run();
  if (stuck.changes) log('warn', `${stuck.changes} post(s) were interrupted mid-publish and marked failed`);

  setInterval(tick, Number(process.env.SCHEDULER_TICK_MS ?? 20_000)).unref();
  const daily = () => {
    checkTokenExpiry();
    prune();
  };
  setTimeout(daily, 10_000).unref();
  setInterval(daily, 12 * 3600_000).unref();
}
