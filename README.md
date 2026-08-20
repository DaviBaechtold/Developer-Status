# Developer Status (NOC Bot)

Discord bot for a dev team's infrastructure monitoring: tracks the status of third-party services (GitHub, Vercel, OpenAI, AWS...), pings your own URLs and Jenkins jobs, and receives CI/CD webhooks (GitHub Actions, Jenkins) routed per project channel.

Every command exists both as `!text` and as a `/slash` command with autocomplete.

**Multi-server:** the third-party status catalog (`endpoints.json`) is shared, but each server's watchlist, webhook mappings and audit log are isolated — two servers can both use a project id like `api` without colliding, and a `webhook_id` is owned by whichever server claimed it first (another server can't hijack it by reusing the same id in `!channel`).

## Setup

```bash
npm install
cp .env.example .env   # fill in DISCORD_TOKEN and WEBHOOK_KEY
node index.js
```

### `.env`

| Variable | What it is |
|---|---|
| `DISCORD_TOKEN` | Bot token, generated at [discord.com/developers/applications](https://discord.com/developers/applications) → your app → Bot |
| `WEBHOOK_KEY` | Fallback key for webhooks that aren't mapped to a project (see `!channel` below — mapped projects get their own key instead) |

You need the **Message Content** intent enabled on the Bot tab of the Developer Portal (the `!text` commands read plain text).

### Invite it to a server

Developer Portal → OAuth2 → URL Generator → scopes `bot` **and** `applications.commands` (the second one is required for slash commands to show up) → permissions (`Administrator` just works, or the minimal set: View Channels, Send Messages, Embed Links, Mention Everyone, Add Reactions) → open the generated URL and pick the server.

## Initial setup (inside Discord)

The bot posts a short welcome message (with the same steps below) in the system channel the moment it joins a server.

```
!config #devops-channel @TechTeam @ProjectManagers
```
or `/config`. Sets the alert channel, the role mentioned when something goes down, and the role allowed to manage the local watchlist. With no admin role configured, only server Administrators can touch it.

## Commands

Run `!help` in Discord for the interactive panel, but the short version:

**Everyone**
- `!status` — paginated menu to audit a specific service (incidents + active scheduled maintenance)
- `!status all` — dashboard grouped by stack, with a 🔄 refresh button. 🟩 operational, 🟨 minor issue, 🟥 major/critical outage
- `!report [days]` — uptime % and average response time over the last N days (default 7, max 90)
- `!audit` — last 10 admin actions on this server

**Admin / manager role**
- `!config <#channel> <@alertRole> <@adminRole>` — admin only
- `!monitor <id> <url> <Name>` — pings a URL every 5 min + SSL expiry check
- `!monitor-jenkins <id> <job_url> <Name>` — polls `<job_url>/lastBuild/api/json` every 5 min. Put basic auth in the URL if the job needs it: `http://user:pass@jenkins-host/job/X`
- `!ssl ignore <id>` — disables SSL check for a project
- `!incident <id> <message>` / `!resolve <id>` — pause/resume monitoring
- `!remove <id>` — asks for confirmation, then drops it from the watchlist
- `!channel <webhook_id> #channel` — routes a project's webhooks to a channel and issues it its own API key (shown once)
- `!channel rotate <webhook_id>` — invalidates the old key, issues a new one
- `!webhook test <webhook_id>` — sends a sample alert through a project's webhook to confirm it's wired up

Unknown `!commands` get a hint instead of silently doing nothing.

## CI/CD Webhooks

Generic endpoint, protected by API key:

```bash
curl -X POST http://<bot-ip>:3000/webhook/<project_id> \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: <project's key from !channel, or WEBHOOK_KEY if unmapped>" \
  -d '{"title": "Homolog Deploy", "message": "Build passed.", "status": "info"}'
```

`status` can be `error` (red alert + role mention) or anything else (blue, informational). Each project mapped with `!channel` gets its own key — a leaked pipeline secret only exposes that one project's channel, not every server the bot is in. Unmapped ids fall back to the shared `WEBHOOK_KEY` and broadcast to every configured server.

Add an optional `fields` array for a labeled two-column card instead of a flat description — same look the native GitHub events below get:

```json
{"title": "Deploy backend → homolog: OK", "status": "info",
 "fields": [{"name": "Commit", "value": "`10806f8`", "inline": true}, {"name": "Environment", "value": "homolog", "inline": true}]}
```

For **GitHub** events (push, pull requests, issues, releases, workflow runs), there's a dedicated endpoint that speaks GitHub's own webhook format instead of the generic one above — no pipeline code needed, GitHub sends these itself:

```
Repo → Settings → Webhooks → Add webhook
Payload URL: http://<bot-ip>:3000/github-webhook/<project_id>
Content type: application/json
Secret: <project's key from !channel>
```

Auth here is GitHub's own scheme (`X-Hub-Signature-256`, HMAC-SHA256 of the raw body using the project's key as secret), not the `X-API-KEY` header. Each event type gets its own embed (push shows the commit list, PRs/issues show state and author, releases show the tag, workflow runs show pass/fail) — mirrors the layout style of [gittrack-discord-bot](https://github.com/luuccaaaa/gittrack-discord-bot). Unrecognized event types are acknowledged and dropped rather than posted.

Everything else — Jenkins, CloudWatch, or any pipeline step you write yourself — uses the generic endpoint below.

`GET /health` is unauthenticated on purpose (no key needed) and returns whether the bot is connected to Discord — point an external uptime monitor (UptimeRobot, etc.) at it to get alerted if the host goes down. See the "Fallback if the VM goes down" section in [DEPLOY.md](DEPLOY.md).

## Monitored third-party services

Editable in `endpoints.json` (Atlassian Statuspage `/api/v2/status.json` format).

## Data & state

`bot_data.sqlite` (gitignored) holds guild config, the watchlist, webhook keys, uptime/latency history, current status (survives a restart — no false "recovered" alert after a redeploy), and the admin action log.

## Running it 24/7

See [DEPLOY.md](DEPLOY.md) for hosting this somewhere other than your own machine — Oracle Cloud's Always Free tier, since it's the only free option that actually fits (long-running process, persistent SQLite file, public port for webhooks — Railway and Fly.io dropped their free tiers, Render's free plan sleeps and wipes the disk).

## Stack

Node.js, discord.js v14 (message commands + slash commands), better-sqlite3, Express (webhook server).

## Security

- **Process resilience**: `process.on('unhandledRejection'/'uncaughtException')` log and keep running instead of crashing — still run it under a process manager (`pm2`, a `systemd` unit, or Docker `restart: always`) for real auto-recovery if the process does die (OOM, host reboot, etc). Nothing here does that for you.
- **Webhook auth**: constant-time key comparison, per-project keys (`!channel`) isolate blast radius, and a 30-req/min per-IP rate limit blunts brute-force/DoS on `/webhook/:id`.
- **Input length limits**: incident messages, project ids/names/URLs, and webhook payload fields are clamped to what Discord's embed limits allow, so oversized input can't crash the monitoring loop anymore.
- **Credential handling**: don't paste real secrets into Discord messages — `!monitor-jenkins` accepting `user:pass@host` in the URL is a convenience, not a vault; the audit log redacts it, but the raw URL still sits in `bot_data.sqlite` in plaintext. Prefer the CI/CD webhook flow (`!help` → CI/CD Tutorial) over polling a job that needs credentials, when possible.
- **Bot permissions**: the OAuth invite URL in Setup suggests `Administrator` for simplicity. That's more than the bot needs (it only sends/edits messages and mentions roles) — for a bot running across multiple companies' servers, prefer the minimal set: View Channels, Send Messages, Embed Links, Mention Everyone, Add Reactions.
- **SSRF-aware watchlist**: `!monitor`/`!monitor-jenkins` let anyone with the manager role point the bot at arbitrary URLs, including internal/private network addresses — the bot will fetch them every 5 minutes. Only grant the manager role to people you'd trust with server-side request access.
