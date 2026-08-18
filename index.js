const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ComponentType, Events } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const Database = require('better-sqlite3');
const express = require('express');
const cors = require('cors');
const sslChecker = require('ssl-checker');
require('dotenv').config();

// ==========================================
// 1. INICIALIZAÇÃO DE SERVIÇOS
// ==========================================
const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

const app = express();
app.use(express.json());
app.use(cors());

const db = new Database('./dados_bot.sqlite');

db.exec(`
    CREATE TABLE IF NOT EXISTS servidores (
        guild_id TEXT PRIMARY KEY,
        canal_id TEXT,
        cargo_alerta TEXT,
        cargo_admin TEXT
    );
    CREATE TABLE IF NOT EXISTS minhas_urls (
        id TEXT PRIMARY KEY,
        nome TEXT,
        url TEXT,
        incidente_manual TEXT,
        ignorar_ssl INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS historico_uptime (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        servico_id TEXT,
        status TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS webhooks_canais (
        webhook_id TEXT PRIMARY KEY,
        canal_id TEXT
    );
`);

let endpoints = {};
let ultimoStatus = {};
let ultimoStatusMinhasUrls = {};

function carregarEndpoints() {
    try {
        if (fs.existsSync('./endpoints.json')) {
            endpoints = JSON.parse(fs.readFileSync('./endpoints.json', 'utf8'));
        } else {
            endpoints = {
                github: { nome: 'GitHub', url: '[https://www.githubstatus.com/api/v2/status.json](https://www.githubstatus.com/api/v2/status.json)', tipo: 'atlassian' },
                openai: { nome: 'OpenAI', url: '[https://status.openai.com/api/v2/status.json](https://status.openai.com/api/v2/status.json)', tipo: 'atlassian' },
                cloudflare: { nome: 'Cloudflare', url: '[https://www.cloudflarestatus.com/api/v2/status.json](https://www.cloudflarestatus.com/api/v2/status.json)', tipo: 'atlassian' },
                vercel: { nome: 'Vercel', url: '[https://www.vercel-status.com/api/v2/status.json](https://www.vercel-status.com/api/v2/status.json)', tipo: 'atlassian' },
                docker: { nome: 'Docker', url: '[https://status.docker.com/api/v2/status.json](https://status.docker.com/api/v2/status.json)', tipo: 'atlassian' },
                npm: { nome: 'NPM', url: '[https://status.npmjs.org/api/v2/status.json](https://status.npmjs.org/api/v2/status.json)', tipo: 'atlassian' }
            };
            fs.writeFileSync('./endpoints.json', JSON.stringify(endpoints, null, 2));
        }
    } catch (e) { console.error(e); }
}

const axiosConfig = {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
};

client.once(Events.ClientReady, () => {
    carregarEndpoints();
    for (const chave in endpoints) ultimoStatus[chave] = 'none';
    
    const urls = db.prepare(`SELECT id FROM minhas_urls`).all();
    urls.forEach(row => ultimoStatusMinhasUrls[row.id] = 'up');

    console.log(`✅ NOC Bot online! Logado como ${client.user.tag}`);
    MonitoramentoGlobal(); 
    setInterval(MonitoramentoGlobal, 300000); 
    
    app.listen(3000, () => console.log('🌐 Servidor de Webhooks ativo na porta 3000'));
});

