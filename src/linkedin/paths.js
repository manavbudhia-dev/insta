import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The LinkedIn scheduler lives inside the platform under this URL prefix.
export const PREFIX = '/linkedin';

// Its database, secrets.json and media folder sit in their own folder on the platform's data disk.
// LINKEDIN_DB_PATH (or the old DB_PATH) still wins, so an existing LinkedIn data folder can be pointed at directly.
export const DB_FILE = path.resolve(
  process.env.LINKEDIN_DB_PATH || process.env.DB_PATH || path.join(process.env.DATA_DIR || './data', 'linkedin', 'autopilot.db'),
);

// Works from both src/linkedin (tsx) and dist/linkedin (built): the pages are in <repo>/public/linkedin.
export const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'linkedin');
