# Deploying Theaurax to Hetzner Cloud

Target: **CX33** (4 vCPU / 8 GB RAM / 80 GB NVMe), Ubuntu 24.04 LTS, **Singapore** location
(lowest latency to Indian customers — check the Type dropdown, and use **CPX31** if CX33 isn't
offered there).

**Database decision (2026-07-28):** self-host MongoDB on this same box instead of MongoDB Atlas.
`db.js` already has a complete Mongo branch, so this is a **`MONGODB_URI` change only — no code
change**. Postgres was evaluated and deferred; see "Why not Postgres" at the bottom.

---

## 1. Provision

Buy at <https://console.hetzner.cloud> → Project → **Add Server**:

| Setting | Value |
|---|---|
| Location | Singapore |
| Image | Ubuntu 24.04 LTS |
| Type | Shared vCPU → x86 → **CX33** |
| Networking | keep **Public IPv4** (needed for SSH + webhooks) |
| SSH key | paste your public key — do NOT use an emailed root password |

## 2. Base setup

```bash
ssh root@<server-ip>
apt update && apt upgrade -y

# Non-root user for the app
adduser --disabled-password --gecos "" theaurax
mkdir -p /home/theaurax/.ssh && cp ~/.ssh/authorized_keys /home/theaurax/.ssh/
chown -R theaurax:theaurax /home/theaurax/.ssh && chmod 700 /home/theaurax/.ssh

# Firewall — only SSH + HTTP(S). Mongo is NEVER exposed.
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Chromium (for `whatsapp-web.js`) needs system libraries that aren't on a bare Ubuntu image:

```bash
apt install -y ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 \
  libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcomposite1 libxdamage1 \
  libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils
```

Chromium spikes hard under load. On 8 GB this is a safety net, not a crutch:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 3. Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

## 4. MongoDB (self-hosted, localhost-only)

```bash
apt install -y gnupg curl
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
  | gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
  > /etc/apt/sources.list.d/mongodb-org-8.0.list
apt update && apt install -y mongodb-org
systemctl enable --now mongod
```

> Confirm the `mongodb` Node driver version in `package.json` supports server 8.0 before
> committing to it — if not, install the 7.0 repo instead (same steps, swap `8.0` → `7.0`).

**Create the app user and enable auth.** Hetzner IPs are port-scanned constantly; an
unauthenticated Mongo is how databases get wiped and ransomed.

```bash
mongosh <<'EOF'
use theaurax_assistant
db.createUser({
  user: "theaurax",
  pwd: "REPLACE_WITH_A_LONG_RANDOM_PASSWORD",
  roles: [{ role: "readWrite", db: "theaurax_assistant" }]
})
EOF
```

Then in `/etc/mongod.conf` confirm `net.bindIp` is `127.0.0.1` (the default — **never** `0.0.0.0`)
and add:

```yaml
security:
  authorization: enabled
```

```bash
systemctl restart mongod
# Must now FAIL — proves auth is on:
mongosh --eval 'db.getSiblingDB("theaurax_assistant").sessions.countDocuments()'
```

## 5. Deploy the app

```bash
su - theaurax
git clone <repo-url> /opt/theaurax && cd /opt/theaurax
npm ci --omit=dev
cp .env.example .env && nano .env
```

Set in `.env`:

```
MONGODB_URI=mongodb://theaurax:PASSWORD@127.0.0.1:27017/theaurax_assistant?authSource=theaurax_assistant
BASE_URL=https://bot.theaurax.in
WHATSAPP_WEB_ENABLED=true
```

Everything else (Groq/Sarvam keys, WooCommerce, admin team passwords) carries over unchanged.

**Migrating existing data:** if you're moving off Atlas, dump from Atlas and restore locally —
don't re-run `npm run migrate-mongo`, which reads the stale local JSON files, not Atlas:

```bash
mongodump --uri="<atlas-uri>" --db=theaurax_assistant --gzip --archive=atlas.gz
mongorestore --uri="<local-uri>" --gzip --archive=atlas.gz --drop
```

Verify the count matches Atlas before pointing the bot at it.

## 6. systemd service

`/etc/systemd/system/theaurax.service`:

```ini
[Unit]
Description=Theaurax WhatsApp AI Sales Bot
After=network.target mongod.service
Requires=mongod.service

[Service]
Type=simple
User=theaurax
WorkingDirectory=/opt/theaurax
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now theaurax
journalctl -u theaurax -f     # watch for "Successfully connected to MongoDB"
```

Then open `https://<domain>/admin` → **WhatsApp** section and scan the QR **once**. Auth persists
in `/opt/theaurax/.wwebjs_auth/` — back this directory up too, or you'll re-scan after every rebuild.

## 7. Backups — do not skip this

Leaving Atlas means losing its free automated backups. `scripts/backup-mongo.sh` replaces them.

```bash
chmod +x /opt/theaurax/scripts/backup-mongo.sh
crontab -e
```

```cron
30 2 * * * /opt/theaurax/scripts/backup-mongo.sh >> /var/log/theaurax-backup.log 2>&1
```

Defaults: `/var/backups/theaurax`, 14-day retention, reads `MONGODB_URI` from `/opt/theaurax/.env`.
Set `OFFSITE_DEST` to a Hetzner Storage Box for a real offsite copy — a backup on the same disk as
the database is not a backup.

**Test the restore once, now.** An untested backup is an assumption, not a safety net.

## 8. Reverse proxy + TLS

```bash
apt install -y nginx certbot python3-certbot-nginx
```

Proxy `bot.theaurax.in` → `127.0.0.1:3000`, then `certbot --nginx -d bot.theaurax.in`.
Update `BASE_URL` in `.env` to the HTTPS URL so invoice links resolve, and restart.

---

## Why not Postgres (assessed 2026-07-28)

Postgres was considered because the server has 80 GB of unused disk. It's a real option, but the
storage argument alone doesn't justify it — self-hosted Mongo uses the same disk with **zero code
changes**, while Postgres means rewriting all ~20 methods in the 699-line `db.js`, a new migration
script, and re-verifying every storage path in the bot.

The genuine reasons to revisit it later:

1. `getAllLeads()` pulls **every** lead into Node memory, and `diagnose.js` /
   `review_conversations.js` then filter in JavaScript. Fine at ~66 leads, bad at 10,000.
2. The `knowledge.js` matcher is a hand-rolled token scorer. Postgres `tsvector` + `pg_trgm` would
   give real full-text and fuzzy matching — which would also absorb Tanglish spelling variation
   ("seri"/"sari", "jursey"/"jersey"). This is the most interesting reason.
3. Session updates could be made atomic in a transaction rather than relying on the per-sender
   queue chaining in `whatsapp-web-bot.js`.

Sketch if it's ever picked up: keep the fallback ladder as `usePg → useMongo → JSON`, and give each
table a natural key + promoted columns for whatever gets *filtered* (`leads.status`,
`knowledge.active/source`, `tickets.status`, `retry_queue.retry_at`) + a `data JSONB` blob for the
rest. That keeps the port mechanical — `updateOne(…, {upsert:true})` maps to
`INSERT … ON CONFLICT … DO UPDATE`.
