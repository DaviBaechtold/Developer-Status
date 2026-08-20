const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ComponentType, Events } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const express = require('express');
const { sslChecker } = require('ssl-checker');
require('dotenv').config();

// Last line of defense: a bad embed (oversized field, Discord API hiccup, etc.) anywhere in a
// setInterval/collector callback is an UNHANDLED rejection with no framework to catch it — that
// crashes the whole process with no auto-restart. Log and keep running instead of going dark.
process.on('unhandledRejection', (err) => console.error('⚠️ Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('⚠️ Uncaught exception:', err));

// ==========================================
// 1. SERVICE INITIALIZATION
// ==========================================
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const app = express();
// GitHub signs the raw request bytes, not the re-serialized JSON — capture them before parsing.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const db = new Database('./bot_data.sqlite');

db.exec(`
    CREATE TABLE IF NOT EXISTS guild_configs (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT,
        alert_role TEXT,
        admin_role TEXT
    );
    CREATE TABLE IF NOT EXISTS monitored_urls (
        guild_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT,
        url TEXT,
        manual_incident TEXT,
        ignore_ssl INTEGER DEFAULT 0,
        kind TEXT DEFAULT 'url',
        PRIMARY KEY (guild_id, id)
    );
    CREATE TABLE IF NOT EXISTS uptime_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT,
        status TEXT,
        latency_ms INTEGER,
        guild_id TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS webhook_channels (
        webhook_id TEXT PRIMARY KEY,
        channel_id TEXT,
        webhook_key TEXT,
        guild_id TEXT
    );
    CREATE TABLE IF NOT EXISTS service_state (
        id TEXT PRIMARY KEY,
        status TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        user_tag TEXT,
        action TEXT,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// --- Migrations for installs created before multi-tenant scoping ---
for (const stmt of [
    `ALTER TABLE webhook_channels ADD COLUMN webhook_key TEXT`,
    `ALTER TABLE webhook_channels ADD COLUMN guild_id TEXT`,
    `ALTER TABLE uptime_history ADD COLUMN latency_ms INTEGER`,
    `ALTER TABLE uptime_history ADD COLUMN guild_id TEXT`
]) { try { db.exec(stmt); } catch (e) { /* already applied */ } }

// monitored_urls needs a real rebuild, not just a column add: its primary key moves from a
// bare `id` to (guild_id, id) so two different servers can both use the same short project id.
{
    const cols = db.prepare(`PRAGMA table_info(monitored_urls)`).all();
    if (cols.length > 0 && !cols.some(c => c.name === 'guild_id')) {
        db.exec(`ALTER TABLE monitored_urls RENAME TO monitored_urls_old`);
        db.exec(`
            CREATE TABLE monitored_urls (
                guild_id TEXT NOT NULL,
                id TEXT NOT NULL,
                name TEXT,
                url TEXT,
                manual_incident TEXT,
                ignore_ssl INTEGER DEFAULT 0,
                kind TEXT DEFAULT 'url',
                PRIMARY KEY (guild_id, id)
            );
        `);
        // Pre-migration rows had no owning guild. Hand them to whatever guild has already run
        // !config (best guess at who they belonged to) — otherwise there's nothing to attribute
        // them to, so they're dropped rather than silently guessed at.
        const fallbackGuild = db.prepare(`SELECT guild_id FROM guild_configs LIMIT 1`).get()?.guild_id;
        if (fallbackGuild) {
            db.prepare(`
                INSERT INTO monitored_urls (guild_id, id, name, url, manual_incident, ignore_ssl, kind)
                SELECT ?, id, name, url, manual_incident, ignore_ssl, COALESCE(kind, 'url') FROM monitored_urls_old
            `).run(fallbackGuild);
        }
        db.exec(`DROP TABLE monitored_urls_old`);
    }
}

let endpoints = {}; // shared third-party catalog — same for every guild, not tenant data
let lastStatus = {};
let lastStatusMonitoredUrls = {}; // keyed "guildId:localId" — local watchlists are per-guild

function localKey(guildId, id) { return `${guildId}:${id}`; }

// Discord hard-caps embed field values at 1024 chars and titles at 256 — anything stored here
// eventually gets rendered into one. Clamp at the door instead of finding out 5 minutes later
// when the monitoring loop tries to build the alert and throws.
function clamp(str, max) { return (str ?? '').toString().slice(0, max); }

// Strips basic-auth creds out of a URL before it's ever written to the audit log — !monitor-jenkins
// documents putting them in the URL itself, and the audit log is readable by any manager, not just
// whoever added the job.
function redactUrl(url) {
    try {
        const u = new URL(url);
        if (u.username || u.password) { u.username = '***'; u.password = ''; }
        return u.toString();
    } catch (e) { return url; }
}

function loadEndpoints() {
    try {
        if (fs.existsSync('./endpoints.json')) {
            endpoints = JSON.parse(fs.readFileSync('./endpoints.json', 'utf8'));
        } else {
            endpoints = {
                github: { name: 'GitHub', url: 'https://www.githubstatus.com/api/v2/status.json', type: 'atlassian' },
                openai: { name: 'OpenAI', url: 'https://status.openai.com/api/v2/status.json', type: 'atlassian' },
                cloudflare: { name: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/status.json', type: 'atlassian' },
                vercel: { name: 'Vercel', url: 'https://www.vercel-status.com/api/v2/status.json', type: 'atlassian' },
                docker: { name: 'Docker', url: 'https://status.docker.com/api/v2/status.json', type: 'atlassian' },
                npm: { name: 'NPM', url: 'https://status.npmjs.org/api/v2/status.json', type: 'atlassian' }
            };
            fs.writeFileSync('./endpoints.json', JSON.stringify(endpoints, null, 2));
        }
    } catch (e) { console.error(e); }
}

// Status survives a restart: every write goes through these two setters instead of touching the
// in-memory maps directly, so a crash/redeploy doesn't silently forget an ongoing outage.
const upsertState = db.prepare(`INSERT OR REPLACE INTO service_state (id, status) VALUES (?, ?)`);
function setExtStatus(key, status) { lastStatus[key] = status; upsertState.run(`ext:${key}`, status); }
function setLocalStatus(guildId, id, status) { lastStatusMonitoredUrls[localKey(guildId, id)] = status; upsertState.run(`local:${localKey(guildId, id)}`, status); }
function loadPersistedState() {
    for (const row of db.prepare(`SELECT id, status FROM service_state`).all()) {
        if (row.id.startsWith('ext:')) lastStatus[row.id.slice(4)] = row.status;
        else if (row.id.startsWith('local:')) lastStatusMonitoredUrls[row.id.slice(6)] = row.status;
    }
}

const axiosConfig = {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
};

// ==========================================
// 2. SUPPORT FUNCTIONS
// ==========================================
function hasPermission(member, guildId) {
    if (member?.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    const config = db.prepare(`SELECT admin_role FROM guild_configs WHERE guild_id = ?`).get(guildId);
    if (config && config.admin_role && member?.roles.cache.has(config.admin_role)) return true;
    return false;
}

// Single visual base — every embed the bot sends is born here, so nothing drifts into its own look.
const COLORS = { danger: '#ED4245', success: '#57F287', info: '#3498DB', neutral: '#2B2D31', warning: '#FEE75C' };

// ponytail: no setAuthor here — Discord already renders the bot's own name/avatar above every
// message it sends, so a "NOC Bot" author row just duplicated that. Dropped for a cleaner embed.
function createEmbed(color = COLORS.neutral) {
    return new EmbedBuilder()
        .setColor(color)
        .setTimestamp();
}

const insertAudit = db.prepare(`INSERT INTO audit_log (guild_id, user_tag, action, details) VALUES (?, ?, ?, ?)`);
function logAudit(guildId, userTag, action, details) {
    try { insertAudit.run(guildId || 'unknown', userTag, action, details || ''); } catch (e) { /* best effort */ }
}

// hasProblem-only alerts (third-party catalog) broadcast to every configured guild by default.
// Pass guildId to scope an alert to a single server — used for each guild's own local watchlist,
// so one server's private project outage doesn't get posted into every other server's channel.
// severity lets third-party alerts (which have a real minor/major/critical tier from the status
// page) show yellow instead of flattening everything non-'none' to red like a plain boolean would.
function broadcastAlert(alertEmbed, hasProblem, guildId = null, severity = null) {
    const sev = severity || (hasProblem ? 'critical' : 'none');
    alertEmbed.setColor(sev === 'none' ? COLORS.success : sev === 'minor' ? COLORS.warning : COLORS.danger);
    alertEmbed.setTitle(hasProblem ? '🚨 Infrastructure Alert' : '✅ Systems Back to Normal');

    const guilds = guildId
        ? db.prepare(`SELECT guild_id, channel_id, alert_role FROM guild_configs WHERE guild_id = ?`).all(guildId)
        : db.prepare(`SELECT guild_id, channel_id, alert_role FROM guild_configs`).all();
    for (const config of guilds) {
        client.channels.fetch(config.channel_id).then(channel => {
            if (channel) {
                const mention = (hasProblem && config.alert_role) ? `<@&${config.alert_role}> ` : '';
                channel.send({ content: mention, embeds: [alertEmbed] });
            }
        }).catch(() => {});
    }
}

function dispatchWebhookAlert(webhookId, title, msg, hasProblem, fields = null) {
    // Pull the first URL out of the message and make the title clickable with it, gittrack-style,
    // instead of leaving a raw link buried mid-paragraph.
    const urlMatch = (msg || '').match(/https?:\/\/\S+/);
    const body = urlMatch ? msg.replace(urlMatch[0], '').trim() : msg;
    const hookEmbed = createEmbed(hasProblem ? COLORS.danger : COLORS.info)
        .setTitle(`${hasProblem ? '🔴' : '🟢'} ${title || 'External Alert'}`)
        .setDescription(body || 'Event received.')
        .setFooter({ text: `Webhook · ${webhookId}` });
    if (urlMatch) hookEmbed.setURL(urlMatch[0]);
    // Optional structured fields (payload can send { fields: [{name, value, inline}] }) for the
    // same labeled two-column card look GitHub events get, instead of a flat description string.
    if (Array.isArray(fields) && fields.length > 0) {
        hookEmbed.addFields(fields.slice(0, 25).map(f => ({
            name: clamp(f?.name, 256) || '​',
            value: clamp(f?.value, 1024) || '​',
            inline: !!f?.inline
        })));
    }

    const projectChannel = db.prepare(`SELECT channel_id FROM webhook_channels WHERE webhook_id = ?`).get(webhookId);
    if (projectChannel) {
        client.channels.fetch(projectChannel.channel_id).then(channel => channel?.send({ embeds: [hookEmbed] })).catch(() => {});
    } else {
        broadcastAlert(hookEmbed, hasProblem);
    }
}

// ==========================================
// 3. GLOBAL MONITORING ENGINE
// ==========================================
const insertHistory = db.prepare(`INSERT INTO uptime_history (service_id, status, latency_ms, guild_id) VALUES (?, ?, ?, ?)`);

// Some services (e.g. GitHub Copilot) don't have their own status page — they're one component
// inside a bigger one (github's). `atlassian-component` reads components.json and tracks just
// that component's status instead of the whole page's indicator.
const COMPONENT_STATUS_MAP = { operational: 'none', degraded_performance: 'minor', partial_outage: 'major', major_outage: 'critical', under_maintenance: 'minor' };

async function fetchServiceStatus(service) {
    if (service.type === 'atlassian-component') {
        const response = await axios.get(service.url.replace('status.json', 'components.json'), axiosConfig);
        const component = response.data.components.find(c => c.id === service.componentId);
        if (!component) throw new Error('component not found');
        return { indicator: COMPONENT_STATUS_MAP[component.status] || 'minor', description: `${component.name}: ${component.status.replace(/_/g, ' ')}` };
    }
    const response = await axios.get(service.url, axiosConfig);
    return { indicator: response.data.status.indicator, description: response.data.status.description };
}

const SEVERITY_RANK = { none: 0, minor: 1, major: 2, critical: 3 };

async function monitorThirdParty() {
    let hasChanged = false, hasProblem = false, worstSeverity = 'none';
    const alertEmbed = createEmbed().setFooter({ text: 'Automated NOC Center' });

    for (const [key, service] of Object.entries(endpoints)) {
        try {
            if (service.type !== 'atlassian' && service.type !== 'atlassian-component') continue;
            const start = Date.now();
            const { indicator: currentStatus, description } = await fetchServiceStatus(service);
            const latency = Date.now() - start;

            const statusPage = service.url.split('/api/')[0];
            if (!lastStatus[key]) lastStatus[key] = 'none';
            if (currentStatus !== 'none' && currentStatus !== lastStatus[key]) {
                hasChanged = true; hasProblem = true;
                if (SEVERITY_RANK[currentStatus] > SEVERITY_RANK[worstSeverity]) worstSeverity = currentStatus;
                const emoji = currentStatus === 'minor' ? '🟡' : '🔴';
                alertEmbed.addFields({ name: `${emoji} ${service.name}`, value: `${description} [Status page](${statusPage})` });
            } else if (currentStatus === 'none' && lastStatus[key] !== 'none') {
                hasChanged = true;
                alertEmbed.addFields({ name: `✅ ${service.name}`, value: `Operations back to normal. [Status page](${statusPage})` });
            }
            setExtStatus(key, currentStatus);
            insertHistory.run(key, currentStatus === 'none' ? 'UP' : 'DOWN', latency, null);
        } catch (error) { }
    }
    if (hasChanged) broadcastAlert(alertEmbed, hasProblem, null, worstSeverity);
}

async function monitorGuildWatchlist(guildId, sites) {
    let hasChanged = false, hasProblem = false;
    const alertEmbed = createEmbed().setFooter({ text: 'Automated NOC Center' });

    for (const site of sites) {
        if (site.manual_incident) {
            if (lastStatusMonitoredUrls[localKey(guildId, site.id)] !== 'maintenance') {
                hasChanged = true; hasProblem = true;
                alertEmbed.addFields({ name: `🔧 Maintenance: ${site.name}`, value: site.manual_incident });
                setLocalStatus(guildId, site.id, 'maintenance');
            }
            insertHistory.run(site.id, 'DOWN', null, guildId);
            continue;
        }

        if (site.kind === 'jenkins') {
            try {
                const start = Date.now();
                const { data } = await axios.get(`${site.url.replace(/\/+$/, '')}/lastBuild/api/json`, { timeout: 10000 });
                const latency = Date.now() - start;
                if (data.result === null) continue; // build still running, skip this cycle

                const jobLink = `${site.url.replace(/\/+$/, '')}/${data.number}/`;
                if (data.result === 'SUCCESS') {
                    if (lastStatusMonitoredUrls[localKey(guildId, site.id)] === 'down') {
                        hasChanged = true;
                        alertEmbed.addFields({ name: `✅ Build OK: ${site.name}`, value: `Last build [#${data.number}](${jobLink}) passed.` });
                    }
                    setLocalStatus(guildId, site.id, 'up');
                    insertHistory.run(site.id, 'UP', latency, guildId);
                } else {
                    if (lastStatusMonitoredUrls[localKey(guildId, site.id)] !== 'down') {
                        hasChanged = true; hasProblem = true;
                        alertEmbed.addFields({ name: `🚨 Build Failed: ${site.name}`, value: `Last build [#${data.number}](${jobLink}) came back **${data.result}**.` });
                    }
                    setLocalStatus(guildId, site.id, 'down');
                    insertHistory.run(site.id, 'DOWN', latency, guildId);
                }
            } catch (error) {
                if (lastStatusMonitoredUrls[localKey(guildId, site.id)] !== 'down') {
                    hasChanged = true; hasProblem = true;
                    alertEmbed.addFields({ name: `🚨 Unreachable: ${site.name}`, value: 'Could not reach the Jenkins job API.' });
                }
                setLocalStatus(guildId, site.id, 'down');
                insertHistory.run(site.id, 'DOWN', null, guildId);
            }
            continue;
        }

        try {
            if (site.url.startsWith('https://') && site.ignore_ssl === 0) {
                const domain = new URL(site.url).hostname;
                const sslStatus = await sslChecker(domain, { method: "GET", port: 443 });
                if (sslStatus.daysRemaining <= 7 && sslStatus.daysRemaining > 0) {
                    hasChanged = true; hasProblem = true;
                    alertEmbed.addFields({ name: `🔐 SSL Warning: ${site.name}`, value: `Expires in **${sslStatus.daysRemaining} days**. [Check site](${site.url})` });
                } else if (sslStatus.daysRemaining <= 0) {
                    throw new Error("SSL_EXPIRED");
                }
            }
            const start = Date.now();
            await axios.get(site.url, { timeout: 10000 });
            const latency = Date.now() - start;

            if (lastStatusMonitoredUrls[localKey(guildId, site.id)] === 'down') {
                hasChanged = true;
                alertEmbed.addFields({ name: `✅ Online: ${site.name}`, value: `Connection restored. [Visit](${site.url})` });
            }
            setLocalStatus(guildId, site.id, 'up');
            insertHistory.run(site.id, 'UP', latency, guildId);
        } catch (error) {
            let reason = 'Connection failure (Timeout/HTTP Error)';
            if (error.message === 'SSL_EXPIRED' || error.code === 'CERT_HAS_EXPIRED') reason = 'Invalid/Expired SSL Certificate';

            if (lastStatusMonitoredUrls[localKey(guildId, site.id)] !== 'down') {
                hasChanged = true; hasProblem = true;
                alertEmbed.addFields({ name: `🚨 Offline: ${site.name}`, value: `${reason} [Visit](${site.url})` });
            }
            setLocalStatus(guildId, site.id, 'down');
            insertHistory.run(site.id, 'DOWN', null, guildId);
        }
    }
    if (hasChanged) broadcastAlert(alertEmbed, hasProblem, guildId);
}