// ==========================================
// 2. FUNÇÕES DE SUPORTE
// ==========================================
function temPermissao(message, guildId) {
    if (message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    const config = db.prepare(`SELECT cargo_admin FROM servidores WHERE guild_id = ?`).get(guildId);
    if (config && config.cargo_admin && message.member?.roles.cache.has(config.cargo_admin)) return true;
    return false;
}

// Paleta e base visual únicas — todo embed do bot nasce daqui, pra não ficar cada um de um jeito.
const CORES = { perigo: '#ED4245', sucesso: '#57F287', info: '#3498DB', neutro: '#2B2D31' };

function criarEmbed(cor = CORES.neutro) {
    return new EmbedBuilder()
        .setColor(cor)
        .setAuthor({ name: 'NOC Bot', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
}

function dispararAlertasParaServidores(alertaEmbed, temProblema) {
    alertaEmbed.setColor(temProblema ? '#ED4245' : '#57F287');
    alertaEmbed.setTitle(temProblema ? '🚨 Alerta de Infraestrutura' : '✅ Sistemas Normalizados');

    const servidores = db.prepare(`SELECT guild_id, canal_id, cargo_alerta FROM servidores`).all();
    for (const config of servidores) {
        client.channels.fetch(config.canal_id).then(canal => {
            if (canal) {
                const mencao = (temProblema && config.cargo_alerta) ? `<@&${config.cargo_alerta}> ` : '';
                canal.send({ content: mencao, embeds: [alertaEmbed] });
            }
        }).catch(() => {}); 
    }
}

// ==========================================
// 3. MOTOR DE MONITORAMENTO GLOBAL
// ==========================================
async function MonitoramentoGlobal() {
    let houveMudanca = false;
    const alertaEmbed = criarEmbed().setFooter({ text: 'Central NOC Automática' });
    let temProblema = false;
    const insertHistorico = db.prepare(`INSERT INTO historico_uptime (servico_id, status) VALUES (?, ?)`);

    for (const [chave, servico] of Object.entries(endpoints)) {
        try {
            if (servico.tipo !== 'atlassian') continue;
            const response = await axios.get(servico.url, axiosConfig);
            const statusAtual = response.data.status.indicator;

            if (!ultimoStatus[chave]) ultimoStatus[chave] = 'none';
            if (statusAtual !== 'none' && statusAtual !== ultimoStatus[chave]) {
                houveMudanca = true; temProblema = true;
                alertaEmbed.addFields({ name: `🔴 ${servico.nome}`, value: response.data.status.description });
            } else if (statusAtual === 'none' && ultimoStatus[chave] !== 'none') {
                houveMudanca = true;
                alertaEmbed.addFields({ name: `✅ ${servico.nome}`, value: 'Operações normalizadas.' });
            }
            ultimoStatus[chave] = statusAtual;
            insertHistorico.run(chave, statusAtual === 'none' ? 'UP' : 'DOWN');
        } catch (error) { }
    }

    const urls = db.prepare(`SELECT id, nome, url, incidente_manual, ignorar_ssl FROM minhas_urls`).all();
    for (const site of urls) {
        if (site.incidente_manual) {
            if (ultimoStatusMinhasUrls[site.id] !== 'maintenance') {
                houveMudanca = true; temProblema = true;
                alertaEmbed.addFields({ name: `🔧 Manutenção: ${site.nome}`, value: site.incidente_manual });
                ultimoStatusMinhasUrls[site.id] = 'maintenance';
            }
            insertHistorico.run(site.id, 'DOWN');
            continue; 
        }

        try {
            if (site.url.startsWith('https://') && site.ignorar_ssl === 0) {
                const domain = new URL(site.url).hostname;
                const sslStatus = await sslChecker(domain, { method: "GET", port: 443 });
                if (sslStatus.daysRemaining <= 7 && sslStatus.daysRemaining > 0) {
                    houveMudanca = true; temProblema = true;
                    alertaEmbed.addFields({ name: `🔐 Aviso SSL: ${site.nome}`, value: `Expira em **${sslStatus.daysRemaining} dias**.` });
                } else if (sslStatus.daysRemaining <= 0) {
                    throw new Error("SSL_EXPIRED");
                }
            }
            await axios.get(site.url, { timeout: 10000 });
            
            if (ultimoStatusMinhasUrls[site.id] === 'down') {
                houveMudanca = true;
                alertaEmbed.addFields({ name: `✅ Online: ${site.nome}`, value: `Conexão restaurada.` });
            }
            ultimoStatusMinhasUrls[site.id] = 'up';
            insertHistorico.run(site.id, 'UP');
        } catch (error) {
            let motivo = 'Falha de conexão (Timeout/Erro HTTP)';
            if (error.message === 'SSL_EXPIRED' || error.code === 'CERT_HAS_EXPIRED') motivo = 'Certificado SSL Inválido/Expirado';

            if (ultimoStatusMinhasUrls[site.id] !== 'down') {
                houveMudanca = true; temProblema = true;
                alertaEmbed.addFields({ name: `🚨 Offline: ${site.nome}`, value: motivo });
            }
            ultimoStatusMinhasUrls[site.id] = 'down';
            insertHistorico.run(site.id, 'DOWN');
        }
    }
    if (houveMudanca) dispararAlertasParaServidores(alertaEmbed, temProblema);
}

// ==========================================
// 4. WEBHOOKS
// ==========================================
app.post('/webhook/:id', (req, res) => {
    if (req.get('X-API-KEY') !== process.env.WEBHOOK_KEY) return res.status(401).send({ message: 'Unauthorized' });

    const temProblema = (req.body.status || 'erro').toLowerCase() === 'erro';
    const hookEmbed = criarEmbed(temProblema ? CORES.perigo : CORES.info)
        .setTitle(`📡 Webhook [${req.params.id}]: ${req.body.titulo || 'Alerta Externa'}`)
        .setDescription(req.body.mensagem || 'Evento recebido.');

    const canalDoProjeto = db.prepare(`SELECT canal_id FROM webhooks_canais WHERE webhook_id = ?`).get(req.params.id);
    if (canalDoProjeto) {
        client.channels.fetch(canalDoProjeto.canal_id).then(canal => canal?.send({ embeds: [hookEmbed] })).catch(() => {});
    } else {
        dispararAlertasParaServidores(hookEmbed, temProblema);
    }
    res.status(200).send({ message: 'OK' });
});

// ==========================================
// 5. COMANDOS DO USUÁRIO
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.trim().split(/ +/);
    const comando = args[0].toLowerCase();

    // --- PAINEL DE AJUDA INTERATIVO ---
    if (comando === '!help') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('help_public').setLabel('Consultas').setEmoji('📊').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('help_config').setLabel('Configuração').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('help_local').setLabel('Projetos Locais').setEmoji('💻').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('help_webhook').setLabel('Webhooks').setEmoji('📡').setStyle(ButtonStyle.Secondary)
        );

        const embedBase = criarEmbed()
            .setTitle('📚 Documentação do NOC Bot')
            .setThumbnail(client.user.displayAvatarURL())
            .setDescription('Selecione uma categoria abaixo para ver os comandos detalhados, exemplos e permissões necessárias.')
            .setFooter({ text: 'Central de Monitoramento e DevOps' });

        const msgHelp = await message.channel.send({ embeds: [embedBase], components: [row] });
        const collector = msgHelp.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

        collector.on('collect', async i => {
            if (i.user.id !== message.author.id) return i.reply({ content: '🚫 Use seu próprio !help', ephemeral: true });

            const newEmbed = criarEmbed().setFooter({ text: 'NOC Bot • Manual do Usuário' });

            if (i.customId === 'help_public') {
                newEmbed.setTitle('📊 Consultas e Dashboards')
                    .setDescription('Comandos disponíveis para todos os usuários do servidor.')
                    .addFields(
                        { name: 'Menu Interativo de Incidentes', value: 'Abre um menu Dropdown para ler as atualizações técnicas de um serviço específico que caiu.\n```bash\n!status\n```' },
                        { name: 'Dashboard Global', value: 'Gera um painel com todos os serviços e suas stacks organizadas, mostrando quem está Online 🟩 ou Offline 🟥 no momento.\n```bash\n!status all\n```' },
                        { name: 'Relatório Semanal de Uptime', value: 'Calcula a porcentagem de tempo que todos os sistemas ficaram no ar durante os últimos 7 dias.\n```bash\n!relatorio\n```' }
                    );
            } else if (i.customId === 'help_config') {
                newEmbed.setTitle('⚙️ Configuração Raiz')
                    .setDescription('Comandos restritos apenas para **Administradores** do Discord.')
                    .addFields(
                        { name: 'Configuração do Motor de Alertas', value: 'Define as regras vitais do bot: o canal de envio, a marcação de queda e quem pode gerenciar a esteira local.\n```bash\n# Uso:\n!config <#canal> <@cargoAlerta> <@cargoGerente>\n\n# Exemplo real:\n!config #devops @TimeTécnico @GerentesProjeto\n```' }
                    );
            } else if (i.customId === 'help_local') {
                newEmbed.setTitle('💻 Projetos Locais e Gestão')
                    .setDescription('Comandos restritos para **Administradores** e **Cargos Gerentes**.')
                    .addFields(
                        { name: 'Adicionar Projeto à Esteira', value: 'O bot fará pings a cada 5 minutos na URL e checará o SSL (se for HTTPS).\n```bash\n# Uso:\n!monitorar <id> <url> <Nome Visual>\n\n# Exemplo:\n!monitorar api_teste https://api.site.com API Backend Node\n```' },
                        { name: 'Desativar Verificação SSL', value: 'Útil para APIs internas que não possuem HTTPS ou certificados assinados.\n```bash\n# Uso:\n!ssl ignorar <id>\n\n# Exemplo:\n!ssl ignorar api_teste\n```' },
                        { name: 'Abrir Incidente de Manutenção', value: 'Pausa o monitoramento para você atualizar seu sistema sem floodar falsos alertas de erro.\n```bash\n# Uso:\n!incidente <id> <Mensagem>\n\n# Exemplo:\n!incidente api_teste Migração de Banco de Dados\n```' },
                        { name: 'Resolver Incidente / Remover Projeto', value: '```bash\n# Retomar ping após manutenção:\n!resolver api_teste\n\n# Remover serviço permanentemente:\n!remover api_teste\n```' }
                    );
            } else if (i.customId === 'help_webhook') {
                newEmbed.setTitle('📡 Webhooks e API')
                    .setDescription('O bot roda um servidor Express na porta 3000 para receber payloads de qualquer pipeline CI/CD (GitHub Actions, AWS, Vercel).')
                    .addFields(
                        { name: 'Estrutura do POST (JSON)', value: 'Envie a requisição para `http://<ip-do-bot>:3000/webhook/<id_do_projeto>` com o header `X-API-KEY: <WEBHOOK_KEY do .env>`\n```json\n{\n  "titulo": "Alerta CloudWatch",\n  "mensagem": "Uso de CPU atingiu 90% no Servidor Web.",\n  "status": "erro" \n}\n```\n*Dica: o status pode ser "erro" (Alerta Vermelho) ou "info" (Alerta Azul).*' },
                        { name: 'Canal por Projeto', value: 'Por padrão, todo webhook cai no canal global de todos os servidores. Pra isolar um projeto no canal dele:\n```bash\n!canal <id_do_projeto> #canal\n```' }
                    );
            }

            await i.update({ embeds: [newEmbed], components: [row] });
        });

        collector.on('end', () => msgHelp.edit({ components: [] }).catch(()=>null));
        return;
    }

    // --- COMANDOS DE ADMINISTRAÇÃO E GESTÃO ---
    if (comando === '!config') {
        if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ Acesso negado.");
        const canal = message.mentions.channels.first();
        const cargos = Array.from(message.mentions.roles.values());
        if (!canal) return message.reply("⚠️ Uso incorreto. Veja `!help` > Configuração.");

        db.prepare(`INSERT OR REPLACE INTO servidores (guild_id, canal_id, cargo_alerta, cargo_admin) VALUES (?, ?, ?, ?)`).run(message.guild.id, canal.id, cargos[0]?.id || null, cargos[1]?.id || null);
        return message.channel.send({ embeds: [criarEmbed(CORES.sucesso).setDescription(`✅ Configuração salva e vinculada ao canal ${canal}.`)] });
    }

    if (comando === '!canal') {
        if (!temPermissao(message, message.guild.id)) return message.reply('❌ Acesso Negado.');
        const webhookId = args[1]?.toLowerCase();
        const canal = message.mentions.channels.first();
        if (!webhookId || !canal) return message.reply('⚠️ Uso: `!canal <id_webhook> #canal`');

        db.prepare(`INSERT OR REPLACE INTO webhooks_canais (webhook_id, canal_id) VALUES (?, ?)`).run(webhookId, canal.id);
        return message.reply(`✅ Webhooks de \`${webhookId}\` (\`http://<ip-do-bot>:3000/webhook/${webhookId}\`) agora caem em ${canal}.`);
    }

    if (['!monitorar', '!remover', '!ssl', '!incidente', '!resolver'].includes(comando)) {
        if (!temPermissao(message, message.guild.id)) return message.reply('❌ Acesso Negado.');
        const idCustom = args[1]?.toLowerCase();
        
        try {
            if (comando === '!monitorar') {
                if(!idCustom || !args[2]) return message.reply("⚠️ Sintaxe incorreta. Veja exemplos no `!help`.");
                db.prepare(`INSERT OR REPLACE INTO minhas_urls (id, nome, url, ignorar_ssl) VALUES (?, ?, ?, 0)`).run(idCustom, args.slice(3).join(' '), args[2]);
                ultimoStatusMinhasUrls[idCustom] = 'up';
                return message.reply(`✅ Endpoint \`${idCustom}\` adicionado à esteira.`);
            }
            if (comando === '!remover') {
                db.prepare(`DELETE FROM minhas_urls WHERE id = ?`).run(idCustom);
                return message.reply(`✅ Serviço \`${idCustom}\` removido.`);
            }
            if (comando === '!ssl' && args[1] === 'ignorar') {
                db.prepare(`UPDATE minhas_urls SET ignorar_ssl = 1 WHERE id = ?`).run(args[2]);
                return message.reply(`✅ Auditoria SSL desativada para \`${args[2]}\`.`);
            }
            if (comando === '!incidente') {
                db.prepare(`UPDATE minhas_urls SET incidente_manual = ? WHERE id = ?`).run(args.slice(2).join(' ') || 'Manutenção', idCustom);
                return message.reply(`⚠️ Manutenção ativada. Ping suspenso para \`${idCustom}\`.`);
            }
            if (comando === '!resolver') {
                db.prepare(`UPDATE minhas_urls SET incidente_manual = NULL WHERE id = ?`).run(idCustom);
                ultimoStatusMinhasUrls[idCustom] = 'down'; 
                return message.reply(`✅ Manutenção finalizada em \`${idCustom}\`.`);
            }
        } catch (e) { return message.reply("❌ Falha de sintaxe ou erro no SQLite."); }
    }

    // --- DASHBOARDS E RELATÓRIOS ---
    if (comando === '!relatorio') {
        const registros = db.prepare(`SELECT servico_id, status FROM historico_uptime WHERE timestamp >= datetime('now', '-7 days')`).all();
        if (registros.length === 0) return message.channel.send({ embeds: [criarEmbed().setDescription("📊 Coletando dados base. Volte mais tarde.")] });

        const stats = {};
        registros.forEach(r => {
            if (!stats[r.servico_id]) stats[r.servico_id] = { up: 0, total: 0 };
            stats[r.servico_id].total++;
            if (r.status === 'UP') stats[r.servico_id].up++;
        });

        const embed = criarEmbed().setTitle('📈 Uptime Semanal').setFooter({ text: '🟩 ≥98%  🟨 ≥90%  🟥 <90% (últimos 7 dias)' });
        let txtA = '', txtP = '';

        for (const [id, dados] of Object.entries(stats)) {
            const perc = ((dados.up / dados.total) * 100).toFixed(2);
            const cheios = Math.round(perc / 10);
            const barra = (perc < 90 ? '🟥' : (perc < 98 ? '🟨' : '🟩')).repeat(cheios) + '⬛'.repeat(10 - cheios);
            
            let nome = endpoints[id] ? endpoints[id].nome : (db.prepare(`SELECT nome FROM minhas_urls WHERE id = ?`).get(id)?.nome || id);
            const linha = `${barra} \`${perc.padStart(6, ' ')}%\` **${nome}**\n`;
            if (endpoints[id]) txtA += linha; else txtP += linha;
        }

        if (txtA) embed.addFields({ name: 'Terceiros', value: txtA });
        if (txtP) embed.addFields({ name: 'Locais', value: txtP });
        return message.channel.send({ embeds: [embed] });
    }

    if (comando === '!status') {
        if (args[1] === 'all') {
            const painelEmbed = criarEmbed()
                .setTitle('🌐 Dashboard Global de Operações')
                .setDescription('Status instantâneo da esteira de desenvolvimento, separado por Stack.')
                .setThumbnail(message.guild.iconURL() || client.user.displayAvatarURL())
                .setFooter({ text: '🟩 Online   🟥 Offline   🟨 Manutenção' });

            // Definição das Stacks
            const stacks = {
                '☁️ Cloud & Infra': ['cloudflare', 'vercel', 'docker', 'render', 'railway', 'aws'],
                '🗄️ Bancos & Backend': ['supabase', 'planetscale', 'redis'],
                '🧠 Inteligência Artificial': ['openai', 'anthropic', 'huggingface'],
                '🛠️ DevTools & APIs': ['github', 'npm', 'pypi', 'discord', 'postman', 'sentry'],
                '💳 Financeiro': ['stripe']
            };

            const formatarLinha = (chave, serv) => {
                const isUp = ultimoStatus[chave] === 'none';
                const emoji = isUp ? '🟩' : '🟥';
                let nomeCurto = serv.nome.substring(0, 18);
                if (serv.nome.length > 18) nomeCurto += '..';
                return `${emoji} \`${nomeCurto.padEnd(20, ' ')}\`\n`;
            };

            const paineis = {};
            for (const [chave, serv] of Object.entries(endpoints)) {
                let stackEncontrada = '🧩 Outros Serviços';
                for (const [nomeStack, listaKeys] of Object.entries(stacks)) {
                    if (listaKeys.includes(chave)) { stackEncontrada = nomeStack; break; }
                }
                if (!paineis[stackEncontrada]) paineis[stackEncontrada] = '';
                paineis[stackEncontrada] += formatarLinha(chave, serv);
            }

            for (const [stack, texto] of Object.entries(paineis)) {
                painelEmbed.addFields({ name: stack, value: texto, inline: true });
            }

            let txtP = '';
            const projetos = db.prepare(`SELECT id, nome, incidente_manual FROM minhas_urls`).all();
            if (projetos.length > 0) {
                for (const p of projetos) {
                    if (p.incidente_manual) {
                        txtP += `🟨 \`${p.nome.substring(0,25).padEnd(25, ' ')}\` *(Manutenção)*\n`;
                    } else {
                        const isUp = ultimoStatusMinhasUrls[p.id] === 'up';
                        txtP += `${isUp ? '🟩' : '🟥'} \`${p.nome.substring(0,25).padEnd(25, ' ')}\`\n`;
                    }
                }
            } else {
                txtP = '```\nNenhum projeto local na esteira.\n```';
            }

            painelEmbed.addFields(
                { name: '\u200B', value: '\u200B', inline: false }, 
                { name: '💻 Suas Aplicações Locais', value: txtP, inline: false }
            );

            return message.channel.send({ embeds: [painelEmbed] });
        }
        
        const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('sel_status').setPlaceholder('Auditar um serviço...').addOptions(Object.entries(endpoints).map(([id, serv]) => ({ label: serv.nome, value: id })).slice(0, 25)));
        const msgMenu = await message.channel.send({ embeds: [criarEmbed().setDescription('📊 Selecione um alvo global para investigar logs técnicos:')], components: [row] });
        
        const collector = msgMenu.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });
        collector.on('collect', async i => {
            if (i.user.id !== message.author.id) return i.reply({ content: '🚫 Proibido.', ephemeral: true });
            const serv = endpoints[i.values[0]];
            await i.deferUpdate();
            try {
                const response = await axios.get(serv.url.replace('status.json', 'incidents.json'), axiosConfig);
                const inc = response.data.incidents.filter(inc => inc.status !== 'resolved')[0];
                const embed = criarEmbed(inc ? CORES.perigo : CORES.sucesso).setTitle(`🔍 Auditoria: ${serv.nome}`);
                if (!inc) embed.setDescription('🟢 Sem anomalias reportadas.');
                else embed.setDescription(`⚠️ **${inc.name}**\n${inc.incident_updates.slice(0, 2).map(up => `> **[${up.status.toUpperCase()}]** - ${up.body}`).join('\n\n')}`);
                await msgMenu.edit({ embeds: [embed], components: [row] });
            } catch(e) { }
        });
        collector.on('end', () => msgMenu.edit({ components: [] }).catch(()=>null));
    }
});

client.login(process.env.DISCORD_TOKEN);