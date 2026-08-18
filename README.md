# Developer Status (NOC Bot)

Discord bot for a dev team's infrastructure monitoring: tracks the status of third-party services (GitHub, Vercel, OpenAI, AWS...), pings your own URLs with SSL expiry checks, and receives CI/CD webhooks (GitHub Actions, Jenkins) routed per channel.

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
| `WEBHOOK_KEY` | Key external pipelines send in the `X-API-KEY` header to post alerts |

You need the **Message Content** intent enabled on the Bot tab of the Developer Portal (the bot reads commands as plain text).

### Invite it to a server

Developer Portal → OAuth2 → URL Generator → scope `bot` → permissions (`Administrator` just works, or the minimal set: View Channels, Send Messages, Embed Links, Mention Everyone, Add Reactions) → open the generated URL and pick the server.

## Initial setup (inside Discord)

```
!config #devops-channel @TechTeam @ProjectManagers
```

Sets the alert channel, the role mentioned when something goes down, and the role allowed to manage the local watchlist (`!monitor`, `!incident`, etc). With no admin role configured, only server Administrators can touch it.

## Commands

Run `!help` in Discord for the interactive panel with all of this, but the short version:

- `!status` — menu to investigate a specific service's incidents
- `!status all` — dashboard with every service grouped by stack + local projects
- `!report` — uptime over the last 7 days
- `!config <#channel> <@alertRole> <@adminRole>` — admin only
- `!monitor <id> <url> <Name>` — adds your own URL to the watchlist (ping every 5min + SSL)
- `!ssl ignore <id>` — disables SSL check for a service
- `!incident <id> <message>` / `!resolve <id>` — pause/resume manual monitoring
- `!remove <id>` — drops it from the watchlist
- `!channel <webhook_id> #channel` — routes a project's webhooks to a specific channel instead of the global broadcast

## CI/CD Webhooks

Generic endpoint, protected by API key:

```bash
curl -X POST http://<bot-ip>:3000/webhook/<project_id> \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: <WEBHOOK_KEY>" \
  -d '{"title": "Homolog Deploy", "message": "Build passed.", "status": "info"}'
```

`status` can be `error` (red alert + role mention) or anything else (blue, informational). Map `<project_id>` to a channel with `!channel`, otherwise it falls back to the broadcast across every configured server.

For **GitHub** (push/PR/commits) and **Jenkins**, you usually don't even need this endpoint — Discord's native channel webhook can be wired up directly in the repo/job settings. This endpoint is for alerts that have no native integration (CloudWatch, internal scripts, etc).

## Monitored services

Editable in `endpoints.json` (Atlassian Statuspage `/api/v2/status.json` format).

## Stack

Node.js, discord.js v14, better-sqlite3 (state persisted in `bot_data.sqlite`, gitignored), Express (webhook server).