// setInterval fires every 5 min regardless of whether the previous run finished — with enough
// monitored URLs across enough guilds, cycles could start overlapping and pile up. Skip instead.
let monitoringInProgress = false;
async function globalMonitoring() {
    if (monitoringInProgress) return;
    monitoringInProgress = true;
    try {
        await monitorThirdParty();

        const guildIds = db.prepare(`SELECT DISTINCT guild_id FROM monitored_urls`).all().map(r => r.guild_id);
        for (const guildId of guildIds) {
            const sites = db.prepare(`SELECT id, name, url, manual_incident, ignore_ssl, kind FROM monitored_urls WHERE guild_id = ?`).all(guildId);
            await monitorGuildWatchlist(guildId, sites);
        }
    } finally {
        monitoringInProgress = false;
    }
}

// ==========================================
// 4. SHARED COMMAND LOGIC (used by both !commands and /slash commands)
// ==========================================
function doConfig(guildId, userTag, channelId, roleIds) {
    db.prepare(`INSERT OR REPLACE INTO guild_configs (guild_id, channel_id, alert_role, admin_role) VALUES (?, ?, ?, ?)`)
        .run(guildId, channelId, roleIds[0] || null, roleIds[1] || null);
    logAudit(guildId, userTag, 'config', `channel=${channelId}`);
    return createEmbed(COLORS.success).setDescription(`✅ Configuration saved and linked to <#${channelId}>.`);
}

