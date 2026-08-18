const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ComponentType, Events } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const Database = require('better-sqlite3');
const express = require('express');
const cors = require('cors');
const sslChecker = require('ssl-checker');
require('dotenv').config();

// ==========================================
// 1. SERVICE INITIALIZATION
// ==========================================
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const app = express();
app.use(express.json());
app.use(cors());

const db = new Database('./bot_data.sqlite');

db.exec(`
    CREATE TABLE IF NOT EXISTS guild_configs (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT,
        alert_role TEXT,
        admin_role TEXT
    );
    CREATE TABLE IF NOT EXISTS monitored_urls (
        id TEXT PRIMARY KEY,
        name TEXT,
        url TEXT,
        manual_incident TEXT,
        ignore_ssl INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS uptime_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT,
        status TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS webhook_channels (
        webhook_id TEXT PRIMARY KEY,
        channel_id TEXT
    );
`);

let endpoints = {};
let lastStatus = {};
let lastStatusMonitoredUrls = {};

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

const axiosConfig = {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
};

client.once(Events.ClientReady, () => {
    loadEndpoints();
    for (const key in endpoints) lastStatus[key] = 'none';

    const urls = db.prepare(`SELECT id FROM monitored_urls`).all();
    urls.forEach(row => lastStatusMonitoredUrls[row.id] = 'up');

    console.log(`✅ NOC Bot online! Logged in as ${client.user.tag}`);
    globalMonitoring();
    setInterval(globalMonitoring, 300000);

    app.listen(3000, () => console.log('🌐 Webhook server active on port 3000'));
});

