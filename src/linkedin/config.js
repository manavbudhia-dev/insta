import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DB_FILE } from './paths.js';

// The two secrets the app needs before anything else starts.
// If they are set in the environment, those win. Otherwise they are generated once and
// kept on the data disk next to the database, so nothing secret ever has to live in git.
const dbFile = DB_FILE;
const dir = path.dirname(dbFile);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'secrets.json');

let saved = {};
try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) {
  // Only a missing file means "first boot". A damaged file must stop the server: quietly generating a new
  // ENCRYPTION_KEY would make every saved LinkedIn login unreadable.
  if (e.code !== 'ENOENT') throw new Error(`Cannot read ${file} (${e.message}). Restore it from a backup; it is not safe to start without it.`);
  if (fs.existsSync(dbFile) && !process.env.LINKEDIN_ENCRYPTION_KEY)
    console.warn(`\n  WARNING: a database exists but ${file} does not. New secrets will be generated and saved LinkedIn logins will need to be reconnected.\n`);
}
let changed = false;
// Inside the platform these are exposed as LINKEDIN_SESSION_SECRET / LINKEDIN_ENCRYPTION_KEY, so they never clash with
// the platform's own SESSION_SECRET. The names inside secrets.json are unchanged, so an old LinkedIn data folder still works.
for (const k of ['SESSION_SECRET', 'ENCRYPTION_KEY']) {
  const envName = `LINKEDIN_${k}`;
  if (process.env[envName]) continue;
  if (!saved[k]) { saved[k] = randomBytes(32).toString('hex'); changed = true; }
  process.env[envName] = saved[k];
}
if (changed) {
  // Write to a temp file and rename, so a crash can never leave a half-written secrets.json behind.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