// A webhook_id is a global slug (it's part of a public-ish URL), but only the guild that first
// claims it may repoint or rotate it — otherwise any server running this bot could hijack another
// team's project by mapping the same id to their own channel.
function doChannelMap(guildId, userTag, webhookId, channelId) {
    const existing = db.prepare(`SELECT webhook_key, guild_id FROM webhook_channels WHERE webhook_id = ?`).get(webhookId);
    if (existing?.guild_id && existing.guild_id !== guildId) return { error: 'taken' };

    const key = existing?.webhook_key || crypto.randomBytes(16).toString('hex');
    db.prepare(`INSERT OR REPLACE INTO webhook_channels (webhook_id, channel_id, webhook_key, guild_id) VALUES (?, ?, ?, ?)`).run(webhookId, channelId, key, guildId);
    logAudit(guildId, userTag, 'channel-map', `${webhookId} -> ${channelId}`);
    return { key, isNew: !existing };
}

function doChannelRotate(guildId, userTag, webhookId) {
    const existing = db.prepare(`SELECT channel_id, guild_id FROM webhook_channels WHERE webhook_id = ?`).get(webhookId);
    if (!existing) return { error: 'missing' };
    if (existing.guild_id && existing.guild_id !== guildId) return { error: 'taken' };

    const key = crypto.randomBytes(16).toString('hex');
    db.prepare(`UPDATE webhook_channels SET webhook_key = ?, guild_id = ? WHERE webhook_id = ?`).run(key, guildId, webhookId);
    logAudit(guildId, userTag, 'channel-rotate', webhookId);
    return { key };
}

function doMonitor(guildId, userTag, id, url, name, kind = 'url') {
    id = clamp(id, 80); name = clamp(name, 80); url = clamp(url, 500);
    db.prepare(`INSERT OR REPLACE INTO monitored_urls (guild_id, id, name, url, ignore_ssl, kind) VALUES (?, ?, ?, ?, 0, ?)`).run(guildId, id, name, url, kind);
    setLocalStatus(guildId, id, 'up');
    logAudit(guildId, userTag, 'monitor', `${id} (${kind}) -> ${redactUrl(url)}`);
}

function doRemove(guildId, userTag, id) {
    const existed = db.prepare(`SELECT 1 FROM monitored_urls WHERE guild_id = ? AND id = ?`).get(guildId, id);
    db.prepare(`DELETE FROM monitored_urls WHERE guild_id = ? AND id = ?`).run(guildId, id);
    db.prepare(`DELETE FROM service_state WHERE id = ?`).run(`local:${localKey(guildId, id)}`);
    delete lastStatusMonitoredUrls[localKey(guildId, id)];
    logAudit(guildId, userTag, 'remove', id);
    return !!existed;
}

function doSslIgnore(guildId, userTag, id) {
    db.prepare(`UPDATE monitored_urls SET ignore_ssl = 1 WHERE guild_id = ? AND id = ?`).run(guildId, id);
    logAudit(guildId, userTag, 'ssl-ignore', id);
}

function doIncident(guildId, userTag, id, msg) {
    msg = clamp(msg || 'Maintenance', 900); // leaves room for the "🔧 Maintenance: <name>" field name prefix
    db.prepare(`UPDATE monitored_urls SET manual_incident = ? WHERE guild_id = ? AND id = ?`).run(msg, guildId, id);
    logAudit(guildId, userTag, 'incident', `${id}: ${msg}`);
}

function doResolve(guildId, userTag, id) {
    db.prepare(`UPDATE monitored_urls SET manual_incident = NULL WHERE guild_id = ? AND id = ?`).run(guildId, id);
    setLocalStatus(guildId, id, 'down'); // forces a real re-check next monitoring cycle instead of assuming it's back
    logAudit(guildId, userTag, 'resolve', id);
}

function doReport(guildId, days) {
    const clampedDays = Math.min(90, Math.max(1, days || 7));
    const records = db.prepare(`
        SELECT service_id, status, latency_ms FROM uptime_history
        WHERE timestamp >= datetime('now', '-' || ? || ' days') AND (guild_id IS NULL OR guild_id = ?)
    `).all(clampedDays, guildId);
    if (records.length === 0) return createEmbed().setDescription("📊 Collecting baseline data. Check back later.");

    const stats = {};
    records.forEach(r => {
        if (!stats[r.service_id]) stats[r.service_id] = { up: 0, total: 0, latencySum: 0, latencyCount: 0 };
        stats[r.service_id].total++;
        if (r.status === 'UP') stats[r.service_id].up++;
        if (r.latency_ms != null) { stats[r.service_id].latencySum += r.latency_ms; stats[r.service_id].latencyCount++; }
    });

    const embed = createEmbed().setTitle(`📈 Uptime — Last ${clampedDays}d`).setFooter({ text: '🟩 ≥98%  🟨 ≥90%  🟥 <90%' });
    let thirdPartyText = '', localText = '';

    for (const [id, data] of Object.entries(stats)) {
        const percentage = ((data.up / data.total) * 100).toFixed(2);
        const filled = Math.round(percentage / 10);
        const bar = (percentage < 90 ? '🟥' : (percentage < 98 ? '🟨' : '🟩')).repeat(filled) + '⬛'.repeat(10 - filled);

        let name = endpoints[id] ? endpoints[id].name : (db.prepare(`SELECT name FROM monitored_urls WHERE guild_id = ? AND id = ?`).get(guildId, id)?.name || id);
        const avgLatency = data.latencyCount > 0 ? ` · ~${Math.round(data.latencySum / data.latencyCount)}ms` : '';
        const line = `${bar} \`${percentage.padStart(6, ' ')}%\` **${name}**${avgLatency}\n`;
        if (endpoints[id]) thirdPartyText += line; else localText += line;
    }

    if (thirdPartyText) embed.addFields({ name: 'Third-Party', value: thirdPartyText });
    if (localText) embed.addFields({ name: 'Local', value: localText });
    return embed;
}

async function buildAuditEmbed(service) {
    const embed = createEmbed().setTitle(`🔍 Audit: ${service.name}`);
    try {
        // summary.json covers both open incidents AND in-progress scheduled maintenance —
        // incidents.json alone misses maintenance windows, which can also flip the indicator.
        const response = await axios.get(service.url.replace('status.json', 'summary.json'), axiosConfig);

        if (service.type === 'atlassian-component') {
            const component = response.data.components.find(c => c.id === service.componentId);
            const incident = response.data.incidents.find(inc => inc.status !== 'resolved' && inc.components?.some(c => c.id === service.componentId));
            const degraded = component && component.status !== 'operational';
            embed.setColor((incident || degraded) ? COLORS.danger : COLORS.success);
            if (incident) embed.setDescription(`⚠️ **${incident.name}**\n${incident.incident_updates.slice(0, 2).map(up => `> **[${up.status.toUpperCase()}]** - ${up.body}`).join('\n\n')}`);
            else if (degraded) embed.setDescription(`🟡 **${component.name}** is currently **${component.status.replace(/_/g, ' ')}**.`);
            else embed.setDescription('🟢 No anomalies reported.');
            return embed;
        }

        const incident = response.data.incidents.find(inc => inc.status !== 'resolved');
        const maintenance = response.data.scheduled_maintenances.find(m => m.status === 'in_progress');
        const event = incident || maintenance;
        embed.setColor(event ? COLORS.danger : COLORS.success);
        if (!event) embed.setDescription('🟢 No anomalies reported.');
        else {
            const icon = incident ? '⚠️' : '🔧';
            embed.setDescription(`${icon} **${event.name}**\n${event.incident_updates.slice(0, 2).map(up => `> **[${up.status.toUpperCase()}]** - ${up.body}`).join('\n\n')}`);
        }
    } catch (e) {
        embed.setColor(COLORS.neutral).setDescription('⚠️ Could not reach the status provider.');
    }
    return embed;
}

