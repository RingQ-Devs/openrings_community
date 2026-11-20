# OpenRings Community: deploying on the openrings.org Linux server

This guide is for the developer who runs **openrings.org**. It puts the community forum at
**https://openrings.org/community/** on the same server.

## How it fits together

```
Browser ──HTTPS──> nginx (existing openrings.org site)
                     ├── /            → existing website (unchanged)
                     └── /community/  → Node.js forum on 127.0.0.1:3000 ──> PostgreSQL database "openrings_community"
                                                                    └──> Claude API or OpenAI API (drafts replies for the support team)
```

- The forum is one Node.js process (Express, server-rendered pages). It listens only on `127.0.0.1:3000`, so nothing new is exposed to the internet.
- It has its own PostgreSQL database. It never touches any other database.
- No Redis, queue server or build step. The background jobs (draft replies, daily posts) run inside the same process.
- The light/dark theme uses the same `localStorage` key as openrings.org (`or-theme`), so a visitor's choice carries over automatically.

## What's in the zip

`openrings-community.zip` holds the application source, `package.json` / `package-lock.json`, docs, and the example configs in `deploy/`. It does **not** contain `.env`, passwords, API keys or `node_modules`. You create those on the server.

| Path | What it is |
|---|---|
| `src/` | Application code. `src/schema.sql` defines the database tables |
| `views/`, `public/` | Page templates, CSS, JavaScript, logo |
| `knowledge/openrings.md` | Starting text for the knowledge base (copied into the database on first start) |
| `seed/` | Default forums, sample member accounts, topic ideas (inserted on first start) |
| `scripts/doctor.js` | Checks Node, database, tables, admin account and API key |
| `scripts/init.js` | Creates admin / support accounts, resets passwords |
| `deploy/` | nginx and Apache snippets, systemd service |
| `.env.example` | All settings, with comments |

## Requirements

- 64-bit Linux (Ubuntu/Debian or RHEL/Rocky/AlmaLinux). Tested on Ubuntu 24.04.
- **Node.js 22 or 24 (LTS).** Tested on 22 and 24.
- **PostgreSQL 12 or newer.** An existing PostgreSQL server on the machine is fine.
- The existing web server for openrings.org (nginx assumed; an Apache snippet is included), already serving HTTPS.
- Outbound HTTPS from the server to `api.anthropic.com` (Claude) or `api.openai.com` (OpenAI), for drafting replies. Or, for the self-hosted **Open Rings AI**, about 8 GB of free memory and 6 GB of disk; outbound HTTPS is needed only once, to download the engine and the model (see "Open Rings AI engine" below).
- About 200 MB disk for the app, plus database growth. Memory: under 200 MB for the Node process.

---

## Step 1: Install Node.js

Skip if `node -v` already prints v22 or v24.

**Ubuntu / Debian**
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs unzip
node -v
```

**RHEL / Rocky / AlmaLinux**
```bash
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf install -y nodejs unzip
node -v
```

## Step 2: PostgreSQL: create the database (one time)

If PostgreSQL is not installed yet:

```bash
# Ubuntu / Debian
sudo apt-get install -y postgresql
# RHEL family
sudo dnf install -y postgresql-server && sudo postgresql-setup --initdb && sudo systemctl enable --now postgresql
```

Create a login role and an empty database owned by it. Choose a strong password:

```bash
sudo -u postgres psql
```
```sql
CREATE ROLE openrings WITH LOGIN PASSWORD 'CHANGE-ME-strong-password';
CREATE DATABASE openrings_community OWNER openrings ENCODING 'UTF8' TEMPLATE template0;
\q
```

**That's all you create by hand. Do not create tables.** On its first start, the app:

1. creates its 11 tables and their indexes from `src/schema.sql`: `users`, `sessions`, `categories`, `forums`, `threads`, `posts`, `post_likes`, `reply_drafts`, `jobs`, `scheduled_posts`, `settings`;
2. inserts the default forums, the sample member accounts, the starter knowledge base and topic ideas, and the account that posts automated answers.

The schema script uses `CREATE … IF NOT EXISTS`, so it runs safely on every start. Future versions add their new tables or columns the same way, so upgrades need no manual SQL. A PostgreSQL advisory lock makes sure only one process runs it at a time.

> **RHEL family only:** the default `pg_hba.conf` uses `ident` for TCP connections, so password logins fail with *"Ident authentication failed"*. In `/var/lib/pgsql/data/pg_hba.conf`, change the `host all all 127.0.0.1/32 ident` line to `scram-sha-256` and run `sudo systemctl reload postgresql`. Ubuntu's default already allows password logins on 127.0.0.1.

> Using a managed or remote database instead? Point `DB_HOST` at it and set `DB_SSL=true` if it requires SSL. To put the tables inside an existing database instead of a new one, set `DB_SCHEMA=community` and give the role ownership of that schema. A separate database is simpler and recommended.

## Step 3: Install the application

```bash
# A system user that owns and runs the app
sudo useradd --system --no-create-home --shell /usr/sbin/nologin openrings

