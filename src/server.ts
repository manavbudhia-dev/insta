import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { assertConfig, config } from './config.js';
import { api } from './api.js';
import { checkToken, isLoggedIn, login, logout, makeToken, requireLogin } from './auth.js';
import { db, log, redact } from './db.js';
import { authorizeUrl, exchangeCode, sealStoredToken, startWebhookWatch } from './instagram.js';
import { startFlowTimer } from './flows.js';
import { startPoller } from './poller.js';
import { startQueue, stopQueue } from './queue.js';
import { startScheduler } from './scheduler.js';
import { receiveWebhook, verifyWebhook } from './webhook.js';

assertConfig();

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = express();
app.set('trust proxy', 1); // behind Caddy
app.disable('x-powered-by');

// The dashboard loads only its own script; Google Fonts is the single outside dependency, and Instagram's CDN supplies thumbnails.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com", "img-src 'self' data: https:", "media-src 'self' https:",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const httpsSite = config.baseUrl.startsWith('https://');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (httpsSite) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // Dashboard data and login/OAuth responses must never be cached by the browser or a proxy.
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) res.setHeader('Cache-Control', 'no-store');
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
app.use('/media', express.static(path.join(config.dataDir, 'media'), {
  maxAge: '1h', index: false, dotfiles: 'deny',
  // Files here are only ever images or video; if anything else were served, it must not be able to run script.
  setHeaders: (res) => res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"),
}));

app.use(express.json({ limit: '1mb' }));

// Defence in depth on top of SameSite=Strict: a state-changing request from another site is refused outright.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try {
      const o = new URL(origin);
      ok = o.origin === new URL(config.baseUrl).origin || o.host === req.get('host');
    } catch {
      /* "null" or malformed origin */
    }
    if (!ok) {
      res.status(403).json({ error: 'Cross-site request blocked' });
      return;
    }
  }
  next();
});

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
    fail(redact((e as Error).message));
  }
});

app.use('/api', requireLogin, api);
app.use('/api', (_req, res) => void res.status(404).json({ error: 'Not found' }));

app.use(express.static(publicDir, { extensions: ['html'] }));

// Never leak stack traces or internals; oversized or malformed requests get a plain JSON answer.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  const status =
    err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE' ? 413
    : err?.type === 'entity.parse.failed' || err?.name === 'MulterError' ? 400
    : Number(err?.status) >= 400 && Number(err?.status) < 500 ? Number(err.status) : 500;
  if (status === 500) log('error', `Request failed: ${err?.message ?? err}`);
  res.status(status).json({ error: status === 500 ? 'Something went wrong' : status === 413 ? 'That is too large' : 'Bad request' });
});

sealStoredToken(); // encrypt a token that an older version saved as plain text
const server = app.listen(config.port, () => {
  console.log(`insta-automation listening on :${config.port} (public URL ${config.baseUrl})`);
  startQueue();
  startPoller();
  startScheduler();
  startFlowTimer();
  startWebhookWatch();
});

// A stray rejection should be logged, not take the whole worker down mid-send.
process.on('unhandledRejection', (e) => log('error', `Unhandled rejection: ${(e as Error)?.message ?? e}`));

// Docker stop / redeploy: finish the send in progress so it is not cut off after Instagram accepted it.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close();
  await stopQueue();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