function buildAuditLogEmbed(guildId) {
    const rows = db.prepare(`SELECT user_tag, action, details, timestamp FROM audit_log WHERE guild_id = ? ORDER BY id DESC LIMIT 10`).all(guildId);
    const embed = createEmbed().setTitle('🗒️ Recent Admin Actions');
    if (rows.length === 0) return embed.setDescription('No actions logged yet.');
    embed.setDescription(rows.map(r => {
        const ts = Math.floor(new Date(`${r.timestamp}Z`).getTime() / 1000);
        return `**${r.action}** by ${r.user_tag}${r.details ? ` — ${r.details}` : ''}\n<t:${ts}:R>`;
    }).join('\n\n'));
    return embed;
}

const STACKS = {
    '☁️ Cloud & Infra': ['cloudflare', 'vercel', 'docker', 'render', 'railway', 'aws', 'oracle'],
    '🗄️ Databases & Backend': ['supabase', 'planetscale', 'redis'],
    '🧠 AI': ['openai', 'anthropic', 'huggingface', 'cursor', 'windsurf', 'copilot', 'deepseek', 'kimi'],
    '🛠️ DevTools & APIs': ['github', 'npm', 'pypi', 'discord', 'postman', 'sentry'],
    '💳 Payments': ['stripe']
};

function buildStatusAllEmbed(guild) {
    const panelEmbed = createEmbed()
        .setTitle('🌐 Global Operations Dashboard')
        .setDescription('Instant status of the dev watchlist, grouped by stack.')
        .setThumbnail(client.user.displayAvatarURL())
        .setFooter({ text: '🟩 Operational   🟨 Minor issue   🟥 Major/Critical outage' });

    const formatLine = (key, service) => {
        const status = lastStatus[key];
        const emoji = status === 'none' ? '🟩' : status === 'minor' ? '🟨' : '🟥';
        return `${emoji} ${service.name}`;
    };

    const panels = {};
    for (const [key, service] of Object.entries(endpoints)) {
        let foundStack = '🧩 Other Services';
        for (const [stackName, keyList] of Object.entries(STACKS)) {
            if (keyList.includes(key)) { foundStack = stackName; break; }
        }
        if (!panels[foundStack]) panels[foundStack] = [];
        panels[foundStack].push(formatLine(key, service));
    }

    for (const [stack, lines] of Object.entries(panels)) {
        panelEmbed.addFields({ name: stack, value: lines.join('\n'), inline: true });
    }

    let localText = '';
    const projects = guild ? db.prepare(`SELECT id, name, manual_incident FROM monitored_urls WHERE guild_id = ?`).all(guild.id) : [];
    if (projects.length > 0) {
        localText = projects.map(p => {
            const name = p.name.length > 40 ? p.name.slice(0, 39) + '…' : p.name;
            if (p.manual_incident) return `🟨 ${name} *(Maintenance)*`;
            const isUp = lastStatusMonitoredUrls[localKey(guild.id, p.id)] === 'up';
            return `${isUp ? '🟩' : '🟥'} ${name}`;
        }).join('\n');
    } else {
        localText = 'No local project on the watchlist.';
    }

    panelEmbed.addFields(
        { name: '​', value: '​', inline: false },
        { name: '💻 Your Local Applications', value: localText, inline: false }
    );

    // ponytail: worst-status-wins color, mirrors the per-state coloring gittrack uses on its embeds
    const statuses = Object.values(lastStatus);
    const projectDown = projects.some(p => !p.manual_incident && lastStatusMonitoredUrls[localKey(guild.id, p.id)] !== 'up');
    if (statuses.some(s => s === 'major' || s === 'critical') || projectDown) panelEmbed.setColor(COLORS.danger);
    else if (statuses.some(s => s === 'minor') || projects.some(p => p.manual_incident)) panelEmbed.setColor(COLORS.warning);
    else panelEmbed.setColor(COLORS.success);

    return panelEmbed;
}

function refreshButtonRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('refresh_status_all').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
    );
}

// Discord select menus hard-cap at 25 options — paginate instead of silently truncating the list.
function buildStatusSelectRows(page = 0) {
    const allIds = Object.entries(endpoints);
    const pageIds = allIds.slice(page * 25, page * 25 + 25);
    const menu = new StringSelectMenuBuilder().setCustomId(`sel_status:${page}`).setPlaceholder('Audit a service...')
        .addOptions(pageIds.map(([id, s]) => ({ label: s.name, value: id })));
    const rows = [new ActionRowBuilder().addComponents(menu)];

    const totalPages = Math.ceil(allIds.length / 25);
    if (totalPages > 1) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`status_page:${page - 1}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
            new ButtonBuilder().setCustomId(`status_page:${page + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        ));
    }
    return rows;
}

// ==========================================
// 5. SLASH COMMANDS
// ==========================================
const SLASH_COMMANDS = [
    { name: 'help', description: 'Show the interactive documentation panel' },
    {
        name: 'status', description: 'Check service status',
        options: [
            { name: 'all', description: 'Full dashboard of every service', type: 1 },
            { name: 'service', description: 'Audit one specific service', type: 1, options: [
                { name: 'name', description: 'Service to audit', type: 3, required: true, autocomplete: true }
            ] }
        ]
    },
    {
        name: 'config', description: '[Admin] Set the alert channel and roles',
        options: [
            { name: 'channel', description: 'Where alerts get posted', type: 7, required: true },
            { name: 'alert-role', description: 'Role pinged on an outage', type: 8, required: false },
            { name: 'admin-role', description: 'Role allowed to manage the watchlist', type: 8, required: false }
        ]
    },
    {
        name: 'channel', description: 'Route a project\'s webhooks to a specific channel',
        options: [
            { name: 'webhook-id', description: 'Project id used in the webhook URL', type: 3, required: true },
            { name: 'channel', description: 'Target channel', type: 7, required: true }
        ]
    },
    {
        name: 'channel-rotate', description: 'Rotate a project\'s webhook API key',
        options: [{ name: 'webhook-id', description: 'Project id', type: 3, required: true }]
    },
    {
        name: 'monitor', description: 'Add a URL to this server\'s watchlist',
        options: [
            { name: 'id', description: 'Short id for this service', type: 3, required: true },
            { name: 'url', description: 'URL to ping every 5 minutes', type: 3, required: true },
            { name: 'name', description: 'Display name', type: 3, required: true }
        ]
    },
    {
        name: 'monitor-jenkins', description: 'Add a Jenkins job to this server\'s watchlist',
        options: [
            { name: 'id', description: 'Short id for this job', type: 3, required: true },
            { name: 'job-url', description: 'Job base URL (e.g. http://user:pass@jenkins/job/X)', type: 3, required: true },
            { name: 'name', description: 'Display name', type: 3, required: true }
        ]
    },
    {
        name: 'remove', description: 'Remove a project from this server\'s watchlist',
        options: [{ name: 'id', description: 'Project id', type: 3, required: true, autocomplete: true }]
    },
    {
        name: 'ssl-ignore', description: 'Disable SSL expiry checks for a project',
        options: [{ name: 'id', description: 'Project id', type: 3, required: true, autocomplete: true }]
    },
    {
        name: 'incident', description: 'Open a manual maintenance window for a project',
        options: [
            { name: 'id', description: 'Project id', type: 3, required: true, autocomplete: true },
            { name: 'message', description: 'Reason shown in the alert', type: 3, required: false }
        ]
    },
    {
        name: 'resolve', description: 'Close a project\'s maintenance window',
        options: [{ name: 'id', description: 'Project id', type: 3, required: true, autocomplete: true }]
    },
    {
        name: 'report', description: 'Uptime report',
        options: [{ name: 'days', description: 'How many days back (1-90, default 7)', type: 4, required: false, min_value: 1, max_value: 90 }]
    },
    {
        name: 'webhook-test', description: '[Admin] Send a test alert through a project\'s webhook',
        options: [{ name: 'id', description: 'Project id', type: 3, required: true }]
    },
    { name: 'audit', description: '[Admin] Show the last 10 admin actions on this server' }
];