// ==========================================
// 2. SUPPORT FUNCTIONS
// ==========================================
function hasPermission(message, guildId) {
    if (message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    const config = db.prepare(`SELECT admin_role FROM guild_configs WHERE guild_id = ?`).get(guildId);
    if (config && config.admin_role && message.member?.roles.cache.has(config.admin_role)) return true;
    return false;
}

// Single visual base — every embed the bot sends is born here, so nothing drifts into its own look.
const COLORS = { danger: '#ED4245', success: '#57F287', info: '#3498DB', neutral: '#2B2D31' };

function createEmbed(color = COLORS.neutral) {
    return new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: 'NOC Bot', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
}

function broadcastAlert(alertEmbed, hasProblem) {
    alertEmbed.setColor(hasProblem ? COLORS.danger : COLORS.success);
    alertEmbed.setTitle(hasProblem ? '🚨 Infrastructure Alert' : '✅ Systems Back to Normal');

    const guilds = db.prepare(`SELECT guild_id, channel_id, alert_role FROM guild_configs`).all();
    for (const config of guilds) {
        client.channels.fetch(config.channel_id).then(channel => {
            if (channel) {
                const mention = (hasProblem && config.alert_role) ? `<@&${config.alert_role}> ` : '';
                channel.send({ content: mention, embeds: [alertEmbed] });
            }
        }).catch(() => {});
    }
}

// ==========================================
// 3. GLOBAL MONITORING ENGINE
// ==========================================
async function globalMonitoring() {
    let hasChanged = false;
    const alertEmbed = createEmbed().setFooter({ text: 'Automated NOC Center' });
    let hasProblem = false;
    const insertHistory = db.prepare(`INSERT INTO uptime_history (service_id, status) VALUES (?, ?)`);

    for (const [key, service] of Object.entries(endpoints)) {
        try {
            if (service.type !== 'atlassian') continue;
            const response = await axios.get(service.url, axiosConfig);
            const currentStatus = response.data.status.indicator;

            if (!lastStatus[key]) lastStatus[key] = 'none';
            if (currentStatus !== 'none' && currentStatus !== lastStatus[key]) {
                hasChanged = true; hasProblem = true;
                alertEmbed.addFields({ name: `🔴 ${service.name}`, value: response.data.status.description });
            } else if (currentStatus === 'none' && lastStatus[key] !== 'none') {
                hasChanged = true;
                alertEmbed.addFields({ name: `✅ ${service.name}`, value: 'Operations back to normal.' });
            }
            lastStatus[key] = currentStatus;
            insertHistory.run(key, currentStatus === 'none' ? 'UP' : 'DOWN');
        } catch (error) { }
    }

    const urls = db.prepare(`SELECT id, name, url, manual_incident, ignore_ssl FROM monitored_urls`).all();
    for (const site of urls) {
        if (site.manual_incident) {
            if (lastStatusMonitoredUrls[site.id] !== 'maintenance') {
                hasChanged = true; hasProblem = true;
                alertEmbed.addFields({ name: `🔧 Maintenance: ${site.name}`, value: site.manual_incident });
                lastStatusMonitoredUrls[site.id] = 'maintenance';
            }
            insertHistory.run(site.id, 'DOWN');
            continue;
        }

        try {
            if (site.url.startsWith('https://') && site.ignore_ssl === 0) {
                const domain = new URL(site.url).hostname;
                const sslStatus = await sslChecker(domain, { method: "GET", port: 443 });
                if (sslStatus.daysRemaining <= 7 && sslStatus.daysRemaining > 0) {
                    hasChanged = true; hasProblem = true;
                    alertEmbed.addFields({ name: `🔐 SSL Warning: ${site.name}`, value: `Expires in **${sslStatus.daysRemaining} days**.` });
                } else if (sslStatus.daysRemaining <= 0) {
                    throw new Error("SSL_EXPIRED");
                }
            }
            await axios.get(site.url, { timeout: 10000 });

            if (lastStatusMonitoredUrls[site.id] === 'down') {
                hasChanged = true;
                alertEmbed.addFields({ name: `✅ Online: ${site.name}`, value: `Connection restored.` });
            }
            lastStatusMonitoredUrls[site.id] = 'up';
            insertHistory.run(site.id, 'UP');
        } catch (error) {
            let reason = 'Connection failure (Timeout/HTTP Error)';
            if (error.message === 'SSL_EXPIRED' || error.code === 'CERT_HAS_EXPIRED') reason = 'Invalid/Expired SSL Certificate';

            if (lastStatusMonitoredUrls[site.id] !== 'down') {
                hasChanged = true; hasProblem = true;
                alertEmbed.addFields({ name: `🚨 Offline: ${site.name}`, value: reason });
            }
            lastStatusMonitoredUrls[site.id] = 'down';
            insertHistory.run(site.id, 'DOWN');
        }
    }
    if (hasChanged) broadcastAlert(alertEmbed, hasProblem);
}

// ==========================================
// 4. WEBHOOKS
// ==========================================
app.post('/webhook/:id', (req, res) => {
    if (req.get('X-API-KEY') !== process.env.WEBHOOK_KEY) return res.status(401).send({ message: 'Unauthorized' });

    const hasProblem = (req.body.status || 'error').toLowerCase() === 'error';
    const hookEmbed = createEmbed(hasProblem ? COLORS.danger : COLORS.info)
        .setTitle(`📡 Webhook [${req.params.id}]: ${req.body.title || 'External Alert'}`)
        .setDescription(req.body.message || 'Event received.');

    const projectChannel = db.prepare(`SELECT channel_id FROM webhook_channels WHERE webhook_id = ?`).get(req.params.id);
    if (projectChannel) {
        client.channels.fetch(projectChannel.channel_id).then(channel => channel?.send({ embeds: [hookEmbed] })).catch(() => {});
    } else {
        broadcastAlert(hookEmbed, hasProblem);
    }
    res.status(200).send({ message: 'OK' });
});

// ==========================================
// 5. USER COMMANDS
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.trim().split(/ +/);
    const command = args[0].toLowerCase();

    // --- INTERACTIVE HELP PANEL ---
    if (command === '!help') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('help_public').setLabel('Queries').setEmoji('📊').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('help_config').setLabel('Configuration').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('help_local').setLabel('Local Projects').setEmoji('💻').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('help_webhook').setLabel('Webhooks').setEmoji('📡').setStyle(ButtonStyle.Secondary)
        );

        const embedBase = createEmbed()
            .setTitle('📚 NOC Bot Documentation')
            .setThumbnail(client.user.displayAvatarURL())
            .setDescription('Pick a category below to see detailed commands, examples and required permissions.')
            .setFooter({ text: 'Monitoring & DevOps Center' });

        const msgHelp = await message.channel.send({ embeds: [embedBase], components: [row] });
        const collector = msgHelp.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

        collector.on('collect', async i => {
            if (i.user.id !== message.author.id) return i.reply({ content: '🚫 Use your own !help', ephemeral: true });

            const newEmbed = createEmbed().setFooter({ text: 'NOC Bot • User Manual' });

            if (i.customId === 'help_public') {
                newEmbed.setTitle('📊 Queries and Dashboards')
                    .setDescription('Commands available to every user on the server.')
                    .addFields(
                        { name: 'Interactive Incident Menu', value: 'Opens a dropdown menu to read the technical updates for a specific service that went down.\n```bash\n!status\n```' },
                        { name: 'Global Dashboard', value: 'Generates a panel with every service organized by stack, showing who is Online 🟩 or Offline 🟥 right now.\n```bash\n!status all\n```' },
                        { name: 'Weekly Uptime Report', value: 'Calculates the percentage of time every system stayed up over the last 7 days.\n```bash\n!report\n```' }
                    );
            } else if (i.customId === 'help_config') {
                newEmbed.setTitle('⚙️ Root Configuration')
                    .setDescription('Commands restricted to Discord **Administrators** only.')
                    .addFields(
                        { name: 'Alert Engine Setup', value: 'Sets the bot\'s core rules: the channel to post to, who gets pinged on an outage, and who can manage the local project list.\n```bash\n# Usage:\n!config <#channel> <@alertRole> <@managerRole>\n\n# Real example:\n!config #devops @TechTeam @ProjectManagers\n```' }
                    );
            } else if (i.customId === 'help_local') {
                newEmbed.setTitle('💻 Local Projects & Management')
                    .setDescription('Commands restricted to **Administrators** and **Manager Roles**.')
                    .addFields(
                        { name: 'Add Project to the Watchlist', value: 'The bot will ping the URL every 5 minutes and check SSL (if HTTPS).\n```bash\n# Usage:\n!monitor <id> <url> <Display Name>\n\n# Example:\n!monitor test_api https://api.site.com Node Backend API\n```' },
                        { name: 'Disable SSL Check', value: 'Useful for internal APIs without HTTPS or with self-signed certificates.\n```bash\n# Usage:\n!ssl ignore <id>\n\n# Example:\n!ssl ignore test_api\n```' },
                        { name: 'Open a Maintenance Incident', value: 'Pauses monitoring while you update your system, so it doesn\'t flood false error alerts.\n```bash\n# Usage:\n!incident <id> <Message>\n\n# Example:\n!incident test_api Database migration\n```' },
                        { name: 'Resolve Incident / Remove Project', value: '```bash\n# Resume ping after maintenance:\n!resolve test_api\n\n# Remove a service permanently:\n!remove test_api\n```' }
                    );
            } else if (i.customId === 'help_webhook') {
                newEmbed.setTitle('📡 Webhooks & API')
                    .setDescription('The bot runs an Express server on port 3000 to receive payloads from any CI/CD pipeline (GitHub Actions, AWS, Vercel).')
                    .addFields(
                        { name: 'POST Structure (JSON)', value: 'Send the request to `http://<bot-ip>:3000/webhook/<project_id>` with the header `X-API-KEY: <WEBHOOK_KEY from .env>`\n```json\n{\n  "title": "CloudWatch Alert",\n  "message": "CPU usage hit 90% on the Web Server.",\n  "status": "error" \n}\n```\n*Tip: status can be "error" (Red Alert) or "info" (Blue Alert).*' },
                        { name: 'Channel per Project', value: 'By default, every webhook falls back to the global broadcast on every server. To isolate a project into its own channel:\n```bash\n!channel <project_id> #channel\n```' }
                    );
            }

            await i.update({ embeds: [newEmbed], components: [row] });
        });

        collector.on('end', () => msgHelp.edit({ components: [] }).catch(()=>null));
        return;
    }

    // --- ADMIN & MANAGEMENT COMMANDS ---
    if (command === '!config') {
        if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ Access denied.");
        const channel = message.mentions.channels.first();
        const roles = Array.from(message.mentions.roles.values());
        if (!channel) return message.reply("⚠️ Incorrect usage. See `!help` > Configuration.");

        db.prepare(`INSERT OR REPLACE INTO guild_configs (guild_id, channel_id, alert_role, admin_role) VALUES (?, ?, ?, ?)`).run(message.guild.id, channel.id, roles[0]?.id || null, roles[1]?.id || null);
        return message.channel.send({ embeds: [createEmbed(COLORS.success).setDescription(`✅ Configuration saved and linked to ${channel}.`)] });
    }

    if (command === '!channel') {
        if (!hasPermission(message, message.guild.id)) return message.reply('❌ Access Denied.');
        const webhookId = args[1]?.toLowerCase();
        const channel = message.mentions.channels.first();
        if (!webhookId || !channel) return message.reply('⚠️ Usage: `!channel <webhook_id> #channel`');

        db.prepare(`INSERT OR REPLACE INTO webhook_channels (webhook_id, channel_id) VALUES (?, ?)`).run(webhookId, channel.id);
        return message.reply(`✅ Webhooks for \`${webhookId}\` (\`http://<bot-ip>:3000/webhook/${webhookId}\`) now land in ${channel}.`);
    }

    if (['!monitor', '!remove', '!ssl', '!incident', '!resolve'].includes(command)) {
        if (!hasPermission(message, message.guild.id)) return message.reply('❌ Access Denied.');
        const serviceId = args[1]?.toLowerCase();

        try {
            if (command === '!monitor') {
                if(!serviceId || !args[2]) return message.reply("⚠️ Incorrect syntax. See examples in `!help`.");
                db.prepare(`INSERT OR REPLACE INTO monitored_urls (id, name, url, ignore_ssl) VALUES (?, ?, ?, 0)`).run(serviceId, args.slice(3).join(' '), args[2]);
                lastStatusMonitoredUrls[serviceId] = 'up';
                return message.reply(`✅ Endpoint \`${serviceId}\` added to the watchlist.`);
            }
            if (command === '!remove') {
                db.prepare(`DELETE FROM monitored_urls WHERE id = ?`).run(serviceId);
                return message.reply(`✅ Service \`${serviceId}\` removed.`);
            }
            if (command === '!ssl' && args[1] === 'ignore') {
                db.prepare(`UPDATE monitored_urls SET ignore_ssl = 1 WHERE id = ?`).run(args[2]);
                return message.reply(`✅ SSL audit disabled for \`${args[2]}\`.`);
            }
            if (command === '!incident') {
                db.prepare(`UPDATE monitored_urls SET manual_incident = ? WHERE id = ?`).run(args.slice(2).join(' ') || 'Maintenance', serviceId);
                return message.reply(`⚠️ Maintenance enabled. Ping suspended for \`${serviceId}\`.`);
            }
            if (command === '!resolve') {
                db.prepare(`UPDATE monitored_urls SET manual_incident = NULL WHERE id = ?`).run(serviceId);
                lastStatusMonitoredUrls[serviceId] = 'down';
                return message.reply(`✅ Maintenance finished for \`${serviceId}\`.`);
            }
        } catch (e) { return message.reply("❌ Syntax failure or SQLite error."); }
    }

    // --- DASHBOARDS & REPORTS ---
    if (command === '!report') {
        const records = db.prepare(`SELECT service_id, status FROM uptime_history WHERE timestamp >= datetime('now', '-7 days')`).all();
        if (records.length === 0) return message.channel.send({ embeds: [createEmbed().setDescription("📊 Collecting baseline data. Check back later.")] });

        const stats = {};
        records.forEach(r => {
            if (!stats[r.service_id]) stats[r.service_id] = { up: 0, total: 0 };
            stats[r.service_id].total++;
            if (r.status === 'UP') stats[r.service_id].up++;
        });

        const embed = createEmbed().setTitle('📈 Weekly Uptime').setFooter({ text: '🟩 ≥98%  🟨 ≥90%  🟥 <90% (last 7 days)' });
        let thirdPartyText = '', localText = '';

        for (const [id, data] of Object.entries(stats)) {
            const percentage = ((data.up / data.total) * 100).toFixed(2);
            const filled = Math.round(percentage / 10);
            const bar = (percentage < 90 ? '🟥' : (percentage < 98 ? '🟨' : '🟩')).repeat(filled) + '⬛'.repeat(10 - filled);

            let name = endpoints[id] ? endpoints[id].name : (db.prepare(`SELECT name FROM monitored_urls WHERE id = ?`).get(id)?.name || id);
            const line = `${bar} \`${percentage.padStart(6, ' ')}%\` **${name}**\n`;
            if (endpoints[id]) thirdPartyText += line; else localText += line;
        }

        if (thirdPartyText) embed.addFields({ name: 'Third-Party', value: thirdPartyText });
        if (localText) embed.addFields({ name: 'Local', value: localText });
        return message.channel.send({ embeds: [embed] });
    }

    if (command === '!status') {
        if (args[1] === 'all') {
            const panelEmbed = createEmbed()
                .setTitle('🌐 Global Operations Dashboard')
                .setDescription('Instant status of the dev watchlist, grouped by stack.')
                .setThumbnail(message.guild.iconURL() || client.user.displayAvatarURL())
                .setFooter({ text: '🟩 Online   🟥 Offline   🟨 Maintenance' });

            // Stack definitions
            const stacks = {
                '☁️ Cloud & Infra': ['cloudflare', 'vercel', 'docker', 'render', 'railway', 'aws'],
                '🗄️ Databases & Backend': ['supabase', 'planetscale', 'redis'],
                '🧠 AI': ['openai', 'anthropic', 'huggingface'],
                '🛠️ DevTools & APIs': ['github', 'npm', 'pypi', 'discord', 'postman', 'sentry'],
                '💳 Payments': ['stripe']
            };

            const formatLine = (key, service) => {
                const isUp = lastStatus[key] === 'none';
                const emoji = isUp ? '🟩' : '🟥';
                let shortName = service.name.substring(0, 18);
                if (service.name.length > 18) shortName += '..';
                return `${emoji} \`${shortName.padEnd(20, ' ')}\`\n`;
            };

            const panels = {};
            for (const [key, service] of Object.entries(endpoints)) {
                let foundStack = '🧩 Other Services';
                for (const [stackName, keyList] of Object.entries(stacks)) {
                    if (keyList.includes(key)) { foundStack = stackName; break; }
                }
                if (!panels[foundStack]) panels[foundStack] = '';
                panels[foundStack] += formatLine(key, service);
            }

            for (const [stack, text] of Object.entries(panels)) {
                panelEmbed.addFields({ name: stack, value: text, inline: true });
            }

            let localText = '';
            const projects = db.prepare(`SELECT id, name, manual_incident FROM monitored_urls`).all();
            if (projects.length > 0) {
                for (const p of projects) {
                    if (p.manual_incident) {
                        localText += `🟨 \`${p.name.substring(0,25).padEnd(25, ' ')}\` *(Maintenance)*\n`;
                    } else {
                        const isUp = lastStatusMonitoredUrls[p.id] === 'up';
                        localText += `${isUp ? '🟩' : '🟥'} \`${p.name.substring(0,25).padEnd(25, ' ')}\`\n`;
                    }
                }
            } else {
                localText = '```\nNo local project on the watchlist.\n```';
            }

            panelEmbed.addFields(
                { name: '​', value: '​', inline: false },
                { name: '💻 Your Local Applications', value: localText, inline: false }
            );

            return message.channel.send({ embeds: [panelEmbed] });
        }

        const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('sel_status').setPlaceholder('Audit a service...').addOptions(Object.entries(endpoints).map(([id, service]) => ({ label: service.name, value: id })).slice(0, 25)));
        const msgMenu = await message.channel.send({ embeds: [createEmbed().setDescription('📊 Pick a global target to investigate technical logs:')], components: [row] });

        const collector = msgMenu.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });
        collector.on('collect', async i => {
            if (i.user.id !== message.author.id) return i.reply({ content: '🚫 Forbidden.', ephemeral: true });
            const service = endpoints[i.values[0]];
            await i.deferUpdate();
            try {
                // summary.json covers both open incidents AND in-progress scheduled maintenance —
                // incidents.json alone misses maintenance windows, which can also flip the indicator.
                const response = await axios.get(service.url.replace('status.json', 'summary.json'), axiosConfig);
                const incident = response.data.incidents.find(inc => inc.status !== 'resolved');
                const maintenance = response.data.scheduled_maintenances.find(m => m.status === 'in_progress');
                const event = incident || maintenance;
                const embed = createEmbed(event ? COLORS.danger : COLORS.success).setTitle(`🔍 Audit: ${service.name}`);
                if (!event) embed.setDescription('🟢 No anomalies reported.');
                else {
                    const icon = incident ? '⚠️' : '🔧';
                    embed.setDescription(`${icon} **${event.name}**\n${event.incident_updates.slice(0, 2).map(up => `> **[${up.status.toUpperCase()}]** - ${up.body}`).join('\n\n')}`);
                }
                await msgMenu.edit({ embeds: [embed], components: [row] });
            } catch(e) { }
        });
        collector.on('end', () => msgMenu.edit({ components: [] }).catch(()=>null));
    }
});

client.login(process.env.DISCORD_TOKEN);
