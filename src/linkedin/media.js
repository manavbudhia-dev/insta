import fs from 'node:fs';
import path from 'node:path';
import db, { MEDIA_DIR } from './db.js';

export const pathOf = (m) => path.join(MEDIA_DIR, m.file);
export const mediaIds = (post) => { try { return JSON.parse(post.media_json || '[]').map((x) => x.id); } catch { return []; } };

export function deleteMedia(ids) {
  for (const id of ids) {
    const m = db.prepare('select * from media where id=?').get(id);
    if (!m) continue;
    fs.rm(pathOf(m), { force: true }, () => {});
    db.prepare('delete from media where id=?').run(id);
  }
}
// Uploads that never made it into a post are removed after a day.
export function sweepOrphans() {
  for (const m of db.prepare('select id from media where post_id is null and created_at<?').all(Date.now() - 864e5)) deleteMedia([m.id]);
}