function registerSlashCommands(guild) {
    guild.commands.set(SLASH_COMMANDS).catch(e => {
        console.error(`⚠️ Could not register slash commands on ${guild.name}. Re-invite the bot with the "applications.commands" scope. (${e.message})`);
    });
}

// ==========================================
// 6. READY / LIFECYCLE
// ==========================================
client.once(Events.ClientReady, () => {
    loadEndpoints();
    for (const key in endpoints) lastStatus[key] = 'none';
    for (const row of db.prepare(`SELECT guild_id, id FROM monitored_urls`).all()) {
        lastStatusMonitoredUrls[localKey(row.guild_id, row.id)] = 'up';
    }
    loadPersistedState(); // overwrite the optimistic defaults above with whatever we knew before restart

    for (const guild of client.guilds.cache.values()) registerSlashCommands(guild);

    console.log(`✅ NOC Bot online! Logged in as ${client.user.tag}`);
    globalMonitoring();
    setInterval(globalMonitoring, 300000);

    app.listen(3000, () => console.log('🌐 Webhook server active on port 3000'));
});

function buildWelcomeEmbed() {
    return createEmbed(COLORS.info)
        .setTitle('👋 Thanks for adding NOC Bot!')
        .setThumbnail(client.user.displayAvatarURL())
        .setDescription('I track third-party service status, ping your own URLs/Jenkins jobs, and receive CI/CD webhooks — everything routed to whichever channels you pick. This server\'s setup is completely separate from any other server I\'m in.')
        .addFields(
            { name: '1️⃣ Set the alert channel', value: '`!config #channel` — optionally mention a role after the channel to get pinged on outages, and a second role to allow managing the watchlist. This is where third-party outage alerts land.' },
            { name: '2️⃣ Route each project\'s webhooks', value: '`!channel <project_id> #channel` — run once per project. Gives that project its own channel and its own API key for GitHub Actions/Jenkins.' },
            { name: '3️⃣ Everything else', value: 'Run `!help` (or `/help`) for the full command list, including a step-by-step CI/CD tutorial with copy-pasteable YAML/Groovy.' }
        );
}

client.on(Events.GuildCreate, async guild => {
    registerSlashCommands(guild);
    try {
        const me = guild.members.me ?? await guild.members.fetchMe();
        const channel = (guild.systemChannel?.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages) ? guild.systemChannel : null)
            ?? guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages));
        await channel?.send({ embeds: [buildWelcomeEmbed()] });
    } catch (e) { console.error('Welcome message failed:', e.message); }
});

// ==========================================
// 7. WEBHOOKS
// ==========================================
function timingSafeEqualStr(a, b) {
    const bufA = Buffer.from(a || '');
    const bufB = Buffer.from(b || '');
    if (bufA.length !== bufB.length) return false; // crypto.timingSafeEqual requires equal-length buffers
    return crypto.timingSafeEqual(bufA, bufB);
}

// ponytail: in-memory sliding window, per-process — resets on restart and won't scale across
// multiple bot instances behind a load balancer. Fine for a single-process internal tool; swap
// for a real store (Redis) if this ever runs more than one instance.
const webhookAttempts = new Map();
function isRateLimited(ip) {
    const now = Date.now();
    const windowMs = 60000, maxAttempts = 30;
    const recent = (webhookAttempts.get(ip) || []).filter(t => now - t < windowMs);
    recent.push(now);
    webhookAttempts.set(ip, recent);
    return recent.length > maxAttempts;
}

// Unauthenticated on purpose — nothing sensitive in the response, and an external uptime monitor
// (UptimeRobot, etc.) needs to hit it without a key. Point it here to get alerted if the VM dies.
app.get('/health', (req, res) => {
    res.status(client.isReady() ? 200 : 503).send({ discord: client.isReady() ? 'connected' : 'connecting' });
});

// Native GitHub webhook events (push, pull_request, issues, release, workflow_run) with
// per-type embeds — mirrors gittrack-discord-bot's layout. Auth is GitHub's own scheme:
// HMAC-SHA256 of the raw body using the project's !channel key as the webhook secret.
// Mirrors gittrack-discord-bot's embed pattern: the actual GitHub sender as embed author
// (real avatar, not the bot's), repo/branches as linked+backtick fields, event-named footer.
function buildGithubEventEmbed(event, action, payload) {
    const repo = payload.repository?.full_name || 'unknown repo';
    const repoUrl = payload.repository?.html_url;
    const repoLink = repoUrl ? `[${repo}](${repoUrl})` : repo;
    const sender = payload.sender;
    const author = sender ? { name: sender.login, iconURL: sender.avatar_url, url: sender.html_url } : null;

    if (event === 'push') {
        const branch = (payload.ref || '').replace('refs/heads/', '');
        const commits = (payload.commits || []).slice(0, 5)
            .map(c => `[\`${c.id.slice(0, 7)}\`](${c.url}) ${clamp(c.message.split('\n')[0], 80)}`)
            .join('\n') || 'No commits (branch deleted or empty push).';
        const embed = new EmbedBuilder().setColor('#4F46E5').setTitle(`🚀 New Push to ${branch}`)
            .setURL(payload.compare).setDescription(commits)
            .addFields(
                { name: 'Repository', value: repoLink, inline: true },
                { name: 'Branch', value: `\`${branch}\``, inline: true },
                { name: 'Pusher', value: payload.pusher?.name || sender?.login || 'Unknown', inline: false }
            ).setFooter({ text: 'GitHub Push Event' }).setTimestamp();
        if (author) embed.setAuthor(author);
        return embed;
    }
    if (event === 'pull_request') {
        const pr = payload.pull_request;
        const merged = action === 'closed' && pr.merged;
        let emoji = '📋', color = '#768390', label = action.charAt(0).toUpperCase() + action.slice(1);
        if (action === 'opened' || action === 'reopened') { emoji = '🔍'; color = COLORS.success; }
        else if (merged) { emoji = '🟣'; color = '#8957E5'; label = 'Merged'; }
        else if (action === 'closed') { emoji = '❌'; color = COLORS.danger; }
        else if (action === 'synchronize') { emoji = '📝'; color = COLORS.info; label = 'Updated'; }

        const embed = new EmbedBuilder().setColor(color).setTitle(`${emoji} Pull Request #${pr.number} ${label}: ${clamp(pr.title, 200)}`)
            .setURL(pr.html_url)
            .addFields(
                { name: 'Repository', value: repoLink, inline: false },
                { name: 'Branches', value: `\`${pr.head?.ref}\` → \`${pr.base?.ref}\``, inline: true },
                { name: 'State', value: pr.state.charAt(0).toUpperCase() + pr.state.slice(1), inline: true }
            ).setFooter({ text: 'GitHub Pull Request' }).setTimestamp();
        if (merged && pr.merged_by) embed.addFields({ name: 'Merged by', value: pr.merged_by.login, inline: true });
        if (pr.body) embed.setDescription(clamp(pr.body, 300));
        if (author) embed.setAuthor({ name: pr.user?.login || author.name, iconURL: pr.user?.avatar_url || author.iconURL, url: pr.user?.html_url || author.url });
        return embed;
    }
    if (event === 'issues') {
        const issue = payload.issue;
        const opened = action === 'opened';
        const embed = new EmbedBuilder().setColor(opened ? COLORS.warning : COLORS.danger)
            .setTitle(`${opened ? '🟡' : '⚪'} Issue #${issue.number} ${action}: ${clamp(issue.title, 200)}`)
            .setURL(issue.html_url)
            .addFields({ name: 'Repository', value: repoLink, inline: false })
            .setFooter({ text: 'GitHub Issue' }).setTimestamp();
        if (issue.body) embed.setDescription(clamp(issue.body, 300));
        if (author) embed.setAuthor({ name: issue.user?.login || author.name, iconURL: issue.user?.avatar_url || author.iconURL, url: issue.user?.html_url || author.url });
        return embed;
    }
    if (event === 'release') {
        const rel = payload.release;
        const embed = new EmbedBuilder().setColor(COLORS.success).setTitle(`🚀 New release: ${rel.tag_name}`)
            .setURL(rel.html_url).addFields({ name: 'Repository', value: repoLink, inline: false })
            .setDescription(clamp(rel.body, 500) || 'No release notes.').setFooter({ text: 'GitHub Release' }).setTimestamp();
        if (author) embed.setAuthor(author);
        return embed;
    }
    if (event === 'workflow_run') {
        const run = payload.workflow_run;
        const ok = run.conclusion === 'success';
        const embed = new EmbedBuilder().setColor(ok ? COLORS.success : COLORS.danger)
            .setTitle(`${ok ? '✅' : '❌'} Workflow "${run.name}" ${run.conclusion || run.status}`)
            .setURL(run.html_url)
            .addFields(
                { name: 'Repository', value: repoLink, inline: true },
                { name: 'Branch', value: `\`${run.head_branch || '?'}\``, inline: true }
            ).setFooter({ text: 'GitHub Actions' }).setTimestamp();
        if (author) embed.setAuthor(author);
        return embed;
    }
    return null; // unhandled event type (ping, star, fork, etc.) — ack without posting
}

