import fs from 'node:fs';
import { currentVersion, linkedinCreds, linkedinScopes } from './settings.js';

const API = 'https://api.linkedin.com/rest';

// A LinkedIn call that never answers would otherwise hang forever and, with it, the publishing loop.
// Every request gets a deadline; uploads get longer because they move real data.
const API_MS = 30_000, UPLOAD_MS = 5 * 60_000;
const tfetch = (url, opts = {}, ms = API_MS) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) }).catch((e) => {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw Object.assign(new Error('LinkedIn did not answer in time. Trying again shortly.'), { retryable: true, timeout: true });
  throw e;
});

// Credentials and scopes are read per request, so changes in Settings apply immediately.
export const authUrl = (state, redirectUri) =>
  'https://www.linkedin.com/oauth/v2/authorization?' +
  new URLSearchParams({ response_type: 'code', client_id: linkedinCreds().id, redirect_uri: redirectUri, state, scope: linkedinScopes() });

async function check(res) {
  if (res.ok) return res;
  const body = await res.text();
  const err = new Error(`LinkedIn ${res.status}: ${body.slice(0, 300)}`);
  err.status = res.status;
  err.auth = res.status === 401 || res.status === 403;
  err.retryable = res.status === 429 || res.status >= 500;
  // LinkedIn answers 426 NONEXISTENT_VERSION once a version has been retired.
  if (res.status === 426 || body.includes('NONEXISTENT_VERSION')) {
    err.message = `LinkedIn no longer accepts API version ${currentVersion()}. An admin needs to update it in Settings.`;
    err.retryable = false;
  }
  throw err;
}

export async function exchangeCode(code, redirectUri) {
  const { id, secret } = linkedinCreds();
  const res = await check(await tfetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: id, client_secret: secret })
  }));
  return res.json(); // { access_token, expires_in, scope }
}

export async function userInfo(token) {
  const res = await check(await tfetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${token}` } }));
  return res.json(); // { sub, name, ... }
}

// Read per request so a version changed in Settings applies immediately, no restart.
const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Linkedin-Version': currentVersion(),
  'X-Restli-Protocol-Version': '2.0.0',
  'Content-Type': 'application/json'
});

// Post text uses LinkedIn's "little text" format: these characters must be escaped or the post is cut short.
// "#" is left alone so hashtags keep working.
export const escapeText = (t) => t.replace(/[\\|{}@\[\]()<>*_~]/g, (c) => '\\' + c);

export async function createPost({ token, author, text, content }) {
  const res = await check(await tfetch(`${API}/posts`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      author, commentary: escapeText(text), visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(content ? { content } : {}),
      lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false
    })
  }).catch((e) => {
    // LinkedIn may have created the post before the connection dropped. Retrying could publish it twice.
    if (e.timeout) throw Object.assign(new Error('LinkedIn did not confirm the post in time. Check LinkedIn before retrying.'), { retryable: false });
    throw e;
  }));
  return res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id') || ''; // post URN
}

/* ---- Media ---- */
async function initializeUpload(resource, token, body) {
  const res = await check(await tfetch(`${API}/${resource}?action=initializeUpload`, {
    method: 'POST', headers: headers(token), body: JSON.stringify({ initializeUploadRequest: body })
  }));
  return (await res.json()).value;
}

// Returns the image URN to reference in the post.
export async function uploadImage({ token, owner, file }) {
  const v = await initializeUpload('images', token, { owner });
  await check(await tfetch(v.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: await fs.promises.readFile(file) }, UPLOAD_MS));
  return v.image;
}

// Videos upload in parts (about 4 MB each), then get finalized with the parts' ETags.
export async function uploadVideo({ token, owner, file, size }) {
  const v = await initializeUpload('videos', token, { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false });
  const fh = await fs.promises.open(file, 'r');
  const etags = [];
  try {
    for (const part of v.uploadInstructions) {
      const len = part.lastByte - part.firstByte + 1;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, part.firstByte);
      if (bytesRead !== len) throw new Error('Video file is shorter than expected. Upload it again.');
      const res = await check(await tfetch(part.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buf }, UPLOAD_MS));
      etags.push(res.headers.get('etag'));
    }
  } finally { await fh.close(); }
  await check(await tfetch(`${API}/videos?action=finalizeUpload`, {
    method: 'POST', headers: headers(token),
    body: JSON.stringify({ finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken || '', uploadedPartIds: etags } })
  }));
  return v.video;
}

// LinkedIn transcodes videos after upload. If it takes long, the scheduler retries later instead of blocking.
export async function waitForVideo({ token, urn, timeoutMs = 180_000 }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await check(await tfetch(`${API}/videos/${encodeURIComponent(urn)}`, { headers: headers(token) }));
    const { status } = await res.json();
    if (status === 'AVAILABLE') return;
    if (status === 'PROCESSING_FAILED') throw new Error('LinkedIn could not process the video. Try exporting it again as H.264 MP4.');
    if (Date.now() > end) throw Object.assign(new Error('LinkedIn is still processing the video. Trying again shortly.'), { retryable: true });
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// Organization pages only (needs r_organization_social). Personal-profile analytics are restricted by LinkedIn.
export async function shareStats(token, orgUrn, postUrn) {
  const param = postUrn.includes('ugcPost') ? 'ugcPosts' : 'shares';
  const url = `${API}/organizationalEntityShareStatistics?q=organizationalEntity` +
    `&organizationalEntity=${encodeURIComponent(orgUrn)}&${param}=List(${encodeURIComponent(postUrn)})`;
  const data = await (await check(await tfetch(url, { headers: headers(token) }))).json();
  return (data.elements && data.elements[0] && data.elements[0].totalShareStatistics) || null;
}
