# OpenRings Community

The community Q&A forum for **OpenRings**, the free, open-source telephony switch (https://openrings.org/). Anyone can register, ask questions and help others. The **RingQ Support** team answers, helped by an automatic answer writer. New discussions are started every day so the forum stays active and ranks in search engines.

This README is the complete guide: features, architecture, how everything works, setup on Windows (for testing), deployment on Linux (openrings.org), the admin and support guides, settings, troubleshooting and maintenance.

---

## Contents

1. [At a glance](#1-at-a-glance)
2. [Features](#2-features)
3. [Architecture](#3-architecture)
4. [How it works](#4-how-it-works)
   - 4.1 [Accounts and roles](#41-accounts-and-roles)
   - 4.2 [How a question gets answered](#42-how-a-question-gets-answered)
   - 4.3 [The three answer modes](#43-the-three-answer-modes)
   - 4.4 [Who gets an automatic answer, and who doesn't](#44-who-gets-an-automatic-answer-and-who-doesnt)
   - 4.5 [How many answers per thread](#45-how-many-answers-per-thread)
   - 4.6 [Timing](#46-timing)
   - 4.7 [Live updates: replies appear without reloading](#47-live-updates-replies-appear-without-reloading)
   - 4.8 [How an answer is written](#48-how-an-answer-is-written)
   - 4.9 [Daily automated discussions](#49-daily-automated-discussions)
   - 4.10 [The knowledge base](#410-the-knowledge-base)
   - 4.11 [Answer writers (AI providers)](#411-answer-writers-ai-providers)
   - 4.12 [Background jobs and retries](#412-background-jobs-and-retries)
5. [Setup on Windows (local testing)](#5-setup-on-windows-local-testing)
6. [Deployment on Linux (openrings.org)](#6-deployment-on-linux-openringsorg)
7. [Open Rings AI (self-hosted, no API key)](#7-open-rings-ai-self-hosted-no-api-key)
8. [Admin guide](#8-admin-guide)
9. [Support engineer guide](#9-support-engineer-guide)
10. [Settings reference](#10-settings-reference)
11. [Commands reference](#11-commands-reference)
12. [Updating, backups and moving data](#12-updating-backups-and-moving-data)
13. [Troubleshooting](#13-troubleshooting)
14. [Security](#14-security)
15. [Automated tests](#15-automated-tests)

---

## 1. At a glance

| | |
|---|---|
| **What** | A Q&A forum like the big vendor communities: categories, forums, threads, replies, likes, solutions, search, member profiles |
| **Where** | Locally on Windows for testing; in production at **https://openrings.org/community/** on the openrings.org Linux server |
| **Who answers** | The RingQ Support team, with automatic answers (in real time, or as drafts that engineers review) |
| **Built with** | Node.js 22+, Express 5, server-rendered pages (EJS), PostgreSQL 12+ |
| **Answer writer** | Claude, OpenAI, or Open Rings AI (self-hosted, no API key). Chosen in the admin panel |
| **Same code** | One source for Windows and Linux. Only the `.env` settings file differs |
| **Version** | Shown on start-up (`OpenRings Community 1.5.0 is running.`) and on Admin → Dashboard |

---

## 2. Features

### For visitors and members
- **Forums in four categories** (14 forums by default): OpenRings Community, Installation & Connectivity, Features & Configuration, Help & Feedback. Admins can add, rename and reorder them.
- **Register and log in** with a username, email and password. Members can edit their profile and change their password under **Account**.
- **Ask a question** (one button in the header) and **reply**, with Markdown formatting, a toolbar, a preview tab, quotes and code blocks.
- **Like** posts and **Mark as solution** (thread starter or staff). Solved threads are labelled.
- **Live replies:** an open thread shows new replies by itself, without reloading. While an automatic answer is being written, the page says *A reply is being prepared…*
- **Search** across all thread titles and posts (PostgreSQL full-text search).
- **What's new**, a **Members** directory and member profiles, a **Community rules** page.
- **Similar threads** next to every thread.
- **Dark and light theme**, the same as openrings.org. The choice carries over between the two sites.
- Works on phones and tablets.

### For the RingQ Support team
- A **team badge** on every staff post (the team name is a setting, default *RingQ Support*).
- The **Support inbox**: a draft answer is waiting for each new question. Review, edit, choose who to post as, and post.
- **On duty** roster: drafts are assigned at random to engineers who are on duty.
- **Staff tools** on every thread: pin, lock, move, rename, delete, turn automatic answers on or off for that thread, and **Generate draft reply**.
- Edit or delete any post.

### For admins
- **Admin panel** with: Support inbox, Dashboard, Daily posts, Answer settings, AI provider, Knowledge base, Topic ideas, Personas (sample members), Forums, Users & staff, Activity.
- **Choose the answer writer** (Claude, OpenAI, Open Rings AI, Demo text or Off) from a dropdown, enter the key there, and **test the connection** with one click. No restart.
- **Choose how answers are published:** support review, review with an automatic fallback, or fully automatic in real time.
- **Knowledge base:** the product facts the answer writer is allowed to use, edited in the browser and stored in the database.
- **Activity log** of every background job, with errors, token usage and a Retry button.
- An **announcement banner** across the site.

### Automation
- **Automatic answers** for every member question and follow-up, within seconds or as drafts for review.
- **Daily discussions:** realistic questions are written every day and published at random times in a posting window, then answered, sometimes with a follow-up question.
- **Topic ideas:** a list of questions you want covered; they are used first.

### Search engines (SEO)
- Clean URLs (`/community/threads/how-to-set-ivr.42/`), canonical links, page titles and descriptions.
- Structured data (DiscussionForumPosting) on every thread.
- `sitemap.xml` and `robots.txt` under `/community/`.

---

## 3. Architecture

### Production (openrings.org)

```
                         ┌──────────────────────────── openrings.org Linux server ───────────────────────────┐
Browser ──HTTPS──> nginx │  /            → existing website (unchanged)                                       │
                         │  /community/  → Node.js forum (127.0.0.1:3000, systemd service)                    │
                         │                   ├── web pages (Express + EJS)                                     │
                         │                   ├── background worker (same process): answers, daily posts       │
                         │                   ├──> PostgreSQL database "openrings_community"                   │
                         │                   └──> answer writer:                                              │
                         │                          Claude API  (api.anthropic.com, HTTPS)                    │
                         │                          OpenAI API  (api.openai.com, HTTPS)                       │
                         │                          or Open Rings AI engine (127.0.0.1:11434, same server)    │
                         └────────────────────────────────────────────────────────────────────────────────────┘
```

### Local testing (Windows)

```
Browser ──> http://localhost:3000 ──> Node.js forum (npm start) ──> PostgreSQL "openrings_community" (your existing server)
                                                                └──> Claude / OpenAI / Open Rings AI on the same PC
```

### Design points
- **One process.** The web server and the background worker run in the same Node.js process. No Redis, no queue server, no build step.
- **One database.** The forum uses only its own database (`openrings_community`). Your PBX database is never touched.
- **Nothing new exposed.** In production the forum listens on `127.0.0.1:3000` only; nginx forwards `/community/` to it.
- **Settings live in the database.** Everything an admin can change (answer mode, AI provider and keys, knowledge base, daily posts) is stored in the `settings` table and takes effect within seconds, without a restart. `.env` holds only server settings (database, port, URL).
- **Jobs live in the database.** Answers and daily posts are jobs in the `jobs` table, so nothing is lost on a restart.

### Database tables

The forum creates these 11 tables itself on first start (from `src/schema.sql`). Never create them by hand.

| Table | Holds |
|---|---|
| `users` | Members, support engineers, admins, sample members (personas), the automated account |
| `sessions` | Login sessions |
| `categories`, `forums` | The forum structure, with per-forum settings |
| `threads`, `posts` | Questions and replies, with full-text search columns |
| `post_likes` | Likes |
| `reply_drafts` | Draft answers waiting in the Support inbox |
| `jobs` | Background jobs (answers, daily posts, follow-ups) |
| `scheduled_posts` | Today's planned daily discussions |
| `settings` | Everything set in the admin panel (API keys encrypted) |

### Folder layout

```
community/
  src/
    server.js          start-up
    app.js             web app (security headers, sessions, routes)
    worker.js          background worker
    schema.sql         database tables
    routes/            pages: public, auth, posting, support inbox, admin
    services/          forum, users, drafts, jobs, settings
    ai/                answer writer: providers, prompts, replies, daily posts, Open Rings AI setup
  views/               page templates
  public/              CSS, JavaScript, logo
  knowledge/openrings.md   starting text of the knowledge base (copied into the database once)
  seed/                default forums, sample members, topic ideas
  scripts/             doctor.js, init.js, seed-today.js, setup-openrings-ai.js
  deploy/              nginx and Apache snippets, systemd service, optional PostgreSQL schema setup
  test/                automated tests
  .env.example         settings template
```

---

## 4. How it works

### 4.1 Accounts and roles

| Role | Who | Can |
|---|---|---|
| **Member** | Anyone who registers | Ask, reply, like, mark the solution on their own thread, edit their own posts |
| **Support** | RingQ Support engineers (created by an admin) | Everything a member can, plus the Support inbox, staff tools, editing and deleting any post. Posts carry the team badge |
| **Admin** | You | Everything, plus the admin panel |
| **Sample member** (persona) | 14 built-in sample accounts | Used only for the daily discussions. They cannot log in |
| **Automated** | One account, `OpenRings_Assistant` | Posts automatic answers. Its posts are labelled **Automated** with the note *"Automated answer. Check it before you change a production system. The RingQ Support team follows up when needed."* |

Automatic answers are always posted from the **Automated** account, never under a support engineer's name. An engineer's name appears only on answers that engineer posted from the Support inbox or wrote by hand.

### 4.2 How a question gets answered

```
Member posts a question
        │
        ▼
Is it eligible for an automatic answer? (see 4.4) ── no ──> waits for a person to reply
        │ yes
        ▼
Answer job queued (after the configured wait)
        │
        ▼
Worker sends the answer writer: instructions + knowledge base + the whole thread + similar threads
        │
        ▼
Answer writer returns { should_reply, reply_markdown }
        │
        ├── should_reply = false ("thanks", "solved", member-to-member chat) ──> nothing is posted
        │
        ▼
Depends on the answer mode (see 4.3):
   Support review ──────────────> draft in the Support inbox, assigned to an on-duty engineer
   Review + automatic fallback ─> draft in the inbox; posted as Automated if nobody posts it in N minutes
   Automatic, in real time ─────> posted at once from the Automated account; appears live on the page
```

### 4.3 The three answer modes

Set in **Admin → Answer settings → How answers are published**.

| Mode | What happens | Good for |
|---|---|---|
| **Support review** (default) | Every answer is a **draft** in the Support inbox, assigned at random to an **on-duty** engineer (any support engineer if nobody is on duty). The engineer edits it if needed and posts it **under their own name** with the team badge. Nothing is posted until a person approves it. | Full control over every answer |
| **Support review, with automatic answer if nobody reviews in time** | Same as above. If no engineer posts the draft within *N* minutes (default 30), it is posted from the **Automated** account. Engineers can still reply afterwards. | Nights and weekends: every question gets an answer |
| **Automatic, in real time** | Answers post **within seconds** from the **Automated** account, without review. The member sees *A reply is being prepared…* and then the answer, without reloading. Engineers can add to any thread. | Instant answers, 24/7 |

When you switch to *Automatic* (or to the fallback mode), drafts already waiting in the Support inbox are posted too, a few seconds apart (or after the fallback time).

When an engineer replies **by hand** in a thread, any waiting draft for that thread is discarded, so the thread never gets a duplicate answer.

### 4.4 Who gets an automatic answer, and who doesn't

| Situation | Automatic answer? |
|---|---|
| A **member** starts a new thread | **Yes**, if *Write an answer for every new thread* is ticked (default) |
| A member posts a **follow-up** in their thread | **Yes**, if *Also answer follow-up replies* is ticked (default), until the thread reaches the maximum (see 4.5) |
| The follow-up is just "thanks", "solved", "that worked" | **No**, skipped |
| Another member answers in someone's thread (member-to-member chat) | Usually **no**: the writer skips posts that don't need the support team |
| A **support engineer or admin** starts a thread or replies | **No** (otherwise every staff post would get an answer). Use **Staff tools → Generate draft reply** to get one on purpose |
| *Automatic* mode, and a support engineer has already posted in the thread | **No** (default), so automatic answers don't talk over your team. Untick *Automatic mode: stop once a support engineer posts in the thread* to change this |
| The thread is **locked**, or automatic answers are **turned off for that thread** (Staff tools) | **No** |
| The forum has automatic answers turned off (Admin → Forums; *Announcements* by default) | **No** |
| The answer writer is **Off** in Admin → AI provider | **No** |
| A **daily discussion** (sample member's question) | **Yes**, after the daily answer delay (see 4.9) |

Several quick messages in a row get **one** answer that covers them all: only one answer job per thread is queued at a time.

### 4.5 How many answers per thread

**A member's question (real customer):**
- The question gets **one** answer.
- Each further answer comes when the member **writes back**: every follow-up gets one more answer.
- The limit is **4 support answers per thread** (*Max support answers per thread*, 1–50). It counts the engineers' replies too. After the limit, the thread waits for the team.
- If the member does not write back, the thread stays at one answer: there is nothing new to answer, and repeated unasked replies would annoy the customer.

Example: question → answer 1 → member: "still dropping" → answer 2 → member: "thanks, checking" → (no answer) → member: "log shows a BYE" → answer 3 → member: "now 32 seconds" → answer 4 → member: "any other idea?" → (no answer, limit of 4 reached).

**A daily discussion (sample member):**
- The question gets an answer after the *answer delay* (default 10–90 minutes).
- The sample member then asks a **random number of follow-up questions between the min and max** (*Follow-up questions per discussion*, default 1–3), each one after the *follow-up delay* (default 30–240 minutes after the previous answer).
- Every follow-up is answered (after the answer delay), up to *Max support answers per thread*. A follow-up that would go unanswered is not asked.
- With the defaults, a daily discussion gets **2 to 4 answers** over a few hours. For **exactly 4 answers** every time, set *Follow-up questions per discussion* min and max both to **3** (and keep *Max support answers per thread* at 4 or more).

### 4.6 Timing

| What | Default | Setting |
|---|---|---|
| Wait before an answer to a member is written | 20 seconds | *Wait before writing a reply, min/max (seconds)*. With a max, each answer waits a random time between the two, so answers don't arrive at a fixed interval. For real-time answers use 0–5 |
| Fallback mode: time an engineer has to post a draft | 30 minutes | *Wait for a review before posting automatically* |
| Daily discussions: posting window | 09:00–21:00 | *Posting window start / end* (site time zone, `SITE_TIMEZONE`) |
| Daily discussions: answer delay (question and each follow-up) | 10–90 minutes | *Answer delay, min/max (minutes)* |
| Daily discussions: number of follow-ups from the sample member | 1–3 | *Follow-up questions per discussion, min/max* |
| Daily discussions: follow-up delay | 30–240 minutes after the previous answer | *Follow-up delay, min/max (minutes)* |
| Time to write an answer | Claude/OpenAI: a few seconds. Open Rings AI: seconds with a graphics card, one to several minutes without | — |

### 4.7 Live updates: replies appear without reloading

An open thread page asks the server every 3 seconds for new posts (every 15 seconds after 3 idle minutes, every 60 seconds after 15, and not while the browser tab is hidden). New posts slide in, the reply count updates, and while an automatic answer is queued or being written the page shows *A reply is being prepared…*

This uses a normal HTTP request (`GET /community/threads/<id>/live?after=<last post id>`). No WebSocket, no extra nginx settings.

### 4.8 How an answer is written

1. The worker collects: the **instructions** (tone, format, safety rules), the **knowledge base**, the **whole thread** (very long threads are shortened to the first post plus the latest ones), and links to **similar threads** in the forum.
2. The answer writer returns structured JSON: `should_reply` (yes/no) and `reply_markdown` (the answer).
3. The answer is validated. A malformed answer is not posted.

Rules the answer writer follows:
- OpenRings facts come **only** from the knowledge base. It does not invent commands, menu paths, config file names or features. When the knowledge base doesn't cover something, it says so and asks for details (version, logs) or points to the documentation.
- It writes as the support team, in plain language, with steps and code blocks where useful.
- It skips posts that don't need an answer.
- It links to a similar thread only when that really helps.

### 4.9 Daily automated discussions

```
Shortly after midnight (site time zone)
   │  plan today's batch (once per day; if the forum was not running at midnight, as soon as it starts)
   ▼
One request to the answer writer writes N questions (default 3)
   │  each in the voice of a sample member (rotated, those who haven't posted in 3 days first)
   │  each in a forum picked by its "daily posts weight"
   │  about 60% based on your Topic ideas (each idea is used once, then removed)
   ▼
Each question gets a random time in the posting window (09:00–21:00)
   │  if planned late in the day: spread over the rest of the window (if under 1 hour is left: over the next 3 hours)
   │  if "Hold generated questions for admin approval" is ticked: waits in Admin → Daily posts
   ▼
At its time, the question is published as a new thread by that sample member
   ▼
Answered after 10–90 minutes (in the current answer mode)
   ▼
The sample member asks a follow-up 30–240 minutes later ──> answered after 10–90 minutes
   ▼   (repeated: 1–3 follow-ups per discussion by default, up to "Max support answers per thread")
Discussion complete: e.g. question + 3 follow-ups + 4 answers
```

- The forum must be **running** for this to happen. A question whose time has passed while the forum was stopped is published as soon as it starts.
- **Admin → Daily posts** shows today's status at the top: how many are planned, when the next one is due, or why nothing was planned (daily posts off, no answer writer, an error, with **Try again now**).
- **Generate with AI** creates a batch now; **Publish now** publishes one at once; **Approve all** releases every question waiting for approval (overdue ones publish at once).
- From the command line: `node scripts/seed-today.js [count] [--publish]`.
- Sample members appear as ordinary members. A setting can label them and their questions as *Sample question* (off by default).

### 4.10 The knowledge base

- **Admin → Knowledge base** holds the OpenRings product facts the answer writer may use. It is stored in the **database** and never shown to visitors.
- `knowledge/openrings.md` is only the **starting text**, copied into the database the first time the forum runs on a new database. Editing that file later has no effect; edit in the admin panel.
- Every answer and daily question uses the latest saved text. The page shows when it was last saved.
- Lines marked `[TO FILL]` are treated as "not known yet" and never repeated in answers. Replace them with real facts from the documentation.
- The better the knowledge base, the better the answers. Add FAQs, config file names, portal menu paths and defaults.

### 4.11 Answer writers (AI providers)

Chosen in **Admin → AI provider** from a dropdown. Only the chosen provider's settings are shown. The choice is saved in the database, stays after a reload, and takes effect within seconds.

| Provider | Needs | Cost | Notes |
|---|---|---|---|
| **Claude** (Anthropic) | API key | Pay per use, about $0.03–0.08 per answer with the default model | Best quality. Default model `claude-opus-5-5` |
| **OpenAI** | API key | Pay per use | Default model `gpt-5.5` |
| **Open Rings AI** (self-hosted) | A machine with about 8 GB free memory; set up with one command (section 7) | No per-use cost | Runs on your own server. Slower and simpler answers |
| **Demo text** | Nothing | Free | Clearly marked test text, to try the workflow |
| **Off** | Nothing | Free | No automatic answers and no daily posts. The forum itself works normally |

- **Save and test connection** checks the key, the model, and (for Claude/OpenAI) the account credit with one tiny request.
- **API keys are stored encrypted** (AES-256-GCM) in the database and only ever shown masked. The encryption key is `SECRET_KEY` from `.env` if set, otherwise a random `data/secret.key` file created on first save. Back that file up with the database.
- Keys in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) still work as a fallback; keys saved in the admin panel win.
- Each provider keeps its own settings, so you can switch back and forth.

### 4.12 Background jobs and retries

The worker inside the forum process checks for due jobs every 5 seconds, and immediately when a new job is due within seconds.

| Job | What it does |
|---|---|
| `ai_reply` | Writes an answer (draft or automatic post) |
| `draft_fallback` | Posts a draft automatically when nobody reviewed it in time |
| `seed_generate` | Writes today's daily questions |
| `seed_followup` | Writes a sample member's follow-up question |

| Failure | Retry |
|---|---|
| Temporary error (network, overload) | Up to 3 attempts, with growing pauses |
| No credit (Claude) or quota (OpenAI), or the Open Rings AI engine is not running | Every hour for a day, so jobs continue after a top-up or restart |
| Permanent error (wrong key, bad request, refusal) | No retry. Fix the cause, then **Retry** in Admin → Activity |

**Admin → Activity** lists every job with its status, error, timing and token usage, and a **Retry** button.

---

## 5. Setup on Windows (local testing)

Takes about 30 minutes. The guide assumes the folder `C:\Users\Thilak\Desktop\openrings\community` and your existing PostgreSQL server.

### Step 1: Install Node.js

1. Download the **LTS** version (22 or newer) from https://nodejs.org/en/download as the **Windows Installer (.msi)** and install with the default options.
2. Open a **new** Command Prompt and check: `node -v` shows `v22.x.x` or higher.

> Every command here works in Command Prompt and PowerShell. Always put passwords in **double quotes**. In PowerShell, if you see *"running scripts is disabled on this system"*, run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once (or type `npm.cmd` instead of `npm`).

### Step 2: Put the code in the folder

Extract `openrings-community.zip` **directly into** the folder. In Command Prompt (change the first path if the zip is elsewhere):

```bat
mkdir "C:\Users\Thilak\Desktop\openrings\community"
tar -xf "%USERPROFILE%\Downloads\openrings-community.zip" -C "C:\Users\Thilak\Desktop\openrings\community"
```

`package.json` must sit directly in `community`, not in a subfolder. (Explorer's *Extract All* with its suggested folder creates a subfolder.)

```
community\
  package.json  .env.example  README.md
  src\  views\  public\  scripts\  seed\  knowledge\  deploy\  test\
```

### Step 3: Create the database

You need the password of the `postgres` superuser. PostgreSQL 12 or newer is required (`SELECT version();`).

Choose a strong password for a new database user `openrings` (avoid `'` and `\`). In **pgAdmin**: right-click the **postgres** database → **Query Tool**, paste, replace `YOUR_PASSWORD`, press **F5**:

```sql
CREATE ROLE openrings WITH LOGIN PASSWORD 'YOUR_PASSWORD';
CREATE DATABASE openrings_community OWNER openrings ENCODING 'UTF8' TEMPLATE template0;
```

Or in **SQL Shell (psql)**: accept the defaults, enter the `postgres` password, paste the two lines, then `\q`.

**Do not create any tables.** The forum creates them on first start.

Note your PostgreSQL **port** (default 5432; with several versions installed it may be 5433+): pgAdmin → right-click the server → **Properties → Connection → Port**.

> **Alternative:** to keep the forum inside your existing `ringqswitch` database instead, run `deploy/postgres-setup.sql` there (it creates a role `openrings_app` and a schema `community`), then use `DB_NAME=ringqswitch`, `DB_USER=openrings_app` and `DB_SCHEMA=community` in step 4. A separate database is simpler and recommended.

### Step 4: Create the `.env` settings file

Open Command Prompt **in the community folder** (in Explorer, type `cmd` in the address bar and press Enter):

```bat
copy .env.example .env
notepad .env
```

Change these lines:

```ini
SITE_TIMEZONE=Asia/Kolkata
DB_HOST=localhost
DB_PORT=5432
DB_NAME=openrings_community
DB_USER=openrings
DB_PASSWORD="YOUR_PASSWORD"
```

- Keep the **double quotes** around the password (a `#` would otherwise start a comment).
- API keys do **not** go in this file; you enter them in the admin panel.
- Save. The file must be named `.env`, not `.env.txt` (check with `dir /a`).

### Step 5: Install and check

```bat
npm install
node scripts/doctor.js
```

`doctor.js` checks Node.js, `.env`, the database connection, the **11 tables** (it creates them on the first run), the admin account and the answer writer. Every `[FAIL]` line shows the fix underneath.

### Step 6: Create your accounts

```bat
node scripts/init.js --admin thilak you@yourcompany.com "Admin-Pass-2026"
node scripts/init.js --support ringq_support support@yourcompany.com "Support-Pass-2026"
```

- Use **double quotes**. Single quotes become part of the password in Command Prompt.
- On the command line, use letters, digits and `-` `@` `!` `_` only. Change to any password later under **Account**.
- Usernames: 3–24 characters (letters, numbers, `.` `-` `_`). Passwords: 8+ characters.
- Forgot a password: `node scripts/init.js --reset-password thilak "New-Pass-2026"`

### Step 7: Start the forum

```bat
npm start
```

```
OpenRings Community 1.5.0 is running.
  Open:   http://127.0.0.1:3000/
  AI: Off (choose a provider and key in Admin → AI provider)
Press Ctrl+C to stop.
```

Open **http://localhost:3000**. Keep this window open; **Ctrl+C** stops the forum. The forum (including daily posts and automatic answers) only works while it is running.

### Step 8: Choose the answer writer

1. Log in as admin → **Admin → AI provider**.
2. Choose one:
   - **Demo text**: no key; good for a first test of the workflow.
   - **Claude**: get a key (below), paste it.
   - **OpenAI**: get a key (below), paste it.
   - **Open Rings AI**: no key; run `npm run ai:setup` first (section 7).
3. Click **Save and test connection**. Every line should say *OK*.

**Getting a Claude key:** sign in at https://platform.claude.com/ → **Plans & Billing** → add credits (usage is prepaid; without credit every request fails with *"Your credit balance is too low"*) → https://platform.claude.com/settings/keys → **Create key**. Copy it (starts with `sk-ant-`). To cap spending, create the key in its own workspace and set a limit at https://platform.claude.com/settings/spend-limits.

**Getting an OpenAI key:** sign in at https://platform.openai.com/ → add billing → https://platform.openai.com/api-keys → create a key (starts with `sk-`).

Never post a key in the forum, chat or email.

### Step 9: Test everything

Use a normal browser window for admin/support and a **private window** for a test member.

| # | Do this | You should see |
|---|---|---|
| 1 | Open http://localhost:3000 | Header with Forums, What's new, Members and one **Ask a question** button; 4 categories, 14 forums |
| 2 | Admin → **Users & staff**: tick **On duty** for `ringq_support`, **Save** | Dashboard shows "On duty: ringq_support" |
| 3 | Private window: **Join** and register `test_member` | Logged in, with a welcome message |
| 4 | As test_member: **Ask a question** | The thread, with "A RingQ Support engineer will reply here soon" (review mode) |
| 5 | As ringq_support: wait about 30 seconds, open the **Support inbox** (inbox icon in the header) | A draft answer for that question |
| 6 | Edit if you like, then **Post and open thread** | The reply under **ringq_support** with the **RingQ Support** badge |
| 7 | As test_member: reply `Thanks, that worked!` | No new draft (thank-yous are skipped) |
| 8 | As test_member: reply with another question | A new draft in the Support inbox |
| 9 | **Like** a post, then **Mark as solution** | Like count updates; the thread shows *Solved* |
| 10 | Search for a word from your question | The thread is found |
| 11 | Admin → **Answer settings**: **Automatic, in real time**, wait `0`–`5` seconds, **Save settings**. As test_member, ask a new question and stay on the page | *A reply is being prepared…*, then the answer appears within seconds, labelled **Automated**, without reloading |
| 12 | Admin → **Daily posts → Generate with AI** (3), then **Publish now** on one | A new thread from a sample member; its answer follows after the daily answer delay |
| 13 | Click the sun/moon icon | Switches between dark and light |
| 14 | Admin → **Activity** | Every job, with status and token usage |
| 15 | Admin → **Knowledge base**: add a line, **Save** | "last saved" shows the time; new answers use the saved text |

To look at the data: pgAdmin → **openrings_community → Schemas → public → Tables**.

**While testing:** the daily scheduler writes 3 questions a day while `npm start` runs. To pause it, untick **Create new discussions every day** in Admin → Answer settings.

---

## 6. Deployment on Linux (openrings.org)

For the developer who runs openrings.org. Puts the forum at **https://openrings.org/community/** on the same server.

### Requirements

- 64-bit Linux (Ubuntu/Debian or RHEL/Rocky/AlmaLinux). Tested on Ubuntu 24.04.
- **Node.js 22 or 24 (LTS)**.
- **PostgreSQL 12 or newer** (the existing server is fine).
- The existing web server for openrings.org (nginx assumed; an Apache snippet is included), already on HTTPS.
- Outbound HTTPS to `api.anthropic.com` (Claude) or `api.openai.com` (OpenAI). For Open Rings AI instead: about 8 GB free memory and 6 GB disk (section 7).
- About 200 MB disk for the app plus database growth; under 200 MB memory for the Node process.

The zip contains the source, `package.json`/`package-lock.json`, this README and `deploy/`. It does **not** contain `.env`, passwords, keys or `node_modules`.

### Step 1: Install Node.js

Skip if `node -v` already prints v22 or v24.

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs unzip

# RHEL / Rocky / AlmaLinux
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf install -y nodejs unzip
```

### Step 2: Create the database (one time)

If PostgreSQL is not installed: `sudo apt-get install -y postgresql` (Ubuntu) or `sudo dnf install -y postgresql-server && sudo postgresql-setup --initdb && sudo systemctl enable --now postgresql` (RHEL).

```bash
sudo -u postgres psql
```
```sql
CREATE ROLE openrings WITH LOGIN PASSWORD 'CHANGE-ME-strong-password';
CREATE DATABASE openrings_community OWNER openrings ENCODING 'UTF8' TEMPLATE template0;
\q
```

**That's all you create by hand.** On first start the app creates its 11 tables and indexes, and inserts the default forums, sample members, starter knowledge base, topic ideas and the automated account. The schema uses `CREATE … IF NOT EXISTS` and runs under a PostgreSQL advisory lock on every start, so upgrades need no manual SQL.

> **RHEL family:** the default `pg_hba.conf` uses `ident` for TCP, so password logins fail with *"Ident authentication failed"*. In `/var/lib/pgsql/data/pg_hba.conf` change the `host all all 127.0.0.1/32 ident` line to `scram-sha-256`, then `sudo systemctl reload postgresql`.

> **Managed or remote database:** point `DB_HOST` at it and set `DB_SSL=true` if required. **Inside an existing database:** set `DB_SCHEMA=community` and give the role ownership of that schema (see `deploy/postgres-setup.sql`).

### Step 3: Install the application

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin openrings
sudo mkdir -p /opt/openrings-community
sudo unzip openrings-community.zip -d /opt/openrings-community
cd /opt/openrings-community
sudo npm ci --omit=dev
sudo chown -R openrings:openrings /opt/openrings-community
```

### Step 4: Configure `.env`

```bash
cd /opt/openrings-community
sudo cp .env.example .env
sudo nano .env
```

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
```

```bash
sudo chown openrings:openrings .env
sudo chmod 600 .env
```

- `SITE_URL` is the public origin only (no path); `BASE_PATH` is the folder. Together they build links, the sitemap and redirects.
- `NODE_ENV=production` makes login cookies HTTPS-only: test through **https://openrings.org/community/**, not `http://server-ip:3000`.
- API keys are **not** needed here; they are entered in Admin → AI provider.

### Step 5: Check the setup and create accounts

```bash
cd /opt/openrings-community
sudo -u openrings node scripts/doctor.js
```

Expect `[OK]` for Node.js, `.env`, PostgreSQL and **All 11 forum tables exist**. Once an answer writer is set up, doctor also makes one tiny test request (well under $0.01); add `--skip-test-call` to skip it.

```bash
sudo -u openrings node scripts/init.js --admin  siteadmin  admin@yourdomain.com  'Strong-Admin-Pass'
sudo -u openrings node scripts/init.js --support ringq_arun arun@yourdomain.com   'Strong-Support-Pass'
```

### Step 6: Run it as a service

```bash
which node      # if this is not /usr/bin/node, edit ExecStart in the unit file
sudo cp deploy/openrings-community.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openrings-community
sudo systemctl status openrings-community
curl -I http://127.0.0.1:3000/community/      # expect HTTP 200
```

The unit runs as the `openrings` user with systemd hardening (read-only system, private /tmp, no new privileges) and restarts automatically. Logs: `sudo journalctl -u openrings-community -f`.

### Step 7: Publish it at /community

**nginx:** paste the two blocks from `deploy/nginx-community.conf` into the existing HTTPS `server { … }` block for openrings.org:

```nginx
location = /community {
    return 301 /community/;
}
location /community/ {
    proxy_pass         http://127.0.0.1:3000;     # no path after the port
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

**Apache:** use `deploy/apache-community.conf` (needs `mod_proxy`, `mod_proxy_http`, `mod_headers`). If openrings.org is served from a CDN or static host, forward `/community/*` to this server there.

On the main website:
1. Add **Community** to the site menu, linking to `https://openrings.org/community/`.
2. Add `Sitemap: https://openrings.org/community/sitemap.xml` to openrings.org's `robots.txt` and submit it in Google Search Console.

Nothing else on the main site changes. The forum sends its own security headers for `/community/` only.

### Step 8: Go-live checklist (in the browser, as admin)

1. Open **https://openrings.org/community/** and log in as admin.
2. **Admin → AI provider:** choose Claude or OpenAI with a **separate production key**, or Open Rings AI (section 7). **Save and test connection**: all lines *OK*.
3. **Admin → Users & staff:** tick **On duty** for the engineers who should receive drafts.
4. **Admin → Knowledge base:** review and complete the product facts.
5. **Admin → Answer settings:** choose the answer mode, check daily posts (questions per day, posting window, approval).
6. Register a test member in a private window and ask a question. Check the answer arrives (inbox draft or live automatic answer).
7. Set a monthly **spend limit** on the production key (Claude Console or OpenAI billing settings).

### Docker alternative

A `Dockerfile` and `docker-compose.yml` are included. The container listens on 3000; publish it on `127.0.0.1:3000` only. Set `SECRET_KEY` in `.env` (any long random string), because the container's files are lost on rebuild, and `DB_HOST=host.docker.internal` to use PostgreSQL on the host. Steps 2, 4, 5 (inside the container), 7 and 8 stay the same.

---

## 7. Open Rings AI (self-hosted, no API key)

Open Rings AI runs the answer writer on your own machine: no API key and no per-use cost.

**Needs:** about 8 GB of free memory (16 GB total is comfortable), about 6 GB of disk, and internet access once for the download. Without a graphics card, an answer takes one to several minutes; with one, seconds. Answers are simpler than Claude or OpenAI, so keep **Support review** mode until you trust them.

**Set it up with one command** in the forum folder:

| System | Command |
|---|---|
| Windows (Command Prompt) | `npm run ai:setup` |
| Linux | `sudo node scripts/setup-openrings-ai.js` (administrator rights are needed once, to install the engine) |

It:
1. installs the Open Rings AI engine and starts it (first time only);
2. downloads the language model, about 5 GB (first time only; an interrupted download resumes);
3. creates the `openrings-ai` model with room for the knowledge base and a whole thread;
4. tests it;
5. selects **Open Rings AI** in Admin → AI provider. The running forum picks it up within seconds.

Then open **Admin → AI provider** and click **Save and test connection**. Leave *Engine address* and *Model name* empty: they default to the engine on the same machine (`http://127.0.0.1:11434/v1`) and `openrings-ai`.

Options: `--url http://<machine>:11434` uses an engine on another machine (run the setup on that machine first); `--no-install` never installs anything; `--no-activate` leaves the forum setting unchanged.

- The engine starts automatically with the machine. If it is stopped, answers wait and retry every hour for a day; run the setup command again to start it.
- The engine listens on **port 11434 without a login**. Never open that port to the internet. If it runs on another machine, allow the port only from the forum server's IP.

---

## 8. Admin guide

### First day

1. **AI provider:** choose the answer writer and test it.
2. **Users & staff:** create the support engineers (or with `init.js --support`), tick **On duty**.
3. **Knowledge base:** fill in product facts; replace `[TO FILL]` lines.
4. **Topic ideas:** add questions you want the daily discussions to cover, one per line.
5. **Answer settings:** choose the answer mode and daily post settings.
6. **Forums:** check the forum list, which forums get automatic answers, and the daily posts weight.

### Every day

- **Support inbox** (review modes): make sure drafts are being posted. The header inbox icon shows the count.
- **Daily posts:** check today's status; approve questions if approval is on (**Approve all**).
- **Activity:** look for failed jobs (credit, key or engine problems) and **Retry** after fixing.
- **Knowledge base:** add answers to questions that came up repeatedly.

### Admin pages

| Page | What it does |
|---|---|
| **Support inbox** | Drafts waiting for review: *All drafts* or *Assigned to me* |
| **Dashboard** | Version, counts, job status, who is on duty, warnings (e.g. no credit) |
| **Daily posts** | Today's status, planned questions (edit, approve, reject, publish now), **Generate with AI**, **Approve all**, add a question by hand |
| **Answer settings** | Answer mode, waits, follow-ups, max answers per thread, daily posts, team name, announcement banner |
| **AI provider** | Answer writer, keys, models, connection test |
| **Knowledge base** | Product facts for answers (database-stored, never public) |
| **Topic ideas** | Questions to use first for daily discussions |
| **Personas** | Sample member accounts: add, generate with AI, turn on or off |
| **Forums** | Categories and forums: titles, descriptions, order, staff-only, automatic answers on/off, daily posts weight |
| **Users & staff** | Search users, change roles (member/support/admin) and titles, on-duty roster, ban, add users |
| **Activity** | Background jobs with errors, token usage and Retry |

### Recipes

**Answer every question automatically, in real time**
1. Answer settings → **Automatic, in real time**.
2. *Wait before writing a reply*: `0` min, `5` max.
3. Tick **Write an answer for every new thread** and **Also answer follow-up replies**.
4. Untick **Hold generated questions for admin approval**.
5. **Save settings** (drafts already waiting are posted now).
6. Daily posts → **Approve all** if any questions are still waiting.

**Engineers review during office hours, automatic at night**
Choose **Support review, with automatic answer if nobody reviews in time** and set the minutes (e.g. 30).

**Every daily discussion gets 4 answers**
Answer settings → *Follow-up questions per discussion*: min `3`, max `3`; *Max support answers per thread*: `4`. Adjust *Answer delay* and *Follow-up delay* for the gaps between posts.

**Pause daily discussions:** untick **Create new discussions every day**.

**Stop automatic answers in one thread:** open the thread → Staff tools → automatic answers **off**.

**Stop automatic answers in one forum:** Admin → Forums → untick automatic answers for that forum.

---

## 9. Support engineer guide

- **Support inbox** (inbox icon in the header, with a count): each draft shows the question, the thread so far and the draft answer.
  - Edit the text, choose **Post as** (yourself or another engineer), then **Post reply** or **Post and open thread**.
  - **Regenerate** writes a new draft; **Discard** removes it.
  - *All drafts* shows everything; *Assigned to me* shows drafts given to you.
- **Replying by hand** in a thread discards that thread's waiting draft automatically.
- **Staff tools** on a thread: pin/unpin, lock/unlock, automatic answers on/off, **Generate draft reply**, move to another forum, rename, delete.
- Edit or delete any post; mark a solution on any thread.
- Your posts show the **RingQ Support** badge.
- Automatic answers (labelled *Automated*) can be followed up by you at any time; in *Automatic* mode, once you post in a thread, automatic answers stop there (default).

---

## 10. Settings reference

### `.env` (server settings)

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port the forum listens on |
| `HOST` | 127.0.0.1 | 127.0.0.1 = this machine only; 0.0.0.0 = other devices too (e.g. phones on your Wi-Fi, Docker) |
| `SITE_URL` | http://localhost:3000 | Public origin, no path (`https://openrings.org` in production) |
| `BASE_PATH` | empty | Sub-folder (`/community` in production) |
| `SITE_NAME` | OpenRings Community | Name in the header and page titles |
| `DOCS_URL` | https://openrings.org/docs/ | Documentation link used in answers |
| `SITE_TIMEZONE` | UTC | Time zone for the daily posting window and dates (e.g. `Asia/Kolkata`) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | localhost, 5432, openrings_community, openrings | Database connection. Quote the password |
| `DB_SCHEMA` | public | Schema for the tables (e.g. `community` inside an existing database) |
| `DATABASE_URL` | empty | One connection string instead of the `DB_*` lines |
| `DB_SSL` | false | true when the database requires SSL |
| `NODE_ENV` | empty | `production` on the server (HTTPS-only cookies) |
| `TRUST_PROXY` | loopback | Proxy in front of the forum (`loopback` for nginx on the same machine, `1` in Docker) |
| `RUN_WORKERS` | true | Run answers and daily posts in this process. Run **one** copy of the forum |
| `WORKER_INTERVAL_MS` | 5000 | How often the worker checks for due jobs |
| `SECRET_KEY` | empty | Encrypts saved API keys. Empty = random `data/secret.key`. Set it for Docker or several servers |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AI_PROVIDER`, `AI_MODEL`, `OPENAI_MODEL` | empty / defaults | Optional fallbacks; the admin panel wins |

### Answer settings (admin panel)

| Setting | Default |
|---|---|
| How answers are published | Support review |
| Wait for a review before posting automatically (fallback mode) | 30 minutes |
| Support team name | RingQ Support |
| Write an answer for every new thread | On |
| Also answer follow-up replies | On |
| Automatic mode: stop once a support engineer posts in the thread | On |
| Wait before writing a reply, min / max | 20 seconds / empty (= same as min) |
| Max support answers per thread | 4 |
| Create new discussions every day | On |
| Hold generated questions for admin approval | Off |
| Label sample member accounts and their questions as "Sample question" | Off |
| Questions per day | 3 (0–20) |
| Posting window start / end (hour) | 9 / 21 |
| Answer delay, min / max (minutes, daily discussions) | 10 / 90 |
| Follow-up questions per discussion, min / max | 1 / 3 |
| Follow-up delay, min / max (minutes after an answer) | 30 / 240 |
| Announcement banner | empty |

---

## 11. Commands reference

Run from the forum folder (on Linux, prefix with `sudo -u openrings` where shown).

| Command | What it does |
|---|---|
| `npm start` | Start the forum |
| `node scripts/doctor.js [--skip-test-call]` | Check Node, `.env`, database, tables, admin, answer writer |
| `node scripts/init.js` | Create tables, default forums and sample members (also done on start) |
| `node scripts/init.js --admin <user> <email> "<password>"` | Create an admin (or promote an existing user) |
| `node scripts/init.js --support <user> <email> "<password>"` | Create a support engineer |
| `node scripts/init.js --reset-password <user> "<new password>"` | Reset a password |
| `node scripts/seed-today.js [count] [--publish]` | Write daily questions now; `--publish` publishes them at once |
| `npm run ai:setup` / `sudo node scripts/setup-openrings-ai.js` | Set up Open Rings AI (Windows / Linux) |
| `npm test` | Automated tests (section 15) |

Linux service: `sudo systemctl status|restart openrings-community`, logs `sudo journalctl -u openrings-community -f`.

---

## 12. Updating, backups and moving data

### Updating on Windows

1. Stop the forum (**Ctrl+C**, then **Y**).
2. Extract the new zip **over** the folder (keeps `.env` and `data`):
   ```bat
   tar -xf "%USERPROFILE%\Downloads\openrings-community.zip" -C "C:\Users\Thilak\Desktop\openrings\community"
   ```
3. `npm install`, then `npm start`. The first line must show the new version.

### Updating on Linux

```bash
sudo -u postgres pg_dump -Fc openrings_community -f /tmp/before-update.dump   # quick backup
sudo unzip -o openrings-community.zip -d /opt/openrings-community             # .env and data/ are kept
cd /opt/openrings-community && sudo npm ci --omit=dev && sudo chown -R openrings:openrings .
sudo systemctl restart openrings-community
sudo -u openrings node scripts/doctor.js --skip-test-call
```

Database changes for new versions are applied automatically on start.

### Backups (Linux)

Daily database backup, kept 14 days:

```bash
sudo mkdir -p /var/backups/openrings-community && sudo chown postgres: /var/backups/openrings-community
echo "15 2 * * * postgres pg_dump -Fc openrings_community -f /var/backups/openrings-community/community-\$(date +\%F).dump && find /var/backups/openrings-community -name '*.dump' -mtime +14 -delete" | sudo tee /etc/cron.d/openrings-community-backup
```

Restore: `sudo -u postgres pg_restore --clean --no-owner --role=openrings -d openrings_community /var/backups/openrings-community/community-YYYY-MM-DD.dump`

Back up the database **and** `data/secret.key` (it decrypts the saved API keys). Without it, a restored database still works, but you re-enter the keys in Admin → AI provider. Everything else can be recreated from the zip plus `.env`.

### Moving data from the Windows PC to the server (optional)

**Recommended:** start production with an **empty database** so test posts don't go live. Copy the knowledge base by hand (Admin → Knowledge base: copy on the PC, paste on the server, Save).

To copy everything (accounts, forums, posts, settings), before the first start on the server:

```bash
# On the Windows PC
pg_dump -U openrings -h localhost -Fc openrings_community -f community.dump
# On the server, into the new empty database
pg_restore --no-owner --role=openrings -U openrings -h 127.0.0.1 -d openrings_community community.dump
```

Saved API keys only work on the server if you also copy `data/secret.key` (or re-enter them).

---

## 13. Troubleshooting

### Start-up and database

| Message / symptom | Fix |
|---|---|
| `'node' is not recognized` | Install Node.js (Windows step 1), then open a **new** terminal |
| `password authentication failed for user "openrings"` | Wrong `DB_PASSWORD`. Put it in double quotes in `.env`. Reset with `ALTER ROLE openrings WITH PASSWORD 'new';` as `postgres` |
| `database "openrings_community" does not exist` | Create it (Windows step 3 / Linux step 2); check `DB_NAME` |
| `connect ECONNREFUSED 127.0.0.1:5432` | PostgreSQL isn't running or the port differs. Windows: `services.msc` → **postgresql-x64-NN** → Start. Linux: `systemctl status postgresql`. Check `DB_PORT` |
| `permission denied for schema public` | The database isn't owned by `openrings`: `ALTER DATABASE openrings_community OWNER TO openrings;` then, connected to that database, `ALTER SCHEMA public OWNER TO openrings;` |
| `Ident authentication failed` | RHEL `pg_hba.conf`: change `ident` to `scram-sha-256` for 127.0.0.1 |
| `encoding "UTF8" does not match locale` | Use `TEMPLATE template0` in `CREATE DATABASE` |
| `EADDRINUSE :3000` | Port taken. Set another `PORT` (and `SITE_URL` locally, or `proxy_pass` on the server) |
| `running scripts is disabled on this system` | PowerShell: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`, or use `npm.cmd` |
| `Missing script: "ai:setup"`, or pages look like an old version | The new files went into a subfolder. Extract over the folder (section 12) and check the version on start-up |

### Login

| Symptom | Fix |
|---|---|
| `Incorrect username/email or password` right after creating the account | The password was typed with single quotes in Command Prompt. Reset: `node scripts/init.js --reset-password thilak "Admin-Pass-2026"` |
| Login does nothing / logs you straight out (PC) | Remove `NODE_ENV=production` from `.env` on the PC (production needs HTTPS) |
| Logged out immediately on the server | Open it at https://openrings.org/community/, not over http or port 3000. Check nginx sends `X-Forwarded-Proto` |

### Server and nginx

| Symptom | Fix |
|---|---|
| `502 Bad Gateway` on /community | The service isn't running: `systemctl status openrings-community`, `journalctl -u openrings-community -n 50` |
| 404 from nginx, or pages without styles | `BASE_PATH=/community` missing, or `proxy_pass` has a path after the port (must be exactly `http://127.0.0.1:3000;`) |
| `status=203/EXEC` in systemd | Node isn't at `/usr/bin/node`. Set `ExecStart` to the output of `which node` |

### Answers and daily posts

| Symptom | Fix |
|---|---|
| A question got no answer | Was it posted by an admin or support account? Those never get automatic answers (use a member account, or **Staff tools → Generate draft reply**). Otherwise check **Admin → Activity** for the error |
| The answer is waiting in the Support inbox | You are in a review mode. Post it, or switch to **Automatic, in real time** (section 8 recipes) |
| Inbox says "Nothing assigned to you" | The draft went to another engineer. Click **All drafts**; tick **On duty** for the right engineers |
| `Your credit balance is too low` (Claude) or `exceeded your current quota` (OpenAI) | Add credits or billing. Waiting jobs retry hourly for a day; older ones: Admin → Activity → **Retry** |
| `401 invalid x-api-key` / authentication error | Wrong or expired key. Create a new one and paste it in Admin → AI provider |
| "The saved key cannot be read" | `data/secret.key` was lost or replaced. Paste the key again and Save |
| "The Open Rings AI engine is not running" | Windows: run `npm run ai:setup` (first time), or restart the PC. Linux: `sudo node scripts/setup-openrings-ai.js`. Waiting answers are written once it runs |
| "no model called …" (Open Rings AI) | Clear the **Model name** field (uses `openrings-ai`) and save, or run the setup again |
| Open Rings AI answers take minutes | Normal without a graphics card. Use Claude/OpenAI for instant answers, or a machine with a graphics card |
| Daily questions didn't appear | The top of **Admin → Daily posts** says why: off, no answer writer, an error (**Try again now**), not due yet, or waiting for approval (**Approve all**). They only publish while the forum is running |
| Many daily questions at once after starting | Normal after the forum was stopped: overdue questions publish as soon as it starts |
| Live reply didn't appear | Check the answer mode is *Automatic*; the page checks every 3 seconds while open. In review modes, answers appear only after an engineer posts them |

---

## 14. Security

- **Passwords:** hashed with scrypt; never stored in plain text.
- **Sessions:** stored in the database; HttpOnly cookies, HTTPS-only in production.
- **Forms:** CSRF tokens on every form; hidden honeypot fields against bots on registration and posting.
- **Rate limits:** login 10 per 15 minutes, registration 5 per hour, new threads 5 per 10 minutes, replies 20 per 10 minutes, likes 60 per minute.
- **Content:** Markdown is converted to HTML and sanitised; a strict Content Security Policy is sent on every page.
- **API keys:** encrypted (AES-256-GCM) in the database and shown only masked.
- **Network:** the forum listens on `127.0.0.1` only in production. Never open port 3000 (forum) or 11434 (Open Rings AI engine) in the firewall.
- **Service:** runs as the unprivileged `openrings` user with systemd hardening.
- **Privacy:** member emails are never shown publicly. Ask members to report security issues privately through https://openrings.org/contact/, not in public threads.

---

## 15. Automated tests

The tests run in a temporary schema inside the database and remove it afterwards; your forum data is not touched. Write `#` in the password as `%23`.

```bat
set TEST_DATABASE_URL=postgres://openrings:YOUR_PASSWORD@localhost:5432/openrings_community
npm test
```

(PowerShell: `$env:TEST_DATABASE_URL = "postgres://..."`; Linux: `TEST_DATABASE_URL=... npm test`.)

Expected result: `# pass 36` and `# fail 0`.