app.post('/github-webhook/:id', (req, res) => {
    try {
        if (isRateLimited(req.ip)) return res.status(429).send({ message: 'Too many requests' });

        const projectChannel = db.prepare(`SELECT channel_id, webhook_key FROM webhook_channels WHERE webhook_id = ?`).get(req.params.id);
        if (!projectChannel?.webhook_key) return res.status(401).send({ message: 'Unauthorized' });

        const signature = req.get('X-Hub-Signature-256') || '';
        const expected = 'sha256=' + crypto.createHmac('sha256', projectChannel.webhook_key).update(req.rawBody || Buffer.alloc(0)).digest('hex');
        if (!timingSafeEqualStr(signature, expected)) return res.status(401).send({ message: 'Unauthorized' });

        const event = req.get('X-GitHub-Event');
        if (event === 'ping') return res.status(200).send({ message: 'pong' });

        const action = req.body.action;
        const embed = buildGithubEventEmbed(event, action, req.body);
        if (embed) client.channels.fetch(projectChannel.channel_id).then(channel => channel?.send({ embeds: [embed] })).catch(() => {});

        res.status(200).send({ message: 'OK' });
    } catch (e) {
        console.error('GitHub webhook error:', e);
        res.status(400).send({ message: 'Bad request' });
    }
});

app.post('/webhook/:id', (req, res) => {
    try {
        if (isRateLimited(req.ip)) return res.status(429).send({ message: 'Too many requests' });

        const projectChannel = db.prepare(`SELECT webhook_key FROM webhook_channels WHERE webhook_id = ?`).get(req.params.id);
        const expectedKey = projectChannel?.webhook_key || process.env.WEBHOOK_KEY;
        if (!expectedKey || !timingSafeEqualStr(req.get('X-API-KEY'), expectedKey)) return res.status(401).send({ message: 'Unauthorized' });

        const hasProblem = (req.body.status || 'error').toLowerCase() === 'error';
        dispatchWebhookAlert(req.params.id, clamp(req.body.title, 200), clamp(req.body.message, 3500), hasProblem, req.body.fields);
        res.status(200).send({ message: 'OK' });
    } catch (e) {
        console.error('Webhook error:', e);
        res.status(400).send({ message: 'Bad request' });
    }
});

// ==========================================
// 8. SLASH COMMAND INTERACTIONS
// ==========================================
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused().toLowerCase();
        const choices = interaction.commandName === 'status'
            ? Object.entries(endpoints).map(([id, s]) => ({ name: s.name, value: id }))
            : db.prepare(`SELECT id, name FROM monitored_urls WHERE guild_id = ?`).all(interaction.guildId).map(r => ({ name: `${r.name} (${r.id})`, value: r.id }));
        const filtered = choices.filter(c => c.value.toLowerCase().includes(focused) || c.name.toLowerCase().includes(focused)).slice(0, 25);
        return interaction.respond(filtered).catch(() => {});
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, guildId, member, user } = interaction;
    const isManager = () => hasPermission(member, guildId);

    try {
        if (commandName === 'help') {
            const { embed, row } = buildHelpPanel();
            const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
            attachHelpCollector(msg, user.id);
            return;
        }

        if (commandName === 'status') {
            const sub = interaction.options.getSubcommand();
            if (sub === 'all') {
                const embed = buildStatusAllEmbed(interaction.guild);
                const msg = await interaction.reply({ embeds: [embed], components: [refreshButtonRow()], fetchReply: true });
                attachRefreshCollector(msg, interaction.guild);
                return;
            }
            const id = interaction.options.getString('name');
            const service = endpoints[id];
            if (!service) return interaction.reply({ content: '⚠️ Unknown service.', ephemeral: true });
            await interaction.deferReply();
            const embed = await buildAuditEmbed(service);
            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'config') {
            if (!member?.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ Access denied.', ephemeral: true });
            const channel = interaction.options.getChannel('channel');
            const roles = [interaction.options.getRole('alert-role'), interaction.options.getRole('admin-role')].filter(Boolean).map(r => r.id);
            const embed = doConfig(guildId, user.tag, channel.id, roles);
            return interaction.reply({ embeds: [embed] });
        }

        if (commandName === 'channel') {
            if (!isManager()) return interaction.reply({ content: '❌ Access denied.', ephemeral: true });
            const webhookId = interaction.options.getString('webhook-id').toLowerCase();
            const channel = interaction.options.getChannel('channel');
            const result = doChannelMap(guildId, user.tag, webhookId, channel.id);
            if (result.error === 'taken') return interaction.reply({ content: `❌ \`${webhookId}\` is already owned by another server.`, ephemeral: true });
            return interaction.reply({
                content: `✅ Webhooks for \`${webhookId}\` now land in ${channel}.\n${result.isNew ? `🔑 API key (save it, only shown again with \`/channel-rotate\`): \`${result.key}\`` : `🔑 API key unchanged: \`${result.key}\``}`,
                ephemeral: true
            });
        }

        if (commandName === 'channel-rotate') {
            if (!isManager()) return interaction.reply({ content: '❌ Access denied.', ephemeral: true });
            const webhookId = interaction.options.getString('webhook-id').toLowerCase();
            const result = doChannelRotate(guildId, user.tag, webhookId);
            if (result.error === 'missing') return interaction.reply({ content: `⚠️ No channel mapped for \`${webhookId}\` yet. Use \`/channel\` first.`, ephemeral: true });
            if (result.error === 'taken') return interaction.reply({ content: `❌ \`${webhookId}\` is owned by another server.`, ephemeral: true });
            return interaction.reply({ content: `🔑 New API key for \`${webhookId}\`: \`${result.key}\` (old one stopped working).`, ephemeral: true });
        }

        if (commandName === 'monitor' || commandName === 'monitor-jenkins') {
            if (!isManager()) return interaction.reply({ content: '❌ Access denied.', ephemeral: true });
            const id = interaction.options.getString('id').toLowerCase();
            const url = interaction.options.getString(commandName === 'monitor' ? 'url' : 'job-url');
            const name = interaction.options.getString('name');
            doMonitor(guildId, user.tag, id, url, name, commandName === 'monitor' ? 'url' : 'jenkins');
            return interaction.reply({ embeds: [createEmbed(COLORS.success).setDescription(`✅ \`${id}\` added to the watchlist.`)] });
        }

        if (commandName === 'remove') {
            if (!isManager()) return interaction.reply({ content: '❌ Access denied.', ephemeral: true });
            const id = interaction.options.getString('id').toLowerCase();
            const row = confirmRow();
            const msg = await interaction.reply({ content: `⚠️ Remove \`${id}\` from the watchlist?`, components: [row], fetchReply: true });
            attachRemoveConfirmCollector(msg, user.id, guildId, user.tag, id);
            return;
        }

        if (commandName === 'ssl-ignore') {
            if (!isManager()) return interaction.reply({ content: '❌ Access denied.', ephemeral: true });
            const id = interaction.options.getString('id').toLowerCase();
            doSslIgnore(guildId, user.tag, id);
            return interaction.reply({ embeds: [createEmbed(COLORS.success).setDescription(`✅ SSL audit disabled for \`${id}\`.`)] });
        }

        if (commandName === 'incident') {
            if (!isManager()) return interaction.reply({ content: '❌ Access denied.', ephemeral: true });
            const id = interaction.options.getString('id').toLowerCase();
            const msg = interaction.options.getString('message');
            doIncident(guildId, user.tag, id, msg);
            return interaction.reply({ embeds: [createEmbed(COLORS.info).setDescription(`⚠️ Maintenance enabled for \`${id}\`. Ping suspended.`)] });
        }

        if (commandName === 'resolve') {
            if (!isManager()) return interaction.reply({ content: '❌ Access denied.', ephemeral: true });
            const id = interaction.options.getString('id').toLowerCase();
            doResolve(guildId, user.tag, id);
            return interaction.reply({ embeds: [createEmbed(COLORS.success).setDescription(`✅ Maintenance finished for \`${id}\`.`)] });
        }

        if (commandName === 'report') {
            const embed = doReport(guildId, interaction.options.getInteger('days'));
            return interaction.reply({ embeds: [embed] });
        }

        if (commandName === 'webhook-test') {
            if (!isManager()) return interaction.reply({ content: '❌ Access denied.', ephemeral: true });
            const id = interaction.options.getString('id').toLowerCase();
            dispatchWebhookAlert(id, 'Test Alert', 'This is a test payload from /webhook-test.', false);
            return interaction.reply({ content: `✅ Test alert dispatched for \`${id}\`. Check the mapped channel.`, ephemeral: true });
        }

        if (commandName === 'audit') {
            if (!isManager()) return interaction.reply({ content: '❌ Access denied.', ephemeral: true });
            return interaction.reply({ embeds: [buildAuditLogEmbed(guildId)], ephemeral: true });
        }
    } catch (e) {
        console.error(e);
        const payload = { content: '❌ Something went wrong running that command.', ephemeral: true };
        if (interaction.deferred || interaction.replied) interaction.editReply(payload).catch(() => {});
        else interaction.reply(payload).catch(() => {});
    }
});

function confirmRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_remove').setLabel('Yes, remove').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('cancel_remove').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
}

function attachRemoveConfirmCollector(msg, authorId, guildId, userTag, id) {
    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 30000, max: 1 });
    collector.on('collect', async i => {
        if (i.user.id !== authorId) return i.reply({ content: '🚫 Not your call.', ephemeral: true });
        if (i.customId === 'confirm_remove') {
            const existed = doRemove(guildId, userTag, id);
            await i.update({ content: existed ? `✅ \`${id}\` removed.` : `⚠️ No project with id \`${id}\`.`, components: [] });
        } else {
            await i.update({ content: '❌ Cancelled.', components: [] });
        }
    });
    collector.on('end', collected => {
        if (collected.size === 0) msg.edit({ content: '⌛ Confirmation timed out.', components: [] }).catch(() => {});
    });
}

function attachRefreshCollector(msg, guild) {
    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });
    collector.on('collect', async i => {
        await i.deferUpdate();
        await msg.edit({ embeds: [buildStatusAllEmbed(guild)] });
    });
    collector.on('end', () => msg.edit({ components: [] }).catch(() => {}));
}

function buildHelpPanel() {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('help_public').setLabel('Queries').setEmoji('📊').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('help_config').setLabel('Configuration').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('help_local').setLabel('Local Projects').setEmoji('💻').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('help_webhook').setLabel('Webhooks').setEmoji('📡').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('help_tutorial').setLabel('CI/CD Tutorial').setEmoji('🛠️').setStyle(ButtonStyle.Secondary)
    );
    const embed = createEmbed()
        .setTitle('📚 NOC Bot Documentation')
        .setThumbnail(client.user.displayAvatarURL())
        .setDescription('Pick a category below to see detailed commands, examples and required permissions.\nEvery command also exists as a slash command (`/status`, `/monitor`, ...). Each server has its own watchlist and webhooks — nothing is shared between servers except the third-party status catalog.')
        .setFooter({ text: 'Monitoring & DevOps Center' });
    return { embed, row };
}

function attachHelpCollector(msgHelp, authorId) {
    const row = msgHelp.components[0];
    const collector = msgHelp.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

    collector.on('collect', async i => {
        if (i.user.id !== authorId) return i.reply({ content: '🚫 Use your own !help', ephemeral: true });

        const newEmbed = createEmbed().setFooter({ text: 'NOC Bot • User Manual' });

        if (i.customId === 'help_public') {
            newEmbed.setTitle('📊 Queries and Dashboards')
                .setDescription('Commands available to every user on the server.')
                .addFields(
                    { name: 'Interactive Incident Menu', value: 'Opens a dropdown menu to read the technical updates for a specific service that went down.\n```bash\n!status\n```or `/status service`' },
                    { name: 'Global Dashboard', value: 'Generates a panel with every service organized by stack, showing who is Online 🟩, degraded 🟨 or Offline 🟥 right now. Has a refresh button.\n```bash\n!status all\n```or `/status all`' },
                    { name: 'Uptime Report', value: 'Calculates the percentage of time every system stayed up, and its average response time.\n```bash\n!report [days]\n```or `/report`' }
                );
        } else if (i.customId === 'help_config') {
            newEmbed.setTitle('⚙️ Root Configuration')
                .setDescription('Commands restricted to Discord **Administrators** only.')
                .addFields(
                    { name: 'Alert Engine Setup', value: 'Sets the bot\'s core rules: the channel to post to, who gets pinged on an outage, and who can manage the local project list.\n```bash\n# Usage:\n!config <#channel> <@alertRole> <@managerRole>\n\n# Real example:\n!config #devops @TechTeam @ProjectManagers\n```or `/config`' }
                );
        } else if (i.customId === 'help_local') {
            newEmbed.setTitle('💻 Local Projects & Management')
                .setDescription('Commands restricted to **Administrators** and **Manager Roles**. Your watchlist is private to this server.')
                .addFields(
                    { name: 'Add a URL to the Watchlist', value: 'Pings the URL every 5 minutes and checks SSL (if HTTPS).\n```bash\n!monitor <id> <url> <Display Name>\n```or `/monitor`' },
                    { name: 'Add a Jenkins Job', value: 'Polls `<job-url>/lastBuild/api/json` every 5 minutes. Put basic auth in the URL if needed: `http://user:pass@jenkins-host/job/X`.\n```bash\n!monitor-jenkins <id> <job_url> <Display Name>\n```or `/monitor-jenkins`' },
                    { name: 'Disable SSL Check', value: '```bash\n!ssl ignore <id>\n```or `/ssl-ignore`' },
                    { name: 'Open a Maintenance Incident', value: 'Pauses monitoring while you update your system.\n```bash\n!incident <id> <Message>\n```or `/incident`' },
                    { name: 'Resolve / Remove', value: '`!remove` asks for confirmation before deleting.\n```bash\n!resolve <id>\n!remove <id>\n```or `/resolve`, `/remove`' },
                    { name: 'Audit Log', value: 'Last 10 admin actions on this server.\n```bash\n!audit\n```or `/audit`' }
                );
        } else if (i.customId === 'help_webhook') {
            newEmbed.setTitle('📡 Webhooks & API')
                .setDescription('The bot runs an Express server on port 3000 to receive payloads from any CI/CD pipeline (GitHub Actions, AWS, Jenkins).')
                .addFields(
                    { name: 'POST Structure (JSON)', value: 'Send the request to `http://<bot-ip>:3000/webhook/<project_id>` with the header `X-API-KEY: <key>`\n```json\n{\n  "title": "CloudWatch Alert",\n  "message": "CPU usage hit 90% on the Web Server.",\n  "status": "error" \n}\n```' },
                    { name: 'Channel per Project', value: 'Maps a project to its own channel AND issues it a dedicated API key. Once a server claims a `project_id`, only that server can remap or rotate it — other servers can\'t hijack it by reusing the same id.\n```bash\n!channel <project_id> #channel\n!channel rotate <project_id>\n```or `/channel`, `/channel-rotate`' },
                    { name: 'Test it', value: '```bash\n!webhook test <project_id>\n```or `/webhook-test`' },
                    { name: 'Native GitHub events (push/PR/issue/release/workflow_run)', value: 'Repo → **Settings → Webhooks → Add webhook** → Payload URL `http://<bot-ip>:3000/github-webhook/<project_id>`, content type `application/json`, **Secret** = the key from `!channel`, events: whichever you want. No pipeline code needed — GitHub sends these on its own, formatted per event type (colored embed with commit/PR/issue/release/run details).' }
                );
        } else if (i.customId === 'help_tutorial') {
            newEmbed.setTitle('🛠️ CI/CD Tutorial — Step by Step')
                .setDescription('**0.** Run `!channel my-project #channel` here first — it creates the project and hands you an API key. Use that key below instead of `<KEY>`.')
                .addFields(
                    {
                        name: '1️⃣ GitHub Actions', value:
                            'Repo → **Settings → Secrets and variables → Actions → New repository secret** → name it `DISCORD_KEY`, paste the key from step 0.\n' +
                            'Then add this step to your workflow `.yml`:\n' +
                            '```yaml\n' +
                            '- name: Notify Discord\n' +
                            '  if: always()\n' +
                            '  run: |\n' +
                            '    curl -X POST http://<bot-ip>:3000/webhook/my-project \\\n' +
                            '      -H "X-API-KEY: ${{ secrets.DISCORD_KEY }}" \\\n' +
                            '      -d \'{"title":"${{ github.workflow }}","message":"Run finished","status":"${{ job.status == \'success\' && \'info\' || \'error\' }}"}\'\n' +
                            '```'
                    },
                    {
                        name: '2️⃣ Jenkins (Jenkinsfile)', value:
                            '**Manage Jenkins → Credentials → Add → Secret text** → id `discord-key`, paste the key from step 0.\n' +
                            'Then add to your `Jenkinsfile`:\n' +
                            '```groovy\n' +
                            'environment { DISCORD_KEY = credentials(\'discord-key\') }\n' +
                            'post {\n' +
                            '  always {\n' +
                            '    script {\n' +
                            '      def ok = currentBuild.currentResult == \'SUCCESS\'\n' +
                            '      sh """\n' +
                            '        curl -X POST http://<bot-ip>:3000/webhook/my-project \\\\\n' +
                            '          -H \'X-API-KEY: ${DISCORD_KEY}\' \\\\\n' +
                            '          -d \'{"title":"${JOB_NAME} #${BUILD_NUMBER}","message":"${currentBuild.currentResult}","status":"${ok ? \'info\' : \'error\'}"}\'\n' +
                            '      """\n' +
                            '    }\n' +
                            '  }\n' +
                            '}\n' +
                            '```\n' +
                            'Jenkins behind a VPN only needs *outbound* access to the bot for this — it never needs to reach Jenkins itself, unlike `!monitor-jenkins` polling.'
                    },
                    {
                        name: '3️⃣ Verify', value: 'Push a commit / run the pipeline, or just run `!webhook test my-project` to fire a sample alert without waiting for a real build.'
                    },
                    {
                        name: '✨ Optional: labeled fields (gittrack-style card)', value:
                            'Add a `fields` array to the JSON body for a two-column card instead of plain text:\n' +
                            '```json\n' +
                            '{\n' +
                            '  "title": "Deploy backend → homolog: OK",\n' +
                            '  "status": "info",\n' +
                            '  "fields": [\n' +
                            '    {"name": "Commit", "value": "`${GIT_COMMIT.take(7)}`", "inline": true},\n' +
                            '    {"name": "Environment", "value": "homolog", "inline": true}\n' +
                            '  ]\n' +
                            '}\n' +
                            '```'
                    }
                );
        }

        await i.update({ embeds: [newEmbed], components: [row] });
    });

    collector.on('end', () => msgHelp.edit({ components: [] }).catch(() => {}));
}

