# DM Autopilot

A self-hosted Instagram DM automation and post scheduler for **your own** Instagram professional account.
It uses only the official Instagram API (Instagram Login), so it follows Meta's messaging rules by design.

## What it does

- **DM automations** – reply when a message contains a keyword, is an exact phrase, or is anything at all.
- **Comment → DM** – when someone comments a keyword on a post, send them one private DM and (optionally) a public reply.
- **Story replies and story mentions** – trigger a DM.
- **Welcome message** – greet someone the first time they ever message you.
- **Link buttons and quick replies** in DMs, `{{first_name}}` / `{{username}}` placeholders.
- **Inbox** – see every conversation, reply by hand, pause automation per person.
- **Human takeover** – if you answer from the Instagram app, automation goes quiet in that chat for a while.
- **Post scheduler** – photos, carousels, reels and stories, published at the time you pick.
- **Safety** – 24-hour window enforced, hourly send cap, per-person cooldowns, de-duplication, retry with backoff.

## Rules Meta enforces (and this app respects)

| Rule | What it means |
|---|---|
| Professional account | The Instagram account must be Business or Creator. |
| 24-hour window | You can DM someone only within 24 hours of their last message to you. |
| One DM per comment | A comment allows a single private reply, within 7 days. Further DMs need the person to reply. |
| No cold outreach | There is no way to message people who have not contacted you, and no broadcasts. |

---

## Setup

You need: a server with Docker, the domain `insta.zealcoder.in` pointing at it, and a Meta developer account.

### 1. Point the domain at the server

Add a DNS **A record**: `insta` → your Oracle server's public IP.

### 2. Open ports 80 and 443 on Oracle Cloud

Oracle blocks these in two places:

1. **Cloud console:** Networking → your VCN → Security List (or NSG) → add Ingress Rules for TCP **80** and **443** from `0.0.0.0/0`.
2. **On the server** (Oracle's Ubuntu images ship with iptables rules):

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
```

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
```

```bash
sudo netfilter-persistent save
```

### 3. Create the Meta app

Menu names in the Meta dashboard change from time to time; the items to find are the same.

1. Go to <https://developers.facebook.com/apps> → **Create app** → choose the Instagram use case (manage messaging and content) / app type **Business**.
2. In the app, open **Instagram → API setup with Instagram login**.
3. Copy the **Instagram app ID** and **Instagram app secret** – these go in `.env`.
4. Under **App roles → Roles**, add your Instagram account as an **Instagram Tester**, then accept the invite in Instagram
   (Settings → Apps and websites → Tester invites).
5. **Business login settings:** add the OAuth redirect URI
   `https://insta.zealcoder.in/auth/instagram/callback`
6. **App settings → Basic:** set the Privacy Policy URL to `https://insta.zealcoder.in/privacy`.

Leave the webhook step until the app is running (step 5 below), because Meta checks the URL immediately.

### 4. Deploy

Copy this folder to the server, then:

```bash
cp .env.example .env
```

Edit `.env`: set `ADMIN_PASSWORD`, `IG_APP_ID`, `IG_APP_SECRET`, and two random strings for
`SESSION_SECRET` and `WEBHOOK_VERIFY_TOKEN` (generate each one with):

```bash
openssl rand -hex 32
```

Start it:

```bash
docker compose up -d --build
```

Caddy fetches the HTTPS certificate automatically. Open <https://insta.zealcoder.in> and sign in with your `ADMIN_PASSWORD`.

### 5. Connect webhooks and your account

1. Meta dashboard → **Instagram → API setup with Instagram login → Configure webhooks**:
   - Callback URL: `https://insta.zealcoder.in/webhook`
   - Verify token: the `WEBHOOK_VERIFY_TOKEN` value from `.env`
   - Subscribe to **messages**, **messaging_postbacks** and **comments**.
2. Switch the app to **Live** mode (top of the Meta dashboard). Webhooks are not delivered in Development mode.
3. In the DM Autopilot dashboard, click **Connect with Instagram** and approve all permissions.
4. In the Instagram app: **Settings → Messages and story replies → Message controls → Connected tools → Allow access to messages** must be **on**.
5. Send your account a DM from a different account. The Overview page should show "Last webhook received just now".

### About comment triggers and App Review

Meta delivers **comment webhooks** only to apps with *Advanced Access*, which requires App Review.
You do not need it: DM Autopilot also checks for new comments through the API (allowed for your own account),
every 2 minutes by default. Comment-to-DM therefore works without review, with a delay of up to the check interval.
If you later obtain Advanced Access, comment webhooks start arriving and replies become instant; nothing needs changing.

DM, story reply and story mention triggers arrive by webhook and are instant.

---

## Day-to-day

| Task | Command |
|---|---|
| View logs | `docker compose logs -f app` |
| Restart | `docker compose restart app` |
| Update after changing code | `docker compose up -d --build` |
| Back up everything (database + uploaded media) | `docker run --rm -v insta-automation_appdata:/data -v "$PWD":/backup alpine tar czf /backup/backup.tgz -C /data .` |

The access token lasts 60 days and is refreshed automatically. If the server is off for more than ~45 days,
reconnect from the Overview page.

## Troubleshooting

- **"Rejected a webhook call with a missing or invalid signature"** in Activity: set `META_APP_SECRET`
  (App settings → Basic → App secret) in `.env` and restart. Meta signs with one of the two secrets depending on app setup.
- **No webhooks arriving:** app not in Live mode, account not subscribed (Overview → Re-subscribe webhooks),
  or "Allow access to messages" is off in the Instagram app.
- **Reply shows "skipped – outside the 24-hour window":** the person's last message is older than 24 hours. This is Meta's rule.
- **Scheduled post failed:** the media URL must be publicly reachable over HTTPS, images must be JPEG
  (uploads are converted for you), reels must be MP4/MOV. The error from Instagram is shown on the post.

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run dev
```

`npm test` boots the real server against a mock Instagram API and exercises webhooks, rules, the send queue,
comment polling, uploads and scheduled publishing. `npm run dev` needs a `.env` file.

Layout: `src/engine.ts` (rule matching), `src/queue.ts` (rate-limited sender), `src/webhook.ts`, `src/poller.ts`
(comment fallback), `src/scheduler.ts` (publishing, token refresh), `src/api.ts` (dashboard API), `public/` (dashboard).
