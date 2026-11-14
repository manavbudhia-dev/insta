import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { assertConfig, config } from './config.js';
import { api } from './api.js';
import { checkToken, isLoggedIn, login, logout, makeToken, requireLogin } from './auth.js';
import { log } from './db.js';
import { authorizeUrl, exchangeCode } from './instagram.js';
import { startPoller } from './poller.js';
import { startQueue } from './queue.js';
import { startScheduler } from './scheduler.js';
import { receiveWebhook, verifyWebhook } from './webhook.js';

assertConfig();

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = express();
app.set('trust proxy', 1); // behind Caddy
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.get('/healthz', (_req, res) => void res.json({ ok: true }));

// Webhook: the raw body is kept so the signature can be verified byte-for-byte.
app.get('/webhook', verifyWebhook);
app.post(
  '/webhook',
  express.json({ limit: '2mb', verify: (req, _res, buf) => void ((req as any).rawBody = buf) }),
  receiveWebhook,
);

// Uploaded media must be publicly reachable: Instagram downloads it when a post is published.
app.use('/media', express.static(path.join(config.dataDir, 'media'), { maxAge: '1h', index: false, dotfiles: 'deny' }));

app.use(express.json({ limit: '1mb' }));

app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/session', (req, res) => void res.json({ loggedIn: isLoggedIn(req) }));

// Instagram OAuth. The state is a signed, short-lived token minted only for a signed-in admin,
// so the callback (a cross-site redirect that carries no session cookie) is still protected.
app.get('/auth/instagram', requireLogin, (_req, res) => {
  if (!config.metaAppId || !config.metaAppSecret || !config.metaConfigId) {
    res.status(400).send('Set META_APP_ID, META_APP_SECRET and META_CONFIG_ID in .env first.');
    return;
  }
  res.redirect(authorizeUrl(makeToken('oauth', 10 * 60_000)));
});
app.get('/auth/instagram/callback', async (req, res) => {
  const fail = (msg: string) => res.redirect(`/?error=${encodeURIComponent(msg)}`);
  if (req.query.error) return fail(String(req.query.error_description ?? req.query.error));
  if (!checkToken('oauth', String(req.query.state ?? ''))) return fail('Login link expired — please try connecting again');
  try {
    await exchangeCode(String(req.query.code ?? ''));
    res.redirect('/?connected=1');
  } catch (e) {
    log('error', `Instagram connect failed: ${(e as Error).message}`);
    fail((e as Error).message);
  }
});

app.use('/api', requireLogin, api);
app.use('/api', (_req, res) => void res.status(404).json({ error: 'Not found' }));

app.use(express.static(publicDir, { extensions: ['html'] }));

app.listen(config.port, () => {
  console.log(`insta-automation listening on :${config.port} (public URL ${config.baseUrl})`);
  startQueue();
  startPoller();
  startScheduler();
});
