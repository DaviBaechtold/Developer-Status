# Deploy — Oracle Cloud "Always Free" VM

Genuinely free forever (not a trial), real Linux VM, no sleep, persistent disk — the only free option that actually fits this bot (needs a long-running process, a writable SQLite file, and a public port for webhooks). Takes ~20 minutes.

## 1. Create the VM

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) (asks for a card for identity verification — Always Free resources are never charged).
2. Console → **Compute → Instances → Create Instance**.
3. **Image**: Ubuntu 22.04 (or newer LTS).
4. **Shape**: `VM.Standard.A1.Flex` (Ampere/ARM), 1 OCPU / 6 GB RAM is plenty — well inside the 4 OCPU/24 GB free allowance.
   - If it says capacity unavailable in your region (common), switch to `VM.Standard.E2.1.Micro` (x86, always available, smaller but enough for this bot).
5. **SSH keys**: let Oracle generate a key pair and download the private key (or paste your own public key).
6. **Networking**: keep the default VCN, make sure "Assign a public IP" is on.
7. Create. Note the public IP once it's running.

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

## Optional: HTTPS

Right now webhook calls travel as plain HTTP — the `X-API-KEY` header is visible to anything between the CI runner and this VM. Fine for a quick setup; if you want it encrypted and have a domain pointed at the VM's IP, put [Caddy](https://caddyserver.com/) in front — it gets a free Let's Encrypt cert automatically with a 3-line Caddyfile:

```
your-domain.com {
    reverse_proxy localhost:3000
}
```
Then send webhooks to `https://your-domain.com/webhook/<project_id>` instead, and firewall off direct access to port 3000 from the internet (only allow it from `localhost`).
