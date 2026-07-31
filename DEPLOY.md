# Deploying Theaurax to a Hostinger VPS

Target: **KVM 2** (2 vCPU / 8 GB RAM / 100 GB NVMe / 8 TB), Ubuntu 24.04 LTS,
**India – Mumbai** location.

**Why Mumbai:** `theaurax.in` is itself hosted on Hostinger (LiteSpeed), so the WooCommerce
REST sync, `createOrder`, and the knowledge-source crawler all stay in-region. The LLM
providers are the only long hops and they're long from any location.

**Hosting changed 2026-07-30** from the earlier Hetzner CX33 plan. Differences that matter:
2 vCPU instead of 4 (fine — this workload blocks on LLM HTTP calls, not CPU), 100 GB instead
of 80, and free *weekly* backups included. The 2 vCPU count is why capping MongoDB's cache
(§4) is not optional here.

**Database decision (2026-07-28, unchanged):** self-host MongoDB on this same box instead of
MongoDB Atlas. `db.js` already has a complete Mongo branch, so this is a **`MONGODB_URI`
change only — no code change**. Postgres was evaluated and deferred; see "Why not Postgres"
at the bottom.

---

## 1. Provision

At checkout (<https://cart.hostinger.com>):

| Setting | Value |
|---|---|
| Plan | KVM 2 |
| Period | 12 months — **decline the 24-month upsell** (2-year lock-in on unproven infra) |
| Daily auto-backup ₹589/mo | **UNCHECK** — free weekly backups are included and §7 replaces the rest |
| Server location | **India – Mumbai** |
| Free domain | skip — the bot runs on `bot.theaurax.in`, a subdomain you already own |

Then in hPanel → VPS → **Operating System**: plain **Ubuntu 24.04 LTS**. Do *not* pick a
template with Node/a control panel/an "AI assistant" preinstalled — they pin versions and add
services that compete for the 8 GB.

hPanel → **SSH keys** → add your public key *before* first boot, so you never use the emailed
root password.

> ⚠️ Hostinger has its own firewall layer in hPanel **in addition to** `ufw`. Configure only
> one. If you enable the hPanel firewall without allowing 22/80/443 you lock yourself out of
> a box `ufw` says is fine. This runbook uses `ufw`; leave the hPanel firewall off.

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

Hostinger ships the VPS with root password auth enabled. Once your key works, close it:

```bash
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh
```

Chromium (for `whatsapp-web.js`) needs system libraries that aren't on a bare Ubuntu image:

```bash
apt install -y ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 \
  libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcomposite1 libxdamage1 \
  libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils
```

Chromium spikes hard under load. On 8 GB with only 2 cores this is a real safety net:

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

> Confirm the `mongodb` Node driver version in `package.json` (currently `^7.5.0`) supports
> server 8.0 before committing to it — if not, install the 7.0 repo instead (same steps,
> swap `8.0` → `7.0`).

**Create the app user and enable auth.** VPS IPs are port-scanned constantly; an
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

Then in `/etc/mongod.conf` confirm `net.bindIp` is `127.0.0.1` (the default — **never**
`0.0.0.0`) and add both blocks:

```yaml
storage:
  wiredTiger:
    engineConfig:
      cacheSizeGB: 2

security:
  authorization: enabled
```

**The `cacheSizeGB: 2` line is required on this box, not optional.** WiredTiger defaults to
50% of RAM minus 1 GB — on 8 GB that's 3.5 GB reserved for a database holding a few hundred
documents, and it will collide with a Chromium spike. 2 GB is far more than this dataset
needs.

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

Everything else (Groq/Sarvam keys, WooCommerce, `AURAX_TEAM_PASSWORD` /
`TESTING_TEAM_PASSWORD`) carries over unchanged.

Note `admin/dist` is committed, so `npm start` works without a build. Only re-run
`npm run build-admin` after changing `admin/src` — and that needs the full dev dependencies,
which `--omit=dev` skipped. Build on your laptop and commit `admin/dist`, rather than
installing Vite on the VPS.

**Migrating existing data:** dump from Atlas and restore locally — don't re-run
`npm run migrate-mongo`, which reads the stale local JSON files, not Atlas:

```bash
mongodump --uri="<atlas-uri>" --db=theaurax_assistant --gzip --archive=atlas.gz
mongorestore --uri="<local-uri>" --gzip --archive=atlas.gz --drop
```

Verify the count matches Atlas before pointing the bot at it. **Once verified, delete the
Atlas cluster** — that also closes the `0.0.0.0/0` IP-allowlist exposure logged 2026-07-29.

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

Then open `https://bot.theaurax.in/admin` → **WhatsApp** section and scan the QR **once**.
Auth persists in `/opt/theaurax/.wwebjs_auth/` — back this directory up too, or you'll
re-scan after every rebuild.

## 7. Backups — do not skip this

Hostinger's included **free weekly backup** is a whole-VPS image restore: coarse, up to 7
days stale, and stored on the same provider. Treat it as the disaster floor, not the backup.
`scripts/backup-mongo.sh` is the actual one.

```bash
chmod +x /opt/theaurax/scripts/backup-mongo.sh
crontab -e
```

```cron
30 2 * * * /opt/theaurax/scripts/backup-mongo.sh >> /var/log/theaurax-backup.log 2>&1
```

Defaults: `/var/backups/theaurax`, 14-day retention, reads `MONGODB_URI` from
`/opt/theaurax/.env`. Set `OFFSITE_DEST` to something **off Hostinger** (an rclone remote, a
cheap object store, another box) — a backup on the same disk as the database is not a backup,
and a backup at the same provider as the database is barely one.

Also snapshot `/opt/theaurax/.wwebjs_auth/` — losing it means re-scanning the WhatsApp QR,
which needs physical access to the owner's phone.

**Test the restore once, now.** An untested backup is an assumption, not a safety net.

## 8. Reverse proxy + TLS

```bash
apt install -y nginx certbot python3-certbot-nginx
```

Point a `bot.theaurax.in` A record at the VPS IP, proxy it to `127.0.0.1:3000`, then
`certbot --nginx -d bot.theaurax.in`. Update `BASE_URL` in `.env` to the HTTPS URL so invoice
and payment links resolve, and restart.

Add basic rate limiting while you're in the nginx config — `/api/knowledge-hub/login` has
**none**, and one guessed password exposes every customer conversation:

```nginx
limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;

location /api/knowledge-hub/login {
    limit_req zone=login burst=3 nodelay;
    proxy_pass http://127.0.0.1:3000;
}
```

---

## Running it efficiently on 2 vCPU / 8 GB

Ordered by how much they actually matter on this box:

1. **Cap Mongo's cache** (§4) — the single biggest memory win, ~1.5 GB freed.
2. **Keep the swapfile** (§2) — Chromium's spikes are what will OOM you, and 2 cores means
   less headroom to recover.
3. **Don't run a second Chromium.** `whatsapp-web.js` holds one persistent browser. Anything
   else that launches Puppeteer (a scraper, a PDF renderer) on this box doubles the worst
   case.
4. **The deterministic fast paths are your CPU budget.** FAQ match, confident knowledge
   match, size/qty parse, and order confirm all answer with zero LLM call and near-zero CPU.
   Roughly half of a typical purchase flow never touches an LLM — that's why 2 vCPU is enough.
5. **Local embeddings — done, and they need one deploy step.** Semantic search now runs
   `all-MiniLM-L6-v2` on CPU via `@huggingface/transformers` (no API key, no quota, nothing
   leaves the box). Budget **~130 MB RSS** on top of the table above once the model loads —
   still comfortable at 8 GB with Mongo capped. Measured 17 ms per indexed chunk and ~5 ms
   per customer query on a 4-core dev box; expect roughly 2-3× that on 2 vCPU, so a
   149-chunk re-index lands around 5-10 seconds. One-time and off the request path.

   **Set `EMBEDDING_CACHE_DIR` to a path the app user owns**, e.g.:

   ```
   EMBEDDING_CACHE_DIR=/opt/theaurax/.models
   ```

   The library defaults to a directory inside `node_modules`, which is root-owned after
   `npm ci` while the service runs as `theaurax` — the first model download would fail at
   runtime and silently drop you back to keyword-only search. The model is ~22 MB, fetched
   from the Hugging Face hub on first use, so the box needs outbound HTTPS the first time.

   Verify after deploy with `npm run test-embeddings` (28 checks, no DB or WhatsApp needed).
6. **Watch it, don't guess.** `journalctl -u theaurax -f` for the bot,
   `systemctl status mongod` for the DB, and `/admin` → Monitor for provider stats and the
   `[Tokens]` per-call numbers. If RAM gets tight, `systemd-cgtop` shows which unit is doing it.
7. **Disk is not a concern.** 100 GB against a database of a few thousand documents plus
   invoice PDFs. Keep an eye on `/var/backups/theaurax` only if you raise `RETENTION_DAYS`.

---

## Why not Postgres (assessed 2026-07-28)

Postgres was considered because the server has a lot of unused disk. It's a real option, but
the storage argument alone doesn't justify it — self-hosted Mongo uses the same disk with
**zero code changes**, while Postgres means rewriting all ~20 methods in the 699-line
`db.js`, a new migration script, and re-verifying every storage path in the bot.

The genuine reasons to revisit it later:

1. `getAllLeads()` pulls **every** lead into Node memory, and `diagnose.js` /
   `review_conversations.js` then filter in JavaScript. Fine at ~66 leads, bad at 10,000 —
   and on 2 vCPU / 8 GB that ceiling arrives sooner than it would have on the CX33.
2. The `knowledge.js` matcher is a hand-rolled token scorer. Postgres `tsvector` + `pg_trgm`
   would give real full-text and fuzzy matching — which would also absorb Tanglish spelling
   variation ("seri"/"sari", "jursey"/"jersey"). This is the most interesting reason.
3. Session updates could be made atomic in a transaction rather than relying on the
   per-sender queue chaining in `whatsapp-web-bot.js`.

Sketch if it's ever picked up: keep the fallback ladder as `usePg → useMongo → JSON`, and give
each table a natural key + promoted columns for whatever gets *filtered* (`leads.status`,
`knowledge.active/source`, `tickets.status`, `retry_queue.retry_at`) + a `data JSONB` blob for
the rest. That keeps the port mechanical — `updateOne(…, {upsert:true})` maps to
`INSERT … ON CONFLICT … DO UPDATE`.