# Unpack the zip
sudo mkdir -p /opt/openrings-community
sudo unzip openrings-community.zip -d /opt/openrings-community
cd /opt/openrings-community

# Install the libraries (no build step, no native modules)
sudo npm ci --omit=dev
sudo chown -R openrings:openrings /opt/openrings-community
```

## Step 4: Configure `.env`

```bash
cd /opt/openrings-community
sudo cp .env.example .env
sudo nano .env
```

Production values:

```ini
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
SITE_URL=https://openrings.org
BASE_PATH=/community
SITE_NAME=OpenRings Community
SITE_TIMEZONE=Asia/Kolkata        # daily posts are published 09:00–21:00 in this zone
TRUST_PROXY=loopback              # nginx on the same machine

DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=openrings_community
DB_USER=openrings
DB_PASSWORD="CHANGE-ME-strong-password"   # keep the double quotes if it contains # or spaces

RUN_WORKERS=true
# AI keys are NOT needed here: choose Claude or OpenAI and paste the key in Admin → AI provider (step 8).
# Keys are stored encrypted; the encryption key is created in data/secret.key on first save.
```

Lock it down. It contains the database password:

```bash
sudo chown openrings:openrings .env
sudo chmod 600 .env
```

Notes:
- `SITE_URL` is the public origin only (no path), and `BASE_PATH` is the folder. Together they build canonical URLs, the sitemap and redirects.
- `NODE_ENV=production` makes login cookies HTTPS-only. Test through **https://openrings.org/community/**, not `http://server-ip:3000`, or logins won't stick.

## Step 5: Check the setup and create the first accounts

```bash
cd /opt/openrings-community
sudo -u openrings node scripts/doctor.js
```

You should see `[OK]` for Node.js, `.env`, the PostgreSQL connection and **All 11 forum tables exist**. This first run also creates the tables. AI shows as *Off* until you set it up in the admin panel (step 8). After that, doctor also checks the key, the model and the credit or quota with one tiny request (well under $0.01). Add `--skip-test-call` to skip that request. Fix any `[FAIL]` line using the hint printed under it.

Create the admin and the RingQ Support engineers:

```bash
sudo -u openrings node scripts/init.js --admin  siteadmin   admin@yourdomain.com   'Strong-Admin-Pass'
sudo -u openrings node scripts/init.js --support ringq_arun  arun@yourdomain.com    'Strong-Support-Pass'
```

Admins can add more support engineers later in **Admin → Users & staff**. Forgot a password? `sudo -u openrings node scripts/init.js --reset-password <user> '<new password>'`.

## Step 6: Run it as a service

```bash
which node      # if this is not /usr/bin/node, edit ExecStart in the unit file
sudo cp deploy/openrings-community.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openrings-community
sudo systemctl status openrings-community
curl -I http://127.0.0.1:3000/community/      # expect HTTP 200
```

Logs: `sudo journalctl -u openrings-community -f`. On start it prints the URL, the AI mode, and a warning if there is no admin yet.

## Step 7: Publish it at /community on openrings.org

**nginx:** paste the two `location` blocks from [`deploy/nginx-community.conf`](../deploy/nginx-community.conf) into the existing `server { … }` block that serves openrings.org over HTTPS:

