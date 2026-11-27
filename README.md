# DM Autopilot + LinkedIn Autopilot

One self-hosted platform, one login, one deploy:

- **Instagram** (`/`): DM automation, flows, inbox, content calendar and insights for **your own** Instagram professional
  account, using only the official Instagram API with Unified Login (Meta's current setup).
- **LinkedIn** (`/linkedin/`): schedule text, image, video and poll posts to LinkedIn profiles and company pages through
  LinkedIn's official Posts API, with a queue, analytics, team members and optional AI-written drafts.
  See [LinkedIn scheduler](#linkedin-scheduler).
- **WhatsApp** (`/whatsapp/`): auto-replies with quick-reply buttons, a shared inbox, template broadcasts with delivery
  stats, STOP/START opt-out, and n8n in both directions, through Meta's official WhatsApp Cloud API.
  See [WhatsApp automation](#whatsapp-automation).

Sign in once with `ADMIN_PASSWORD` on the **home page** (`/`). It shows one card per mini app with live numbers, the
content calendar for Instagram and LinkedIn, a "Needs attention" list and the next scheduled posts on all platforms:

| Mini app | Address | What's in it |
|---|---|---|
| Instagram DM Automation | `/dm/` | Overview, automations, flows, inbox, insights, activity, settings |
| Instagram Scheduler | `/scheduler/` | Instagram content calendar and insights |
| LinkedIn Scheduler | `/linkedin/` | Schedule, queue, analytics, accounts, auto content, settings |
| WhatsApp Automation | `/whatsapp/` | Overview, inbox, auto-replies, broadcasts, templates, activity, settings |

Every mini app has **All apps** to go back home. Old links such as `/#inbox` still work and open the right mini app.

## Quick start (one command)

```bash
node scripts/setup.mjs         # makes your secrets and prints exactly what to paste into Nimbuz and Meta
node scripts/setup.mjs check   # after deploying: tests the live app and lists what is still missing
```

The Meta dashboard steps (create the app, the login configuration, accept the tester invite, switch to Live)
cannot be automated: Meta only allows them by hand. The script tells you every value to paste.

## What it does

- **DM automations** – reply when a message contains a keyword, is an exact phrase, or is anything at all.
- **Comment → DM** – when someone comments a keyword on a post, send them one private DM and (optionally) a public reply.
- **Story replies and story mentions** – trigger a DM.
- **Welcome message** – greet someone the first time they ever message you.
- **Link buttons and quick replies** in DMs, `{{first_name}}` / `{{username}}` placeholders.
- **Visual flow builder** – drag-and-drop multi-step conversations on a canvas (see [Flows](#flows)).
- **Inbox** – see every conversation, reply by hand, pause automation per person.
- **Human takeover** – if you answer from the Instagram app, automation goes quiet in that chat for a while.
- **Content calendar** – plan photos, carousels, reels and stories on a monthly calendar; drag a post to another day to move it.
- **Insights** – conversation and automation metrics, best time to post, follower growth and post performance.
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

### 3. Create the Meta app (Instagram API with Unified Login)

Meta's current setup is **Unified Login**; newly created apps can no longer use the older "Instagram Login".
Menu names in the Meta dashboard change from time to time; the items to find are the same.

Before you start, you need:

- A **business portfolio** at <https://business.facebook.com> (free). The app must be owned by one, and your
  Instagram professional account must belong to one. Without it the *API setup with Unified login* tab does not appear.
- Your Instagram account switched to **Business** or **Creator**.

Then:

1. Go to <https://developers.facebook.com/apps> → **Create app** → use case **Manage messaging & content on Instagram**,
   and attach it to your business portfolio.
2. Open **Use cases → Manage messaging & content on Instagram → Customize → API setup with Unified login**.
3. **Configure your app → Create new configuration.** Keep these permissions: `instagram_basic`,
   `instagram_manage_messages`, `instagram_manage_comments`, `instagram_content_publish`, and add
   `instagram_manage_insights` (for reach and views on the Insights page) with **Edit permissions**
   (you can remove the two ads permissions). Choose a token that **never expires** if offered.
   Select **Use this configuration**.
4. Under **Redirect URL** enter `https://insta.zealcoder.in/auth/instagram/callback` and save.
5. Copy the **configuration ID** (the `config_id` value inside the Login URL) → `META_CONFIG_ID` in `.env`.
6. **App settings → Basic:** copy **App ID** and **App secret** → `META_APP_ID` and `META_APP_SECRET`.
   Set the Privacy Policy URL to `https://insta.zealcoder.in/privacy`.
7. **Generate access tokens → Add account:** invite your Instagram account as an **Instagram Tester**, then accept in
   Instagram on the web (Settings → Website permissions → Apps and websites → Tester Invites).

Leave the webhook step until the app is running (step 5 below), because Meta checks the URL immediately.

### 4. Deploy

Copy this folder to the server, then:

```bash
cp .env.example .env
```

Edit `.env`: set `ADMIN_PASSWORD`, `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`, and two random strings for
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

1. Meta dashboard → **API setup with Unified login → Configure webhooks** (this is the **Instagram** object under
   your Meta app's Webhooks):
   - Callback URL: `https://insta.zealcoder.in/webhook`
   - Verify token: the `WEBHOOK_VERIFY_TOKEN` value from `.env`
   - Subscribe to **messages**, **messaging_postbacks** and **comments**.
2. Switch the app to **Live** mode (top of the Meta dashboard). Webhooks are not delivered in Development mode.
3. In the DM Autopilot dashboard, click **Connect Instagram account**. Sign in with Instagram or Facebook, choose your
   business portfolio, tick your Instagram account, and approve the permissions.
   (Alternative: paste the token from *Generate access tokens* into the dashboard.)
   The app then subscribes your account to webhooks by itself. It re-checks with Meta every 30 minutes and re-subscribes
   automatically if Meta ever drops it, so there is nothing to click. Only step 1 has to be done by hand: Meta allows
   the callback URL to be set only in its dashboard. The checklist reads those settings back and tells you if anything there is wrong.
4. If you signed in with Facebook, turn on **Allow access to messages** in the Instagram app:
   Settings → Messages and story replies → Message controls → Connected tools. (Signing in with Instagram asks for this during login.)
5. Send your account a DM from a different account. Open the Setup checklist on Overview: "Webhooks set up in Meta" turns green and Recent Activity lists the DM.

### About comment triggers and App Review

Meta delivers **comment webhooks** only to apps with *Advanced Access*, which requires App Review.
You do not need it: DM Autopilot also checks for new comments through the API (allowed for your own account),
every 2 minutes by default. Comment-to-DM therefore works without review, with a delay of up to the check interval.
If you later obtain Advanced Access, comment webhooks start arriving and replies become instant; nothing needs changing.

DM, story reply and story mention triggers arrive by webhook and are instant.

### Clients on their own subdomains (one command each)

To run DM Autopilot for clients, each client gets a separate instance (own container, own SQLite data, own login,
own HTTPS subdomain) next to yours. On the server, in the app folder:

```bash
scripts/client.sh add kalyanakuri kalyanakuri.in   # -> https://kalyanakuri.zealcoder.in + a generated password
scripts/client.sh list
scripts/client.sh password kalyanakuri
scripts/client.sh remove kalyanakuri [--purge]
```

Once, before the first client: add a wildcard DNS record `*.zealcoder.in` (A record) pointing at the server. The
root domain is taken from `BASE_URL` (`insta.zealcoder.in` -> `zealcoder.in`); set `CLIENT_ROOT_DOMAIN` in `.env` to
override it.

How it fits together:

- Meta sends every account's webhooks to the one callback URL of the Meta app, so the Meta dashboard keeps pointing
  at the main instance. The main instance verifies the signature and passes the raw webhook on, unchanged, to the
  client instances (`clients/shared/forward.json`). Each client checks the signature again and acts only on its own
  account; an instance with no account connected stores nothing.
- Each client instance is locked to one Instagram account (`IG_ACCOUNT_LOCK`), so a system user token that can reach
  several clients' accounts still only ever shows that client's account there.
- Connecting a client without App Review: the client shares their Instagram account with your business portfolio
  (Meta Business Settings -> Partners), you assign it to your system user and connect it in the client's dashboard.
  Serving accounts you do not manage through a self-serve login needs Advanced Access (App Review and Business
  Verification).
- Generated files (`docker-compose.clients.yml`, `clients/`) stay on the server and out of git. The deploy workflow
  starts the client instances too, with the same image.

### One-click n8n setup

Settings → **One-click n8n setup** builds the n8n side for you: paste the n8n address, an n8n API key and a Google Sheet
link, press **Connect n8n**. The app then, through n8n's public API:

1. checks the key, and finds the Google Sheets credential in n8n (`GET /api/v1/credentials`);
2. creates the **DM Autopilot → Leads Sheet** workflow (Webhook → only new DMs/comments → append to the `Leads` tab), or
   updates the same one on later runs, with a random webhook path so nobody can guess the URL;
3. publishes it (`POST /api/v1/workflows/{id}/activate`), saves its Production URL as the outgoing webhook and sends a
   test event.

Once per n8n, by hand: create the API key (n8n → Settings → n8n API) and connect Google (n8n → Credentials → Google
Sheets OAuth2; self-hosted n8n needs an OAuth client from Google Cloud with the Sheets and Drive APIs enabled and
`https://<your-n8n>/rest/oauth2-credential/callback` as redirect URI). If no Google credential exists yet, the workflow is
created unpublished and the card says so; press **Update n8n setup** after connecting Google. The API key is stored
encrypted and never sent back to the browser.

### Send events to n8n (outgoing webhook)

DM Autopilot does the Instagram side (rules, flows, replies). To send leads on to Google Sheets, a CRM, WhatsApp or
anything else, let it tell n8n what happens:

1. In n8n add a **Webhook** node: method `POST`, respond *Immediately*. Activate the workflow and copy its **Production URL**.
2. In DM Autopilot → **Settings → Send events to n8n**, paste the URL, pick the events and **Save webhook**, then
   **Send test event**. The card shows the last delivery and whether n8n accepted it.

Events: `message.received` (DM, story reply or mention), `comment.received`, `reply.sent` (automated or manual) and
`reply.failed`. Each is one JSON POST (Zapier and Make work the same way):

```json
{
  "event": "message.received",
  "delivery": "2f1c…",
  "created_at": "2026-11-27T06:45:00.000Z",
  "account": { "id": "1784…", "username": "myshop" },
  "data": {
    "kind": "dm", "text": "price please", "mid": "aWdf…", "attachments": [], "quick_reply": null, "first_message": true,
    "contact": { "igsid": "1234…", "username": "asha", "name": "Asha Rao", "is_new": true }
  }
}
```

`comment.received` has `text`, `comment_id`, `media_id`, `parent_id` and `contact`. `reply.sent` / `reply.failed` have
`kind` (`dm`, `private_reply`, `comment_reply`), `text`, `source` (`auto` or `manual`), `rule`, `flow`, `contact`, and
`message_id` or `error`. In n8n the payload is under `body`, e.g. `{{ $json.body.data.contact.username }}`.

Headers: `X-Autopilot-Event`, `X-Autopilot-Delivery` (same id on retries, use it to de-duplicate) and
`X-Autopilot-Signature: sha256=<HMAC-SHA256 of the raw body with the signing secret>`. Delivery runs in the background
and never slows replies; network errors and 5xx answers are retried after 5 s and 30 s, and a failure is logged in
Activity at most once an hour.

---

## Calendar and Insights

The **home page** has the shared content calendar: **Instagram and LinkedIn** together, with an
*All / Instagram / LinkedIn* switch. Drag any scheduled post to another day to move it. **+** on a day asks which
platform; Instagram posts open in the Instagram Scheduler's form, LinkedIn posts in the LinkedIn composer. The LinkedIn
app's **Calendar** tab opens it filtered to LinkedIn (`/#calendar/linkedin`).

The **Instagram Scheduler**'s own calendar shows Instagram posts only:

- Click **+** on a day (or a day, then *Schedule on this day*) to schedule a post for it.
- Drag a scheduled post to another day to move it; it keeps its time of day.
- Posts published directly in the Instagram app appear too, with likes and comments.
- Failed posts are marked in red; open one to see Instagram's error and retry. The **List** tab shows every post in a table.

**Insights** covers the last 7, 30 or 90 days:

- **Conversations:** DMs and comments received, replies sent (and how many were automated), median time to first reply, new contacts, delivery rate, and a daily chart.
- **When people message you:** a weekday × hour heatmap with the busiest window, a good guide for posting times.
- **Top automations, flows and delivery:** which rules and flows send the most, flow completion, and why messages were skipped or failed.
- **Instagram:** followers over time (the app records the count every hour, so the chart starts the day you install it), average likes and comments, engagement rate, and your recent posts ranked.
- **Reach and views** need the `instagram_manage_insights` permission. Without it the page explains how to add it; everything else works regardless.

Instagram data is cached for 15 minutes (per-post insights for an hour) to stay well inside Meta's rate limits.

## Flows

**Flows** (in the sidebar) is a visual builder for conversations with more than one step. Pick a template or start
blank, drag steps from the left onto the canvas, and pull a wire from a step's dot to the step that should come next.
Dropping a wire on empty space opens a menu to create and connect a new step there.

| Step | What it does |
|---|---|
| Trigger | What starts the flow: a DM keyword, a comment, a story reply or mention, or someone's first message. |
| Send message | Text with `{{first_name}}`, saved answers like `{{email}}`, up to 3 buttons (open a link, or continue the flow) or up to 13 quick replies. Every button and quick reply gets its own output, plus "Any other reply". |
| Send image | An uploaded image or video. |
| Wait for reply | Pauses until they answer, saves the answer, optionally checks it is an email, phone number or number, and can give up after a while. |
| Condition | Goes "Yes" or "No" based on their last message, a saved answer, or a tag. |
| Delay | Waits up to 23 hours before the next step. |
| A/B split | Sends each person down path A or B at random. |
| Reply to comment | A public reply under the post (comment flows). |
| Tag contact | Adds or removes a label, for use in conditions. |
| Hand off to me | Ends the flow and pauses automation for that person so you can reply yourself. |

- **Test** opens a chat preview that runs the flow in your browser; nothing is sent to Instagram.
- The builder checks the flow as you edit and will not let a broken flow go **Live**. Problems are marked on the steps.
- Each step shows how many times it has run. Shortcuts: `Del` delete, `Ctrl+Z` undo, `Ctrl+D` duplicate, `Ctrl+S` save, `F` fit to screen, `Ctrl`+scroll or pinch to zoom.
- Flows and simple automations share the same triggers. If both match a message, the higher priority answers; on a tie the flow wins.
- When a flow is waiting for someone's answer, their next DM goes to the flow. If the flow has nothing connected for a free-text answer, the simple automations get it instead.
- Flow messages go through the same queue as everything else, so the 24-hour window, hourly cap, per-person limit and human takeover pause all apply.
- **Comment flows:** Instagram allows one private reply to a comment, as plain text. Links and choices are written into that message, and the flow continues once the person replies. The builder warns about any message that could not be delivered because of this rule.

## LinkedIn scheduler

Open **LinkedIn** in the sidebar. You are signed in there as its admin automatically.

### 1. Create the LinkedIn app

1. Go to <https://developers.linkedin.com> and create an app (it must be associated with a LinkedIn Page).
2. Under **Products**, add **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** (both self-serve).
3. Under **Auth**, add the redirect URL `https://insta.zealcoder.in/linkedin/auth/linkedin/callback`
   (locally: `http://localhost:3000/linkedin/auth/linkedin/callback`). LinkedIn → Settings shows the exact value.
4. In the dashboard: **LinkedIn → Settings → LinkedIn app**, paste the Client ID and Client Secret.
5. **LinkedIn → Accounts → Connect account → LinkedIn profile.**

Company pages need LinkedIn's **Community Management API** (reviewed by LinkedIn). Once approved, add
`w_organization_social r_organization_social` to the scopes in LinkedIn → Settings.

Nothing has to go in `.env`. The LinkedIn data (database, `secrets.json` with its encryption key, queued media) lives in
`/data/linkedin/` on the same volume as everything else, so the backup command below covers it.

### Team members

LinkedIn → Accounts → Team → **Send invite** creates an editor or admin with a temporary password (no email is sent;
pass it on yourself). Team members sign in at `/linkedin/classic.html` with email and password and only see the LinkedIn
section; the Instagram dashboard still needs `ADMIN_PASSWORD`.

### AI content studio (home page)

The home page has an **AI content studio** for LinkedIn, built on Auto content:

- **Write a post:** type an idea, get 1 to 3 versions in your voice, edit, then *Schedule* (next free slot), *Pick a time*
  or *Save as draft*.
- **Plan ahead:** optionally give a theme and pick 7, 14 or 30 days; Claude writes a post for every empty slot and puts
  them on the calendar.
- **Autopilot:** on/off switch, plus *Ask me before posting* (drafts you approve) or *Post automatically*.
- **Waiting for your approval:** approve one or all; drafts also show on the calendar as *Needs approval*.

Everything that is scheduled publishes by itself at its date and time (the scheduler checks every 30 seconds).
It needs an Anthropic API key and, in LinkedIn → Auto content, the account to post as, posting days and times, and your
topics. Requests use structured outputs (so replies always parse) and, on supported models, the server-side refusal
fallback. The default model is `claude-sonnet-5-5`; another can be set in Auto content.

### Auto content (optional)

LinkedIn → Auto content fills empty time slots with drafts you approve: paste posts written in claude.ai, push them from
n8n/Zapier/Make to `POST https://insta.zealcoder.in/linkedin/api/inbound` with a token, or add an Anthropic API key
(`ANTHROPIC_API_KEY` in `.env` or in the page) to have them written automatically.

### Moving over from the separate LinkedIn app

Copy the old app's data folder (`autopilot.db`, `secrets.json` and `media/`, all three together) into the volume at
`/data/linkedin/`, then restart. Your posts, accounts and team come along; the first admin of the old app becomes the
platform owner. In the LinkedIn developer portal, change the redirect URL to the new `/linkedin/auth/linkedin/callback`
one. Old team-member logins need to sign in again once.

```bash
docker compose cp ./old-linkedin-data/. app:/data/linkedin/
```

```bash
docker compose restart app
```

### How publishing works

Every 30 seconds due posts are published with `POST /rest/posts`. Each post is claimed atomically, temporary errors retry
up to 3 times, and a post interrupted by a restart is marked failed instead of retried so it can never go out twice.
LinkedIn tokens last about 60 days and cannot be renewed silently; a banner (and optionally a Slack/Discord message)
warns before a connection expires.

## WhatsApp automation

`/whatsapp/` uses the **WhatsApp Business Cloud API** (hosted by Meta, official), so the number is never at risk of a ban
for automation the way unofficial WhatsApp Web bots are. Everything is configured in the dashboard; nothing goes in `.env`.

### 1. Set up WhatsApp in Meta

1. In your Meta app (the Instagram one is fine, or a separate app) add the **WhatsApp** product and add / verify a phone
   number. A number used here can't be logged in to the normal WhatsApp app at the same time.
2. Business Settings > **System users**: create one, assign it the app and the WhatsApp Business Account with full
   control, and **Generate token** with `whatsapp_business_messaging` and `whatsapp_business_management`
   (expiry: never).
3. Open **WhatsApp > Settings** in the dashboard and paste the **phone number ID**, **WhatsApp Business Account ID**
   (both on the app's WhatsApp > API Setup page) and the token. **Test connection** shows the number and its quality.
   If WhatsApp lives in a different Meta app than Instagram, also paste that app's secret.
4. Meta app > WhatsApp > **Configuration** > Webhook: paste the **Callback URL** (`https://<domain>/whatsapp/webhook`)
   and **Verify token** from Settings, click Verify and save, and subscribe to the **messages** field. Then click
   **Subscribe app to WABA** in Settings.

### What it does

- **Auto-replies**: a welcome message for someone's first message, and keyword rules (contains / exact / any) with up
  to 3 quick-reply buttons, `{{first_name}}` / `{{name}}` / `{{phone}}`, priority and per-person cooldown. One reply per
  incoming message, a per-contact hourly cap so two bots can't loop, and replying by hand from the inbox pauses the bot
  for that chat (configurable).
- **Opt-out**: `STOP` / `UNSUBSCRIBE` marks the contact opted out (with a confirmation you can edit) and broadcasts skip
  them; `START` subscribes them again.
- **Inbox**: every chat with delivery ticks (sent / delivered / read / failed), manual replies, and templates when the
  24-hour window is closed.
- **Broadcasts**: pick an approved template, paste numbers (`number, var1, var2` per line, CSV header optional),
  send now or schedule. Duplicate and invalid lines are dropped; a default country code (Settings) is added to 10-digit
  numbers. Templates with media headers or variable buttons are not supported yet.
- **Templates**: synced from WhatsApp Manager (create and edit them there; Meta reviews them).

WhatsApp's rules are enforced: free-form messages only within 24 hours of the person's last message (otherwise only an
approved template), an hourly send cap you can raise to match your messaging tier, retries for rate limits, and a send
interrupted by a restart is marked failed instead of resent.

### n8n

- **Events to n8n**: set an n8n Webhook URL in WhatsApp settings. `whatsapp.message.received`, `whatsapp.reply.sent`,
  `whatsapp.reply.failed` and `whatsapp.opt_out` are POSTed with the same signature as the Instagram webhook
  (`X-Autopilot-Signature: sha256=<HMAC of the raw body>` with the signing secret shown there).
- **Send from n8n**: create an API key in WhatsApp settings, then an HTTP Request node:

  ```
  POST https://<domain>/whatsapp/api/external/send
  Authorization: Bearer wak_...
  {"to": "919876543210", "text": "Hi"}                                   # within 24h of their last message
  {"to": "919876543210", "template": "order_update", "language": "en_US", "params": ["Asha", "#1042"]}
  ```

  It answers `202 {"queued": true, "id": 12}`; `GET /whatsapp/api/external/status/12` (same header) gives the result.

## Day-to-day

| Task | Command |
|---|---|
| View logs | `docker compose logs -f app` |
| Restart | `docker compose restart app` |
| Update after changing code | `docker compose up -d --build` |
| Back up everything (database + uploaded media) | `docker run --rm -v insta-automation_appdata:/data -v "$PWD":/backup alpine tar czf /backup/backup.tgz -C /data .` |

The access token is a business system-user token. Whether it expires depends on the login configuration you created;
the Overview page shows which. If it has an expiry, the Activity log warns a week ahead: click **Reconnect** to get a new one.
The token also stops working if you remove the app from your business portfolio or move the Instagram account to another one.

## Troubleshooting

- **"Rejected a webhook call with a missing or invalid signature"** in Activity: `META_APP_SECRET` does not match
  the app that sends the webhooks. Copy it again from App settings → Basic and restart.
- **No "API setup with Unified login" tab:** the app is not owned by a business portfolio.
- **"This token has no Instagram account assigned":** connect again and tick your Instagram account on the asset screen.
  If it is not listed, the account is personal (switch to Business/Creator) or sits in a different business portfolio.
- **"(#200) The account owner has disabled access to Instagram Direct Messaging":** turn on *Allow access to messages* (step 5.4).
- **No webhooks arriving:** the app is not in Live mode, the callback URL or fields in the Meta dashboard are wrong (the
  "Webhooks set up in Meta" checklist step shows which), or "Allow access to messages" is off in the Instagram app.
  The account subscription is automatic; "Check now" in the checklist re-checks it immediately and shows Meta's error if it fails.
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

Layout: `src/linkedin/` (LinkedIn scheduler, mounted at `/linkedin` by `src/server.ts`; pages in `public/linkedin/`),
`src/engine.ts` (rule matching), `src/queue.ts` (rate-limited sender), `src/webhook.ts`, `src/poller.ts`
(comment fallback), `src/scheduler.ts` (publishing, token refresh), `src/api.ts` (dashboard API), `public/` (dashboard).

---

## Security

- **Dashboard login:** signed, revocable sessions (logout and `ADMIN_PASSWORD` changes end them), 8 attempts per 15 minutes per IP, failed logins logged. Over HTTPS the cookie is `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`.
- **Cross-site protection:** state-changing API calls from another origin are refused; strict CSP, `frame-ancestors 'none'`, HSTS and no-store caching on API responses.
- **Secrets:** the Instagram token is encrypted in the database (key derived from `SESSION_SECRET`, so changing it means reconnecting). Tokens and secrets are redacted from logs and error messages. Data files are created owner-only.
- **Webhooks:** every call must carry a valid `X-Hub-Signature-256`.
- **Messaging guardrails:** hourly cap, per-person hourly cap (default 10, stops reply loops), 24-hour window, de-duplication, and no retry of a send whose outcome is unknown. If Instagram reports a temporary block (code 368), automation switches itself off.
- **Uploads:** images are re-encoded (strips metadata and payloads), videos are checked by file signature, media is served sandboxed, and total media size is capped (`MAX_MEDIA_MB`, default 5120).
- **Container:** the app drops to an unprivileged user, the compose service is read-only with all capabilities dropped except what the entrypoint needs, and Caddy limits request size.
