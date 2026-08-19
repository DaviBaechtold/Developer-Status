# Deploy — Oracle Cloud "Always Free" VM

Genuinely free forever (not a trial), real Linux VM, no sleep, persistent disk — the only free option that actually fits this bot (needs a long-running process, a writable SQLite file, and a public port for webhooks). Takes ~20 minutes.

## 1. Create the VM

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) (asks for a card for identity verification — Always Free resources are never charged).
2. Console → **Compute → Instances → Create Instance**.
3. **Image**: Ubuntu 22.04 (or newer LTS).
4. **Shape**: `VM.Standard.A1.Flex` (Ampere/ARM), 1 OCPU / 6 GB RAM is plenty — well inside the 4 OCPU/24 GB free allowance.
   - If it says capacity unavailable in your region (common), switch to `VM.Standard.E2.1.Micro` (x86, always available, smaller but enough for this bot).
5. **SSH keys**: let Oracle generate a key pair and download the private key (or paste your own public key). **Download it now** — the console only offers it once.
6. **Networking**: pick "Create new virtual cloud network" and "Create new public subnet" if you don't have one yet, then toggle **"Automatically assign public IPv4 address"** on.
   - That toggle is buggy and sometimes won't turn on / does nothing when clicked — known Oracle console issue, not you. If so, just create the instance without it and assign the public IP afterward: instance page → **Resources → Attached VNICs** → click the VNIC → **IP administration** tab → click "(Not Assigned)" next to the private IP → **Edit** → **Ephemeral public IP** → Save. If the subnet has no internet gateway yet, the instance page also offers a one-click **"Connect public subnet to internet"** action first.
7. **Shape capacity errors** ("Out of capacity for shape..."): common for `A1.Flex` in busy regions. Go back and pick `VM.Standard.E2.1.Micro` instead (Specialty tab) — it's always available.
8. Create. Note the public IP once it's running.

## 2. Open port 3000 (webhooks need to reach it)

Two firewalls to open — Oracle blocks by default at both layers:

**a) Cloud-level (Security List):**
VCN details (linked from the instance page) → **Security Lists** → Default Security List → **Add Ingress Rules**:
- Source CIDR: `0.0.0.0/0`
- IP Protocol: TCP
- Destination Port Range: `3000`

**b) OS-level firewall**, once SSH'd in (step 3):
```bash
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save   # Oracle's Ubuntu image uses iptables, not ufw, by default
```

## 3. Set up the server

```bash
ssh -i your-key.pem ubuntu@<VM_PUBLIC_IP>

sudo apt update && sudo apt install -y build-essential python3 git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

git clone https://github.com/DaviBaechtold/Developer-Status.git
cd Developer-Status
npm install

cp .env.example .env
nano .env   # fill in DISCORD_TOKEN and WEBHOOK_KEY
```

`build-essential`/`python3` are there because `better-sqlite3` compiles a native addon on install — without them `npm install` fails.

**If the bot crash-loops with no error in the logs** (`pm2 list` shows a climbing restart count, `pm2 logs` shows nothing): that's a segfault, not a JS error — `better-sqlite3`'s prebuilt binary can be incompatible with the specific CPU on a small/older VM shape. Force it to compile locally instead:
```bash
npm uninstall better-sqlite3
npm install better-sqlite3 --build-from-source
```

## 4. Run it 24/7 with auto-restart

```bash
sudo npm install -g pm2
pm2 start index.js --name noc-bot
pm2 save
pm2 startup    # prints a command — copy-paste and run it to survive VM reboots
```

Check it came up: `pm2 logs noc-bot` should show `✅ NOC Bot online!`.

To update later: `git pull && npm install && pm2 restart noc-bot`.

## 5. Point your pipelines at it

```
http://<VM_PUBLIC_IP>:3000/webhook/<project_id>
```

## Fallback if the VM goes down

`pm2` restarts the bot process if it crashes, and `pm2 startup` brings it back after a VM reboot — that covers the process and the OS. It doesn't cover the VM itself disappearing (host issue, Oracle reclaiming an idle/abandoned Always Free resource, you fat-fingering something over SSH). This is a single free VM, not a redundant cluster — the realistic trade-off is: get told immediately, and be able to rebuild fast, not zero downtime.

**1. External uptime monitor** (so you find out before someone in Discord asks "the bot's dead again?"):
- [UptimeRobot](https://uptimerobot.com/) free plan — add an HTTP(s) monitor for `http://<VM_PUBLIC_IP>:3000/health`, 5-minute interval, alert via email (or their Discord webhook integration, so it posts straight into your server).
- `/health` needs no API key — it just reports whether the bot is connected to Discord.

**2. Fast recovery if it does die:**
- VM unresponsive but exists → **Console → Instances → Reboot**.
- VM actually gone/reclaimed → recreate it following steps 1–4 above; the git repo and `.env` values are all you need to be back up in a few minutes. Worth keeping a copy of your `.env` somewhere safe (password manager, not another public repo) so you're not stuck regenerating `WEBHOOK_KEY` and re-mapping every project's webhook.

A second standby VM would remove that few-minutes gap, but it's real added complexity for a hobby-scale bot: `bot_data.sqlite` has no built-in replication between two instances, and running the same Discord bot token logged in twice causes both processes to receive and respond to the same commands. Not worth it unless downtime actually becomes a recurring problem.

## Optional: HTTPS

Right now webhook calls travel as plain HTTP — the `X-API-KEY` header is visible to anything between the CI runner and this VM. Fine for a quick setup; if you want it encrypted and have a domain pointed at the VM's IP, put [Caddy](https://caddyserver.com/) in front — it gets a free Let's Encrypt cert automatically with a 3-line Caddyfile:

```
your-domain.com {
    reverse_proxy localhost:3000
}
```
Then send webhooks to `https://your-domain.com/webhook/<project_id>` instead, and firewall off direct access to port 3000 from the internet (only allow it from `localhost`).