```nginx
location = /community {
    return 301 /community/;
}
location /community/ {
    proxy_pass         http://127.0.0.1:3000;     # no path after the port: /community/... is passed unchanged
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    client_max_body_size 1m;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

**Apache:** use [`deploy/apache-community.conf`](../deploy/apache-community.conf) instead (needs `mod_proxy`, `mod_proxy_http`, `mod_headers`).

If openrings.org is served from a static host or CDN rather than this server's nginx, add an equivalent rule there that forwards `/community/*` to this server.

Then, on the main website:
1. **Add "Community" to the site menu**, linking to `https://openrings.org/community/`.
2. **Add the sitemap** to openrings.org's `robots.txt`: `Sitemap: https://openrings.org/community/sitemap.xml`. Submit it in Google Search Console.

Nothing else on the main site changes. The forum sends its own security headers (CSP) for `/community/` pages only.

## Step 8: Go-live checklist (in the browser, as admin)

1. Open **https://openrings.org/community/** and log in as the admin.
2. **Admin → AI provider**: choose **Claude** or **OpenAI** and paste a separate production API key, or set up **Open Rings AI** with `sudo node scripts/setup-openrings-ai.js` (see "Open Rings AI engine" below). Click **Save and test connection**. All lines should say *OK*.
3. **Admin → Users & staff**: tick **On duty** for the engineers who should receive draft replies.
4. **Admin → Knowledge base**: review and complete the product facts. Drafts state OpenRings facts only from this text. It is stored in the database; editing the file on disk later has no effect.
5. **Admin → Answer settings**: choose how answers are published: **Support review** (engineers post drafts), **Support review, with automatic answer if nobody reviews in time**, or **Automatic, in real time** (every question answered within seconds, labelled *Automated*; set the wait to 0–5 seconds). Check questions per day, the posting window and **Hold generated questions for admin approval** (off by default; when on, release waiting questions in **Admin → Daily posts → Approve all**). Untick *Create new discussions every day* to start without daily posts.
6. Register a test member in a private window and ask a question. (Questions from admin or support accounts never get drafts automatically.) In a review mode, the on-duty engineer sees a draft under **Support inbox** (the inbox icon in the header) within about a minute; post it and check the thread. In **Automatic, in real time**, stay on the thread page: *A reply is being prepared…* shows, and the answer appears within seconds without reloading. The page polls `/community/threads/<id>/live`, a normal HTTP request, so no WebSocket or extra proxy settings are needed.
7. Set a monthly **spend limit** for the production key: Claude Console, or your OpenAI account's limits/billing settings.

---

## Open Rings AI engine (optional, no API key)

To answer with Open Rings AI instead of Claude or OpenAI, run this once on the server, in the app folder:

```bash
cd /opt/openrings-community
sudo node scripts/setup-openrings-ai.js
```

It installs the Open Rings AI engine as its own systemd service, downloads the language model (about 5 GB), creates the `openrings-ai` model, tests it and selects **Open Rings AI** in Admin → AI provider. Then click **Save and test connection** there. To run the engine on a separate, bigger machine instead, run the same script there (copy the app folder or just the `scripts` and `src` folders) and enter `http://<that machine>:11434/v1` as *Engine address* in Admin → AI provider.

For the server administrator: the engine is the open-source Ollama runtime (MIT licence); the default language model is Qwen 2.5 7B (Apache 2.0). These names appear only on the server, not in the forum.

| Task | Command |
|---|---|
| Status / restart | `sudo systemctl status ollama` · `sudo systemctl restart ollama` |
| Logs | `sudo journalctl -u ollama -f` |
| Models on the engine | `curl -s http://127.0.0.1:11434/api/tags` |
| Update the engine | `curl -fsSL https://ollama.com/install.sh \| sudo sh` (keeps the downloaded models) |

- It listens on `127.0.0.1:11434` only, with no login. Never open port 11434 in the firewall. If the engine runs on another machine, allow that port only from the forum server's IP.
- Models are stored under `/usr/share/ollama/.ollama/models` (about 5 GB).
- A machine without a graphics card answers in roughly one to several minutes. Answers wait in the queue meanwhile; nothing is lost.

## Moving data from the Windows test PC (optional)

**Recommended: start with the empty production database**, so test posts don't go live. Copy the knowledge base text by hand: open Admin → Knowledge base on the PC, copy everything, paste it into the production admin page and click Save.

To copy everything instead (accounts, forums, posts, settings), do this **before the first start** on the server:

```bash
# On the Windows PC (Command Prompt, in a folder you can write to)
pg_dump -U openrings -h localhost -Fc openrings_community -f community.dump

# On the server, into the new empty database
pg_restore --no-owner --role=openrings -U openrings -h 127.0.0.1 -d openrings_community community.dump
```

## Updating to a new version

```bash
sudo -u postgres pg_dump -Fc openrings_community -f /tmp/before-update.dump   # quick backup
sudo unzip -o openrings-community.zip -d /opt/openrings-community             # .env and data/ are not in the zip, so they are kept
cd /opt/openrings-community && sudo npm ci --omit=dev && sudo chown -R openrings:openrings .
sudo systemctl restart openrings-community
sudo -u openrings node scripts/doctor.js --skip-test-call
```

Database changes for new versions are applied automatically on restart.

## Backups

Daily database backup, keeping 14 days:

```bash
sudo mkdir -p /var/backups/openrings-community && sudo chown postgres: /var/backups/openrings-community
echo "15 2 * * * postgres pg_dump -Fc openrings_community -f /var/backups/openrings-community/community-\$(date +\%F).dump && find /var/backups/openrings-community -name '*.dump' -mtime +14 -delete" | sudo tee /etc/cron.d/openrings-community-backup
```

Restore: `sudo -u postgres pg_restore --clean --no-owner --role=openrings -d openrings_community /var/backups/openrings-community/community-YYYY-MM-DD.dump`

Back up the database **and** `/opt/openrings-community/data/secret.key`, which encrypts the API keys saved in the admin panel. Without that file, a restored database still works, but you re-enter the API keys in Admin → AI provider. The rest of the application folder can always be recreated from the zip plus `.env`.

## Operations

| Task | Command |
|---|---|
| Status / restart | `sudo systemctl status openrings-community` · `sudo systemctl restart openrings-community` |
| Live logs | `sudo journalctl -u openrings-community -f` |
| Health check | `sudo -u openrings node scripts/doctor.js --skip-test-call` |
| Reset a password | `sudo -u openrings node scripts/init.js --reset-password <user> '<new password>'` |
| Add a support engineer | Admin → Users & staff, or `node scripts/init.js --support <user> <email> '<password>'` |
| Usage and errors of draft jobs | Admin → Activity (token usage per job, retry button) |

- Run **one** instance. Background jobs are safe across processes, but the login rate limiter is in memory.
- Port 3000 must not be opened in the firewall; nginx reaches it locally.
- Email (password reset, notifications) is not built in yet. Use `init.js --reset-password`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `502 Bad Gateway` on /community | The service isn't running or not on port 3000: `systemctl status openrings-community`, `journalctl -u openrings-community -n 50`. |
| 404 page from nginx, or pages without styles | `BASE_PATH=/community` missing in `.env`, or `proxy_pass` has a path after the port (it must be exactly `http://127.0.0.1:3000;`). |
| Login seems to work but you stay logged out | You opened it over plain http or directly on port 3000. Use https://openrings.org/community/. Check that nginx sends `X-Forwarded-Proto`. |
| `password authentication failed for user "openrings"` | Wrong `DB_PASSWORD`. Quote it in `.env` if it contains `#`. |
| `Ident authentication failed` | RHEL `pg_hba.conf`: change `ident` to `scram-sha-256` for 127.0.0.1 (step 2). |
| `permission denied for schema public` | The database isn't owned by `openrings`: `ALTER DATABASE openrings_community OWNER TO openrings;` then, connected to that database, `ALTER SCHEMA public OWNER TO openrings;` |
| `connect ECONNREFUSED 127.0.0.1:5432` | PostgreSQL isn't running (`systemctl status postgresql`), or `DB_PORT` is wrong. |
| AI provider says "The saved key cannot be read" | `data/secret.key` was lost or replaced (e.g. new server). Paste the API key again and Save. |
| `status=203/EXEC` in systemd | Node isn't at `/usr/bin/node`. Set `ExecStart` to the output of `which node`. |
| `EADDRINUSE :3000` | Port taken. Set another `PORT` and use the same port in `proxy_pass`. |
| "The Open Rings AI engine is not running" | Start it: `sudo systemctl start ollama`. Not installed yet: `sudo node scripts/setup-openrings-ai.js`. Queued answers are written once it runs. |
| No drafts appear | Questions posted by admin or support accounts never get drafts; test with a member account. Admin → AI provider → **Save and test connection** checks the key, the model and the credit. Admin → Activity shows the error. `credit balance is too low` (Claude) or `exceeded your current quota` (OpenAI): add credits or a payment method (jobs retry hourly for a day). Questions posted by staff accounts never get drafts. |

## Docker alternative

A `Dockerfile` and `docker-compose.yml` are included. The container listens on 3000, and you publish it on `127.0.0.1:3000` only. Set `SECRET_KEY` in `.env` (any long random string), because the container's own files are lost when it is rebuilt. Set `DB_HOST=host.docker.internal` to use PostgreSQL on the host. Steps 2, 4, 5 (run inside the container), 7 and 8 stay the same.
