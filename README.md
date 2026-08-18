# Developer Status (NOC Bot)

Bot de Discord pra monitoramento de infraestrutura de time de dev: acompanha status de serviços de terceiros (GitHub, Vercel, OpenAI, AWS...), pinga URLs próprias com checagem de SSL, e recebe webhooks de CI/CD (GitHub Actions, Jenkins) roteados por canal.

## Setup

```bash
npm install
cp .env.example .env   # preenche DISCORD_TOKEN e WEBHOOK_KEY
node index.js
```

### `.env`

| Variável | O que é |
|---|---|
| `DISCORD_TOKEN` | Token do bot, gerado em [discord.com/developers/applications](https://discord.com/developers/applications) → seu app → Bot |
| `WEBHOOK_KEY` | Chave que os pipelines externos mandam no header `X-API-KEY` pra postar alertas |

Precisa da intent **Message Content** ligada na aba Bot do Developer Portal (o bot lê comandos como texto puro).

### Convidar pro servidor

Developer Portal → OAuth2 → URL Generator → scope `bot` → permissões (`Administrador` resolve, ou o mínimo: Ver Canais, Enviar Mensagens, Inserir Links, Mencionar Todos, Adicionar Reações) → abre a URL gerada e escolhe o servidor.

## Configuração inicial (dentro do Discord)

```
!config #canal-devops @TimeTécnico @GerentesProjeto
```

Define o canal de alertas, o cargo mencionado quando algo cai e o cargo com permissão pra gerenciar a esteira local (`!monitorar`, `!incidente` etc). Sem cargo admin configurado, só Administradores do servidor mexem nisso.

## Comandos

Rodar `!help` no Discord abre o painel interativo com tudo isso, mas resumindo:

- `!status` — menu pra investigar incidente de um serviço específico
- `!status all` — dashboard com todos os serviços por stack + projetos locais
- `!relatorio` — uptime dos últimos 7 dias
- `!config <#canal> <@cargoAlerta> <@cargoAdmin>` — admin only
- `!monitorar <id> <url> <Nome>` — adiciona URL própria à esteira (ping a cada 5min + SSL)
- `!ssl ignorar <id>` — desativa checagem de SSL pra um serviço
- `!incidente <id> <mensagem>` / `!resolver <id>` — pausa/retoma monitoramento manual
- `!remover <id>` — tira da esteira
- `!canal <id_webhook> #canal` — roteia os webhooks de um projeto pra um canal específico (em vez de cair no broadcast geral)

## Webhooks de CI/CD

Endpoint genérico, protegido por API key:

```bash
curl -X POST http://<ip-do-bot>:3000/webhook/<id_do_projeto> \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: <WEBHOOK_KEY>" \
  -d '{"titulo": "Deploy Homolog", "mensagem": "Build passou.", "status": "info"}'
```

`status` pode ser `erro` (alerta vermelho + menção do cargo) ou qualquer outra coisa (azul, informativo). Mapeia `<id_do_projeto>` pra um canal com `!canal`, senão cai no broadcast pra todos os servidores configurados.

Pra **GitHub** (push/PR/commits) e **Jenkins**, geralmente nem precisa passar por aqui — dá pra usar o webhook nativo de canal do Discord direto nas configurações do repo/job. Esse endpoint é pra alertas que não têm integração nativa (CloudWatch, scripts internos etc).

## Serviços monitorados

Editáveis em `endpoints.json` (formato Atlassian Statuspage `/api/v2/status.json`).

## Stack

Node.js, discord.js v14, better-sqlite3 (estado persistido em `dados_bot.sqlite`, ignorado no git), Express (servidor de webhooks).