// ==========================================
// 9. USER COMMANDS (! prefix)
// ==========================================
const KNOWN_COMMANDS = ['!help', '!config', '!channel', '!monitor', '!monitor-jenkins', '!remove', '!ssl', '!incident', '!resolve', '!report', '!status', '!webhook', '!audit'];

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.trim().split(/ +/);
    const command = args[0].toLowerCase();

    if (command.startsWith('!') && !KNOWN_COMMANDS.includes(command)) {
        return message.reply(`❓ Unknown command \`${command}\`. Try \`!help\`.`);
    }

    // --- INTERACTIVE HELP PANEL ---
    if (command === '!help') {
        const { embed, row } = buildHelpPanel();
        const msgHelp = await message.channel.send({ embeds: [embed], components: [row] });
        attachHelpCollector(msgHelp, message.author.id);
        return;
    }

    // --- ADMIN & MANAGEMENT COMMANDS ---
    if (command === '!config') {
        if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ Access denied.");
        const channel = message.mentions.channels.first();
        const roles = Array.from(message.mentions.roles.values()).map(r => r.id);
        if (!channel) return message.reply("⚠️ Incorrect usage. See `!help` > Configuration.");

        const embed = doConfig(message.guild.id, message.author.tag, channel.id, roles);
        return message.channel.send({ embeds: [embed] });
    }

    if (command === '!channel') {
        if (!hasPermission(message.member, message.guild.id)) return message.reply('❌ Access Denied.');

        if (args[1] === 'rotate') {
            const webhookId = args[2]?.toLowerCase();
            if (!webhookId) return message.reply('⚠️ Usage: `!channel rotate <webhook_id>`');
            const result = doChannelRotate(message.guild.id, message.author.tag, webhookId);
            if (result.error === 'missing') return message.reply(`⚠️ No channel mapped for \`${webhookId}\` yet. Use \`!channel <id> #channel\` first.`);
            if (result.error === 'taken') return message.reply(`❌ \`${webhookId}\` is owned by another server.`);
            return message.reply(`🔑 New API key for \`${webhookId}\`: \`${result.key}\` (old one stopped working).`);
        }

        const webhookId = args[1]?.toLowerCase();
        const channel = message.mentions.channels.first();
        if (!webhookId || !channel) return message.reply('⚠️ Usage: `!channel <webhook_id> #channel`');

        const result = doChannelMap(message.guild.id, message.author.tag, webhookId, channel.id);
        if (result.error === 'taken') return message.reply(`❌ \`${webhookId}\` is already owned by another server.`);
        return message.reply(`✅ Webhooks for \`${webhookId}\` (\`http://<bot-ip>:3000/webhook/${webhookId}\`) now land in ${channel}.\n${result.isNew ? `🔑 API key (save it, only shown again with \`!channel rotate\`): \`${result.key}\`` : `🔑 API key unchanged: \`${result.key}\``}`);
    }

    if (command === '!webhook' && args[1] === 'test') {
        if (!hasPermission(message.member, message.guild.id)) return message.reply('❌ Access Denied.');
        const webhookId = args[2]?.toLowerCase();
        if (!webhookId) return message.reply('⚠️ Usage: `!webhook test <webhook_id>`');
        dispatchWebhookAlert(webhookId, 'Test Alert', 'This is a test payload from !webhook test.', false);
        return message.reply(`✅ Test alert dispatched for \`${webhookId}\`. Check the mapped channel.`);
    }

    if (command === '!audit') {
        if (!hasPermission(message.member, message.guild.id)) return message.reply('❌ Access Denied.');
        return message.channel.send({ embeds: [buildAuditLogEmbed(message.guild.id)] });
    }

    if (command === '!remove') {
        if (!hasPermission(message.member, message.guild.id)) return message.reply('❌ Access Denied.');
        const serviceId = args[1]?.toLowerCase();
        if (!serviceId) return message.reply('⚠️ Usage: `!remove <id>`');

        const confirmMsg = await message.reply({ content: `⚠️ Remove \`${serviceId}\` from the watchlist?`, components: [confirmRow()] });
        attachRemoveConfirmCollector(confirmMsg, message.author.id, message.guild.id, message.author.tag, serviceId);
        return;
    }

    if (['!monitor', '!monitor-jenkins', '!ssl', '!incident', '!resolve'].includes(command)) {
        if (!hasPermission(message.member, message.guild.id)) return message.reply('❌ Access Denied.');
        const serviceId = args[1]?.toLowerCase();

        try {
            if (command === '!monitor' || command === '!monitor-jenkins') {
                if (!serviceId || !args[2] || !args[3]) return message.reply("⚠️ Incorrect syntax. See examples in `!help`.");
                doMonitor(message.guild.id, message.author.tag, serviceId, args[2], args.slice(3).join(' '), command === '!monitor' ? 'url' : 'jenkins');
                return message.reply(`✅ \`${serviceId}\` added to the watchlist.`);
            }
            if (command === '!ssl' && args[1] === 'ignore') {
                doSslIgnore(message.guild.id, message.author.tag, args[2]);
                return message.reply(`✅ SSL audit disabled for \`${args[2]}\`.`);
            }
            if (command === '!incident') {
                doIncident(message.guild.id, message.author.tag, serviceId, args.slice(2).join(' '));
                return message.reply(`⚠️ Maintenance enabled. Ping suspended for \`${serviceId}\`.`);
            }
            if (command === '!resolve') {
                doResolve(message.guild.id, message.author.tag, serviceId);
                return message.reply(`✅ Maintenance finished for \`${serviceId}\`.`);
            }
        } catch (e) { return message.reply("❌ Syntax failure or SQLite error."); }
    }

    // --- DASHBOARDS & REPORTS ---
    if (command === '!report') {
        const days = args[1] ? parseInt(args[1], 10) : 7;
        return message.channel.send({ embeds: [doReport(message.guild.id, days)] });
    }

    if (command === '!status') {
        if (args[1] === 'all') {
            const embed = buildStatusAllEmbed(message.guild);
            const msg = await message.channel.send({ embeds: [embed], components: [refreshButtonRow()] });
            attachRefreshCollector(msg, message.guild);
            return;
        }

        const msgMenu = await message.channel.send({ embeds: [createEmbed().setDescription('📊 Pick a global target to investigate technical logs:')], components: buildStatusSelectRows(0) });

        const collector = msgMenu.createMessageComponentCollector({ time: 60000 });
        collector.on('collect', async i => {
            if (i.user.id !== message.author.id) return i.reply({ content: '🚫 Forbidden.', ephemeral: true });

            if (i.isButton() && i.customId.startsWith('status_page:')) {
                const page = parseInt(i.customId.split(':')[1], 10);
                return i.update({ components: buildStatusSelectRows(page) });
            }
            if (i.isStringSelectMenu()) {
                const page = parseInt(i.customId.split(':')[1] || '0', 10);
                const service = endpoints[i.values[0]];
                await i.deferUpdate();
                const embed = await buildAuditEmbed(service);
                await msgMenu.edit({ embeds: [embed], components: buildStatusSelectRows(page) });
            }
        });
        collector.on('end', () => msgMenu.edit({ components: [] }).catch(() => {}));
    }
});

client.login(process.env.DISCORD_TOKEN);
