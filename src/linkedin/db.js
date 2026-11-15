import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { open } from './crypto.js';
import { DB_FILE } from './paths.js';

const file = DB_FILE;
fs.mkdirSync(path.dirname(file), { recursive: true });
// Uploaded images/videos wait here until their post publishes. Lives next to the database so it sits on the same persistent disk.
export const MEDIA_DIR = path.join(path.dirname(path.resolve(file)), 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const db = new Database(file);
db.pragma('journal_mode = WAL');
db.exec(`
create table if not exists users(
  id integer primary key, email text unique not null, name text, hash text not null, role text not null default 'editor');
create table if not exists accounts(
  id integer primary key, name text, kind text not null, urn text unique not null,
  token text, expires_at integer, token_from integer, created_by integer);
create table if not exists posts(
  id integer primary key, account_id integer not null, text text not null, when_at integer not null,
  status text not null default 'scheduled', attempts integer not null default 0, error text, urn text,
  created_by integer, created_at integer, published_at integer,
  impressions integer default 0, clicks integer default 0, likes integer default 0, comments integer default 0, shares integer default 0);
create index if not exists posts_due on posts(status, when_at);
create table if not exists settings(key text primary key, value text not null);
create table if not exists media(
  id integer primary key, file text not null, kind text not null, mime text not null, name text, size integer,
  post_id integer, created_by integer, created_at integer);
`);

// Lightweight migrations so existing databases upgrade in place.
function addColumn(table, col, def) {
  if (!db.prepare(`pragma table_info(${table})`).all().some((r) => r.name === col)) db.exec(`alter table ${table} add column ${col} ${def}`);
}
addColumn('posts', 'type', "text not null default 'text'"); // text | image | video | poll
addColumn('posts', 'media_json', 'text');                    // [{id, label, urn?}]
addColumn('posts', 'poll_json', 'text');                     // {question, options[], duration}
addColumn('posts', 'updated_at', 'integer');                   // last edit; drafts show it as "last edited"
addColumn('posts', 'ai', 'integer not null default 0');                // 1 = written by Auto content
addColumn('users', 'created_at', 'integer');                  // shown as "Added on" in Accounts
addColumn('accounts', 'notified', 'text');                   // last reminder sent, "<expires_at>:<soon|expired>"

// Organization accounts borrow the token of a member who administers the page.
export function tokenFor(acc) {
  const src = acc.token_from ? db.prepare('select * from accounts where id=?').get(acc.token_from) : acc;
  if (!src || !src.token) throw Object.assign(new Error('Account is not connected'), { auth: true });
  if (src.expires_at && src.expires_at < Date.now()) throw Object.assign(new Error('LinkedIn connection expired. Reconnect the account.'), { auth: true });
  return open(src.token);
}
export default db;
