# DM Autopilot

A self-hosted Instagram DM automation and post scheduler for **your own** Instagram professional account.
It uses only the official Instagram API with Unified Login (Meta's current setup), so it follows Meta's messaging rules by design.

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

---

## Calendar and Insights

**Calendar** shows each month with everything planned and published:

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

Layout: `src/engine.ts` (rule matching), `src/queue.ts` (rate-limited sender), `src/webhook.ts`, `src/poller.ts`
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
