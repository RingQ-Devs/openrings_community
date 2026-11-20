# OpenRings Community

The Q&A community forum for [OpenRings](https://openrings.org/), the open-source telephony switch written in Go. It is built to run at `openrings.org/community`, with the same logo, colours and light/dark theme as the main site. Its header holds only community links: Forums, What's new, Members (plus Support inbox and Admin for staff), search and one **Ask a question** button.

- **Members** register, log in, ask questions, reply, like posts and mark solutions. Everyone can read every thread.
- **The RingQ Support team answers.** Support engineers and admins carry a team badge (the name is set in Admin → Answer settings). They can pin, lock, move, rename and delete threads.
- **Drafted answers, reviewed by engineers.** For every new question, a draft reply is written by an AI model (**Claude, OpenAI, or a free self-hosted model**, your choice) and assigned at random to an **on-duty** support engineer. The engineer reviews it in the **Support inbox**, edits it if needed and posts it under their own name. Nothing is posted under an engineer's name until a person approves it. Or choose **Automatic, in real time**: every question is answered within seconds by the automated account (labelled *Automated*), and the answer appears on the thread page without reloading.
- **Daily discussions.** Each day the scheduler writes new, realistic questions from a pool of sample member accounts and publishes them at random times. Their answers go through the same Support inbox. Some threads get a follow-up from the original poster.
- **SEO.** Server-rendered pages, clean URLs (`/threads/title-slug.123/`), canonical tags, Open Graph, `DiscussionForumPosting` structured data, `sitemap.xml` and `robots.txt`.
- **Admin panel.** Answer settings, the knowledge base used for drafts, topic ideas, sample accounts, the daily posts queue, forums, users and the duty roster, and an activity log.

Tech: Node.js 22+, Express 5, PostgreSQL 12+ (with full-text search), EJS templates, and the official `@anthropic-ai/sdk` and `openai` SDKs. It runs as one Node.js process plus your PostgreSQL database; there is no Redis or other service.

> **Deploying on the Linux server?** Follow [docs/DEPLOY-LINUX.md](docs/DEPLOY-LINUX.md). **Testing on Windows?** Follow [docs/SETUP-WINDOWS.md](docs/SETUP-WINDOWS.md).

---

## Quick start (local)

1. Create a PostgreSQL database and user:

   ```sql
   CREATE ROLE openrings WITH LOGIN PASSWORD 'choose-a-password';
   CREATE DATABASE openrings_community OWNER openrings ENCODING 'UTF8' TEMPLATE template0;
   ```

2. Install, configure and start the forum. The tables are created automatically on first run:

   ```bash
   cd community
   npm install
   cp .env.example .env              # set DB_PASSWORD, SITE_TIMEZONE, ANTHROPIC_API_KEY
   node scripts/doctor.js            # checks Node, database and API key
   node scripts/init.js --admin admin you@example.com 'a-strong-password'
   npm start                         # http://localhost:3000
   ```

To try the AI features without an API key, set `AI_PROVIDER=mock` in `.env`. The site then posts clearly marked demo answers.

Useful commands:

| Command | What it does |
|---|---|
| `node scripts/doctor.js` | Checks the Node.js version, database connection, tables, admin account and Claude API key |
| `node scripts/init.js` | Creates the tables, default forums and starter personas (also done automatically on start) |
| `node scripts/init.js --admin <user> <email> <password>` | Creates an admin account (or promotes an existing user) |
| `node scripts/init.js --support <user> <email> <password>` | Creates a support engineer account |
| `node scripts/init.js --reset-password <user> <new-password>` | Resets a user's password and signs them out everywhere |
| `node scripts/seed-today.js 5 --publish` | Generates 5 daily questions now and publishes them immediately |
| `npm test` | Runs the test suite with mock AI in a temporary schema (needs `TEST_DATABASE_URL`, see below) |
| `npm run dev` | Starts with auto-reload |

You can also add support engineers, and choose who is **on duty**, in **Admin → Users & staff**.

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `SITE_URL` | `http://localhost:3000` | Public origin with no path, e.g. `https://openrings.org` |
| `BASE_PATH` | *(empty)* | e.g. `/community` to serve at `https://openrings.org/community/` |
| `SITE_TIMEZONE` | `UTC` | Time zone for the daily posting window and dates |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | | Optional fallbacks. Normally you choose the provider (Claude, OpenAI or self-hosted Open Rings AI) and enter keys in **Admin → AI provider** |
| `AI_MODEL` / `OPENAI_MODEL` | `claude-opus-5-5` / `gpt-5.5` | Default models when none is chosen in the admin panel |
| `AI_PROVIDER` | | `anthropic`, `openai`, `local`, `mock` or `none`. Used only until a provider is saved in the admin panel |
| `SECRET_KEY` | *(auto: `data/secret.key`)* | Encrypts API keys saved in the admin panel. Set it for Docker or several servers |
| `ADMIN_USERNAME/EMAIL/PASSWORD` | | Optional: creates the first admin on first start |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `localhost` / `5432` / `openrings_community` / `openrings` / | PostgreSQL connection. Quote the password if it contains `#` |
| `DATABASE_URL` | | Alternative to the `DB_*` lines: one `postgres://` connection string |
| `DB_SCHEMA` | `public` | Put the tables in another schema, e.g. inside an existing database |
| `DB_SSL` | `false` | Set `true` for cloud databases that require SSL |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` in Docker or to test from other devices |
| `COOKIE_SECURE` | on when `NODE_ENV=production` | Secure-only cookies. Set `false` only if you test production mode over plain http |
| `RUN_WORKERS` | `true` | Runs the AI and scheduler worker in the web process. Run only **one** instance |

Everything else (review or automatic mode, support team name, delays, questions per day, posting window, approval mode, announcement banner) is set in **Admin → Answer settings** and takes effect immediately.

## AI provider: Claude, OpenAI or Open Rings AI

Choose in **Admin → AI provider** (a dropdown). Only the chosen provider's settings are shown. Each provider keeps its own settings, so you can switch back and forth, and changes apply immediately. **Save and test connection** checks everything with one tiny request, and the result stays on the page.

| Provider | Needs | Cost | Notes |
|---|---|---|---|
| **Claude** (Anthropic) | API key | Pay per use | Best quality. Messages API with structured outputs, prompt caching and server-side fallback |
| **OpenAI** | API key | Pay per use | Responses API with a strict JSON schema; `store: false` |
| **Open Rings AI** (self-hosted) | A machine with about 8 GB free memory; set up with `npm run ai:setup` | No per-use cost | Free open-source model on your own hardware. Slower and simpler answers. See below |
| Demo text | nothing | free | Clearly marked test text, for trying the Support inbox |
| Off | nothing | free | No drafts and no daily posts; staff answer everything by hand |

API keys are stored in the database encrypted with AES-256-GCM and only ever shown masked. The encryption key is `SECRET_KEY` if set, otherwise a random `data/secret.key` created on first save. Keep `data/secret.key` with your backups, or re-enter the keys after a restore. Keys in `.env` still work as a fallback.

The prompts were written and tested with Claude. After switching provider, read the first few drafts before relying on them.

### Open Rings AI (self-hosted, no API key)

Open Rings AI runs on your own machine: the forum server itself, or another machine on the same network. No API key and no per-use cost. Needs:
- **Memory:** about 8 GB free for the default model; 16 GB total is comfortable.
- **Disk:** about 6 GB.
- **Speed:** without a graphics card, expect roughly one to several minutes per answer. A graphics card makes it much faster.
- **Quality:** clearly below Claude and OpenAI. Engineers should review answers (Support review mode) until you trust it.

**Set it up with one command**, in the forum folder:
- Windows (Command Prompt): `npm run ai:setup`
- Linux: `sudo node scripts/setup-openrings-ai.js` (administrator rights are needed once, to install the engine)

The setup:
1. installs the Open Rings AI engine and starts it (first time only);
2. downloads the language model, about 5 GB, first time only (an interrupted download resumes);
3. creates the `openrings-ai` model, with a context window large enough for the knowledge base and a whole thread;
4. tests it;
5. selects **Open Rings AI** in **Admin → AI provider**. The running forum picks it up within a few seconds.

Then open **Admin → AI provider** and click **Save and test connection**. Leave *Engine address* and *Model name* empty to use the engine on the same machine (`http://127.0.0.1:11434/v1`) and `openrings-ai`.

Options: `--base <model>` builds on another language model (default `qwen2.5:7b`; check a model's licence before using it in production). `--url http://<machine>:11434` uses an engine on another machine, which is then set up there. `--no-install` never installs anything. `--no-activate` leaves the forum setting unchanged.

If the engine stops (for example after a restart of the machine), answers wait and are retried every hour for a day, so they are written once it runs again. The connection test in **Admin → AI provider** says what to do.

The engine listens on port 11434 without a login, so keep that port closed to the internet. The forum uses its standard OpenAI-compatible `/v1/chat/completions` endpoint: it asks for strict JSON first, falls back to plain JSON mode if needed, and validates every answer.

**Questions from staff accounts don't get drafts automatically.** Otherwise every staff post would get one. To test, ask from a member account, or use **Staff tools → Generate draft reply** on a thread.

## How answers work

**Support review mode (default).**
1. A member posts a thread. The forum queues an answer job (default delay: 20 seconds).
2. The worker sends the model (Claude, OpenAI or Open Rings AI) the instructions (with the knowledge base, prompt-cached), the whole thread, and links to similar threads. It returns `{ should_reply, reply_markdown }` as structured JSON. It skips posts that don't need an answer, such as "thanks".
3. The reply is saved as a **draft** and assigned at random to a support engineer marked **On duty** in **Admin → Users & staff**. If nobody is on duty, it goes to any support engineer.
4. Engineers see their drafts in the **Support inbox** (`/support/inbox`, also linked in the menu with a count). They edit the text, choose who to **post as**, and click **Post reply**. They can also ask for a new draft or discard it.
5. Follow-up questions from the member produce new drafts, up to *Max support answers per thread*. If an engineer replies by hand, the waiting draft is discarded automatically.

**Support review with automatic fallback (optional).** Same as above, but a draft that no engineer posts within *N* minutes (default 30) is posted from the automated account, labelled **Automated**. Every question gets an answer, and engineers can still reply afterwards. Good for nights and weekends.

**Automatic, in real time (optional).** Every question gets an answer within seconds, without waiting for review. It is posted from the automated account labelled **Automated**, never under an engineer's name. Engineers can still add to any thread. When you switch to this mode, drafts already waiting in the Support inbox are posted too.

Choose the mode in **Admin → Answer settings**. There you can also set a **random wait** (min/max seconds) before each reply, so replies don't all arrive at the same interval. For real-time answers, use 0–5 seconds.

**Replies appear without reloading.** An open thread page checks for new posts every few seconds (less often after a few idle minutes, and not while the tab is hidden). While an automatic answer is being written, the page shows *A reply is being prepared…*. New posts slide in and the reply count updates. This uses a small JSON endpoint, `GET /threads/<id>/live?after=<post id>`, and needs nothing extra on the server or proxy.

**The knowledge base matters.** Drafts take OpenRings product facts only from **Admin → Knowledge base**. It lives in the database. [`knowledge/openrings.md`](knowledge/openrings.md) is only the starting text, copied in the first time the forum runs on a new database; later changes to the file are not picked up. The starting text is pre-filled from the openrings.org home page. A database that still has the first starter template ("built on RingQ Switch") is upgraded once on start: lines added in the admin panel are kept in an "Added in the admin panel" section, and the previous text is shown read-only on the Knowledge base page. Add detail from the docs (config files, portal menus, FAQs) and fill the remaining `[TO FILL]` lines. Drafts never invent commands or features the knowledge base doesn't mention.

Failed jobs retry with backoff. A job that fails because the account has no credit (Claude) or quota (OpenAI) retries every hour for a day. **Admin → Activity** shows every job with token usage and errors, and lets you retry.

## How the daily discussions work

- Once a day (site time zone), the scheduler queues a `seed_generate` job. One model call writes *N* questions, each in a chosen sample member's voice for a chosen forum. Forums are picked by their *Daily posts weight*; members are rotated.
- Topic ideas from **Admin → Topic ideas** are used first, and each one is removed once used. Add the questions you want OpenRings to rank for.
- Questions are scheduled at random times inside the posting window (default 09:00–21:00). With **Hold generated questions for admin approval** ticked, they wait in **Admin → Daily posts** for review or editing first; **Approve all** there releases them in one click (overdue ones publish at once). The option is off by default, so daily questions publish on their own. The top of that page explains today's status: how many questions are planned and when the next one is due, or why nothing was planned (daily posts off, no AI provider, an error, with a **Try again now** button).
- When a question publishes, an answer draft follows after a random delay (default 10–90 minutes) and lands in an on-duty engineer's Support inbox. After the first answer is posted, there is a 35% chance the member asks one follow-up.
- Sample member accounts can't log in. Manage them in **Admin → Personas**. A setting in **Admin → Answer settings** can label them "Sample question"; it is off by default.

## Deploying

**Production on the openrings.org Linux server: follow [docs/DEPLOY-LINUX.md](docs/DEPLOY-LINUX.md).** It covers Node.js, the PostgreSQL database (tables are created automatically), `.env`, the systemd service, the nginx/Apache rule for `/community/`, backups, updates and troubleshooting.

Local testing on Windows: [docs/SETUP-WINDOWS.md](docs/SETUP-WINDOWS.md).

## Running the tests

The tests run with mock AI inside a temporary schema (`test_xxxx`) that is dropped afterwards, so they can point at your normal database:

```bash
TEST_DATABASE_URL=postgres://openrings:PASSWORD@localhost:5432/openrings_community npm test
```

(On Windows PowerShell: `$env:TEST_DATABASE_URL = "postgres://..."`, then `npm test`.)

## Cost estimate

With the default `claude-opus-5-5` at `medium` effort, a typical draft uses about 3–8K input tokens and 1–3K output tokens: roughly **$0.03–0.08 per draft**. With OpenAI, the token counts are similar; multiply by your chosen model's prices. Three daily questions with answers and some follow-ups come to roughly **$0.30–0.60 per day**, plus the answers to real members' questions. Check real usage in **Admin → Activity** (token counts per job). To lower costs, set `AI_EFFORT=low` or choose a smaller model with `AI_MODEL`.

## Project layout

```
community/
  src/
    app.js, server.js, worker.js   Express app, entry point, background worker
    config.js, db.js, schema.sql   configuration, PostgreSQL pool and schema
    services/                      users, forums/threads/posts, jobs, settings
    ai/                            model client (Claude or OpenAI), prompts, answer drafts, daily seeder
    routes/                        public, posting, auth, support inbox, admin
    lib/                           markdown sanitizing, formatting, icons, security
  views/                           EJS templates (admin/ = admin panel)
  public/                          CSS, JS, logo
  knowledge/openrings.md           AI knowledge base (starting copy)
  seed/                            default forums, starter personas, topic ideas
  scripts/                         doctor, init and seed-today CLIs
  docs/SETUP-WINDOWS.md            step-by-step Windows setup
  test/                            node:test suite
  deploy/                          nginx + systemd examples
```

The theme uses the same CSS variables as openrings.org (top of `public/css/style.css`), dark by default with a light switch. Visitors' light/dark choice is shared with the main site (`localStorage` key `or-theme`).

## Not included yet

- Email (verification, password reset, reply notifications). This needs an SMTP provider. Until it is added, reset passwords on the server with `node scripts/init.js --reset-password <user> <new-password>`.
- File and image uploads. Images can be linked with Markdown.
- Multiple web servers. Background jobs are already safe to run in several processes, but the login rate limiter is in-memory. Run one instance; that handles a large community.
