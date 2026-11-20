# OpenRings Community: Windows setup guide (local testing)

This guide gets the forum running on your Windows PC with your existing PostgreSQL server. It assumes the folder is:

```
C:\Users\Thilak\Desktop\openrings\community
```

It takes about 30 minutes. You will:

1. Install Node.js
2. Put the code in the folder
3. Create the `openrings_community` database in PostgreSQL
4. Get a Claude or OpenAI API key (optional: you can test without one first)
5. Fill in the `.env` settings file
6. Install and run the setup check
7. Create your admin and RingQ Support accounts
8. Start the forum and test everything
9. Switch from demo drafts to real drafts

> **Why a separate database?** The forum creates and uses only its own database, `openrings_community`. Your existing PBX database is never touched. This keeps PBX data safe, keeps backups separate, and makes the later move to openrings.org a simple copy of one database.

---

## Step 1: Install Node.js

1. Go to https://nodejs.org/en/download and download the **LTS** version (22 or newer) as the **Windows Installer (.msi)**.
2. Run the installer and keep the default options. The forum does not need the "Tools for Native Modules" option.
3. Open a **new** terminal (Start menu, type `cmd` for Command Prompt or `PowerShell`, press Enter) and check:

   ```
   node -v
   npm -v
   ```

> **Command Prompt or PowerShell?** Every command in this guide works in both. The only difference is how passwords are quoted: always use **double quotes** (see step 7).

   `node -v` should print `v22.x.x` or higher.

---

## Step 2: Put the code in the folder

1. Download `openrings-community.zip`.
2. Right-click it, choose **Extract All…**, and extract to `C:\Users\Thilak\Desktop\openrings\community`.
3. Check that `package.json` sits **directly** inside `community`, not in `community\community`. If it is nested, move the inner contents up one level.

The folder should look like this:

```
community\
  package.json
  .env.example
  src\  views\  public\  scripts\  seed\  knowledge\  docs\  test\
```

---

## Step 3: Create the database in PostgreSQL

You need the password of the `postgres` superuser, which you set when you installed PostgreSQL. The forum needs **PostgreSQL 12 or newer**. To check, run `SELECT version();` in step 3.2.

### 3.1 Choose a password for the forum's database user

Choose a strong password for a new database user called `openrings`, for example `Or-Community-2026!`. Write it down; you need it in step 5.

> Avoid the characters `'` and `\` in this password to keep the SQL simple.

### 3.2 Run the SQL

**Using pgAdmin (GUI):**

1. Open **pgAdmin**, expand **Servers → PostgreSQL NN**, and enter the `postgres` password.
2. Right-click the **postgres** database (under *Databases*) and choose **Query Tool**.
3. Paste the following, put your password in place of `YOUR_PASSWORD`, and press **F5** (Execute):

```sql
CREATE ROLE openrings WITH LOGIN PASSWORD 'YOUR_PASSWORD';
CREATE DATABASE openrings_community OWNER openrings ENCODING 'UTF8' TEMPLATE template0;
```

4. Right-click **Databases** and choose **Refresh**. `openrings_community` should now be listed.

**Or using SQL Shell (psql):**

1. Start menu: **SQL Shell (psql)**.
2. Press **Enter** to accept each default (Server `localhost`, Database `postgres`, Port `5432`, Username `postgres`), then type the `postgres` password.
3. Paste the two SQL lines above (with your password) and press Enter. You should see `CREATE ROLE` and `CREATE DATABASE`.
4. Type `\q` to exit.

**You do not need to create any tables.** The forum creates its 11 tables (`users`, `forums`, `threads`, `posts`, …) inside `openrings_community` automatically the first time it runs.

### 3.3 Note your PostgreSQL port

The default is **5432**. If you have more than one PostgreSQL version installed, it may be 5433 or higher. In pgAdmin, right-click the server, choose **Properties**, open the **Connection** tab and read **Port**.

---

## Step 4: Get a Claude API key (for drafted answers)

You can **skip this step for now** and test with demo drafts (step 5 shows how). Come back when you are ready for real drafts.

1. Open https://platform.claude.com/ and sign up or log in (Google or email).
2. **Buy credits.** API usage is prepaid. In the Console, open **Plans & Billing** and add credits. Without credit, the key passes the free checks, but every draft request fails with *"Your credit balance is too low"*. A small top-up is plenty for testing.
3. Open https://platform.claude.com/settings/keys and click **Create key**.
   - **Name:** `openrings-community-local`
   - **Expiration:** 30 days is fine for testing. Create a separate key for the live server later.
   - **Linked account:** yourself
4. **Copy the key immediately.** It starts with `sk-ant-api03-…`. Keep it in a password manager. Never post it in the forum, chat or email, and never commit it to Git.
5. *(Recommended)* To cap spending, put the forum in its own **workspace** and set a monthly limit at https://platform.claude.com/settings/spend-limits. Spend limits cannot be set on the *Default Workspace*, so create the key inside the new workspace.

**What it costs:** with the default model (`claude-opus-5-5`), each draft costs roughly $0.03–0.08. Three daily questions with their drafts come to roughly $0.30–0.60 per day.

**No API key at all?** Use **Open Rings AI**, which runs on your own PC. In Command Prompt, in the forum folder, run `npm run ai:setup`. It installs the Open Rings AI engine, downloads the model (about 5 GB, first time only), tests it and selects it in **Admin → AI provider**. You need about 8 GB of free memory and 6 GB of disk space, and answers take a minute or more without a graphics card. See "Open Rings AI" in the README for details.

**Prefer OpenAI?** You can use an OpenAI key instead of a Claude key:
1. Sign in at https://platform.openai.com/, add billing (prepaid credits or a payment method), then create a key at https://platform.openai.com/api-keys (it starts with `sk-`).
2. Enter it in **Admin → AI provider** (step 9): choose **OpenAI**, paste the key, optionally change the model (default `gpt-5.5`), and click **Save and test connection**.

---

## Step 5: Create the `.env` settings file

1. Open a terminal **in the community folder**: in File Explorer, open `C:\Users\Thilak\Desktop\openrings\community`, click the address bar, type `cmd` (or `powershell`) and press Enter.
2. Copy the template and open it in Notepad:

   ```
   copy .env.example .env
   notepad .env
   ```

3. Change these lines and leave the rest as they are:

   ```ini
   SITE_TIMEZONE=Asia/Kolkata
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=openrings_community
   DB_USER=openrings
   DB_PASSWORD="YOUR_PASSWORD"
   ```

   - Keep the **double quotes** around the password. Without them, a `#` in the password is treated as the start of a comment and the password is cut off.
   - Set `SITE_TIMEZONE` to your own time zone (e.g. `Asia/Singapore`, `Asia/Kuala_Lumpur`). Daily questions are posted between 09:00 and 21:00 in this zone.

4. **API keys don't go in this file.** You enter them in the admin panel later (step 9). For a first test without a key, you can choose **Demo text** there too.
5. Save and close Notepad. Make sure the file is named `.env`, **not** `.env.txt`. If in doubt, run `dir /a` (Command Prompt) or `Get-ChildItem -Force` (PowerShell) to list the files.

---

## Step 6: Install and run the setup check

In the same terminal window:

```
npm install
node scripts/doctor.js
```

`npm install` downloads the libraries (about 1 minute). `doctor.js` checks everything. Once a key is set (step 9), it also makes one tiny test request (well under $0.01) to confirm the account has credit; add `--skip-test-call` to skip it. It should show:

```
  [OK]   Node.js 24.x
  [OK]   .env file found
  [OK]   Connected to PostgreSQL 15.x (openrings@localhost:5432/openrings_community, schema "public")
  [OK]   All 10 forum tables exist
  [WARN] No admin account yet. ...
  [..]   AI provider: Off (from automatic)                      (until you set it up in step 9)
  [WARN] AI is off. The forum works, but there are no drafts or daily posts.
```

Any `[FAIL]` line shows the fix underneath it. See also **Troubleshooting** at the end of this guide.

> **"running scripts is disabled on this system"?** PowerShell is blocking `npm`. Run this once, then try again:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`
> (Or type `npm.cmd install` instead of `npm install`.)

---

## Step 7: Create your accounts

Create the **admin** account (you) and at least one **RingQ Support** staff account:

```
node scripts/init.js --admin thilak you@yourcompany.com "Admin-Pass-2026"
node scripts/init.js --support ringq_support support@yourcompany.com "Support-Pass-2026"
```

- Put passwords in **double quotes**. This works in both Command Prompt and PowerShell. Don't use single quotes: Command Prompt keeps them as part of the password.
- On the command line, use a simple password made of letters, digits and `-` `@` `!` `_`. Avoid `$`, `%`, `^`, `&` and quotes, which the terminal may change. After logging in, change to any password you like in **Account settings**.
- Usernames: 3–24 characters (letters, numbers, `.` `-` `_`). Passwords: 8+ characters.
- You can add more support staff later in **Admin → Users & staff**.
- Forgot a password? `node scripts/init.js --reset-password thilak "New-Pass-2026"`

---

## Step 8: Start the forum and test

```
npm start
```

You should see:

```
OpenRings Community is running.
  Open:   http://127.0.0.1:3000/
  AI: mock
Press Ctrl+C to stop.
```

Open **http://localhost:3000** in your browser. Keep the terminal window open while you use the forum; press **Ctrl+C** in it to stop. To start again later, open a terminal in the folder and run `npm start`.

> On the **first start with a key or demo mode**, the daily scheduler immediately writes today's batch of questions (3 by default). That's expected. To control it, see **Admin → Answer settings**.

### Who answers questions

The public sees answers from **support engineers**, under the RingQ Support badge. Behind the scenes:

1. When a member asks a question, a draft answer is written automatically.
2. The draft goes to a randomly chosen **on-duty** support engineer.
3. The engineer opens the **Support inbox** (in the menu, with a count), checks and edits the draft, and clicks **Post reply**. It appears in the thread under their name.

Mark who is on duty in **Admin → Users & staff → On duty**.

### Answer every question automatically, in real time

If you want every question answered within seconds, without anyone reviewing first:

1. Open **Admin → Answer settings**.
2. Under *How answers are published*, choose **Automatic, in real time**.
3. Set *Wait before writing a reply* to `0` (min) and `5` (max) seconds.
4. Make sure **Write an answer for every new thread** and **Also answer follow-up replies** are ticked.
5. Untick **Hold generated questions for admin approval**, so daily questions publish on their own.
6. Click **Save settings**. Drafts already waiting in the Support inbox are posted now, a few seconds apart.
7. If daily questions are still waiting, open **Admin → Daily posts** and click **Approve all**.

A member who posts a question sees *A reply is being prepared…* under it, and the answer appears on the page a few seconds later, without reloading. Automatic answers are posted from the automated account, labelled **Automated**. Support engineers can add their own replies to any thread.

The middle option, **Support review, with automatic answer if nobody reviews in time**, keeps engineer review during working hours and answers automatically after the number of minutes you set.

### Test checklist

First switch drafts on: log in as admin, open **Admin → AI provider**, and choose **Demo text** (no key needed) or set up Claude/OpenAI as in step 9.

Use a normal browser window for the admin or support account, and a **private/incognito** window for a test member.

| # | Do this | You should see |
|---|---|---|
| 1 | Open http://localhost:3000 | The **OpenRings Community** header (Forums, What's new, Members, one **Ask a question** button) and 4 categories with 14 forums |
| 2 | Admin → **Users & staff**: tick **On duty** for `ringq_support`, then **Save** | Dashboard shows "On duty: ringq_support" |
| 3 | Private window: **Join** and register `test_member` | Logged in, with a welcome message |
| 4 | As test_member: **Ask a question** in *SIP Trunks & VoIP Providers* | The thread, with "A RingQ Support engineer will reply here soon" |
| 5 | Normal window: log in as `ringq_support`, wait about 30 seconds, open **Support inbox** | A draft reply for that question, assigned to ringq_support |
| 6 | Edit the draft if you like, then **Post and open thread** | The reply in the thread under **ringq_support** with the green **RingQ Support** badge |
| 7 | As test_member: reply `Thanks, that worked!` | No new draft. Thank-yous are skipped |
| 8 | As test_member: reply with another question | A new draft appears in the Support inbox |
| 9 | As test_member: **Like** a post, then **Mark as solution** | The like count updates; the thread shows *Solved* |
| 10 | Search for a word from your question (search box in the community bar) | The thread is found |
| 11 | Admin → **Daily posts → Generate with AI** (3) | After about a minute (refresh), 3 scheduled questions |
| 12 | Open one → **Publish now** | A new thread from a sample member. Its draft answer arrives in the Support inbox after the delay set in **Answer settings**; set *Answer delay min/max* to `0` and `1` to test quickly |
| 13 | Click the sun/moon icon in the header | Switches between dark and light, like openrings.org |
| 14 | Admin → **Activity** | Every draft job, with its status and token usage |
| 15 | Admin → **Knowledge base**: add a line, then **Save** | "last saved" shows the time. Every new draft uses the saved text. It is stored in the database and never shown to visitors |
| 16 | Admin → **Answer settings**: choose **Automatic, in real time**, wait `0`–`5` seconds, **Save settings**. Then, as test_member, ask a new question and stay on the page | *A reply is being prepared…*, then the answer appears within seconds, labelled **Automated**, without reloading |

To view the data itself, open pgAdmin: **openrings_community → Schemas → public → Tables**.

---

## Step 9: Turn on drafted answers (Claude or OpenAI)

1. Do step 4 to get a key if you haven't yet.
2. Log in as admin and open **Admin panel → AI provider**.
3. Pick **Claude**, **OpenAI** or **Open Rings AI (self-hosted)** from the dropdown. Only that provider's settings appear. Paste the key. For Open Rings AI there is no key: run `npm run ai:setup` in the forum folder first (it selects Open Rings AI for you). You can leave the model empty to use the default.
4. Click **Save and test connection**. You should see *OK: … API key works* and *OK: Test call succeeded*. If not, the message under it says what to fix. Typical causes are no credit on the account, or a mistyped key.
5. No restart is needed. Keys are stored encrypted in the database and never shown again in full. To change the key later, paste a new one; leave the field empty to keep the current one.
6. **Ask a test question from a member account** (a private window). A draft appears in the Support inbox after about 20–60 seconds. Questions posted by staff accounts (admin or support) do not get drafts automatically; use **Staff tools → Generate draft reply** on those.
5. **Check the knowledge base first** (Admin → Knowledge base). Drafts only state OpenRings facts that are in it.

**While testing on your PC:** the daily scheduler posts 3 questions every day while `npm start` is running. To pause it, untick **Create new discussions every day** in **Admin → Answer settings**. Turn on **Hold generated questions for admin approval** if you want to review questions before they publish. They then wait in **Admin → Daily posts** until you approve them, one by one or with **Approve all**.

---

## Updating to a new version

When you get a new `openrings-community.zip`:

1. Stop the forum: press **Ctrl+C** in its Command Prompt window, then **Y**.
2. Extract the zip **over** the existing folder. In Command Prompt (change the first path if the zip is somewhere else):
   ```bat
   tar -xf "%USERPROFILE%\Downloads\openrings-community.zip" -C "C:\Users\Thilak\Desktop\openrings\community"
   ```
   This replaces the program files and keeps your `.env` and the `data` folder. (Don't use Explorer's *Extract All* with its suggested folder: it puts the files in a new subfolder, so the forum keeps running the old version.)
3. In the forum folder: `npm install`, then `npm start`.
4. The first line must show the new version, e.g. `OpenRings Community 1.4.0 is running.` The version is also shown on **Admin → Dashboard**.

The database is updated automatically on start.

## Troubleshooting

| Message | Fix |
|---|---|
| `'node' is not recognized` | Reinstall Node.js (step 1), then open a **new** terminal window. |
| `Incorrect username/email or password` right after creating the account | The password was typed with single quotes in Command Prompt, so the quotes became part of it. Reset it: `node scripts/init.js --reset-password thilak "Admin-Pass-2026"` |
| `Your credit balance is too low to access the Anthropic API` | The key works, but the account has no credit. Add credits in the Claude Console under **Plans & Billing**. Waiting draft jobs retry by themselves every hour for a day. For older ones, use **Admin → Activity → Retry**. |
| `running scripts is disabled on this system` | `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`, or use `npm.cmd`. |
| `password authentication failed for user "openrings"` | Wrong `DB_PASSWORD`. Put it in double quotes in `.env`. To set a new one, run `ALTER ROLE openrings WITH PASSWORD 'new-password';` in pgAdmin as `postgres`. |
| `database "openrings_community" does not exist` | Run step 3.2 again. Check `DB_NAME` spelling. |
| `connect ECONNREFUSED 127.0.0.1:5432` | PostgreSQL isn't running, or the port is different. Press Win+R, run `services.msc`, find **postgresql-x64-NN** and click **Start**. Check `DB_PORT` (step 3.3). |
| `permission denied for schema public` | The database isn't owned by `openrings`. In pgAdmin as `postgres`: `ALTER DATABASE openrings_community OWNER TO openrings;` Then open a Query Tool **on openrings_community** and run `ALTER SCHEMA public OWNER TO openrings;` |
| `encoding "UTF8" does not match locale` or `incompatible with the encoding of the template database` | Make sure the `CREATE DATABASE` line includes `TEMPLATE template0`. |
| `EADDRINUSE :::3000` | Another program uses port 3000. Set `PORT=3001` and `SITE_URL=http://localhost:3001` in `.env`. |
| Login does nothing / logs you straight out | Remove `NODE_ENV=production` from `.env` on your PC. Production mode needs https. |
| Windows Firewall pop-up | Only appears with `HOST=0.0.0.0`. Allow **Private networks** to test from phones on your Wi-Fi. |
| `Missing script: "ai:setup"`, or the admin pages look like an older version | The new files were extracted into a subfolder, not over the forum folder. See **Updating to a new version** above. |
| "The Open Rings AI engine is not running" | Run `npm run ai:setup` in the forum folder (first time), or restart the PC so the engine starts again. Answers that were waiting are written once it runs. |
| No drafts appear in the Support inbox | **Admin → Activity** shows the error. Run `node scripts/doctor.js`. Check **Admin → Answer settings → Write an answer for every new thread** is ticked. Questions posted by staff accounts never get drafts. Use a member account to test. |
| Inbox says "Nothing assigned to you" | The draft went to another engineer. Click **All drafts**. Tick **On duty** only for the engineers who should get drafts. |
| `401 invalid x-api-key` | The key is wrong, expired or disabled. Create a new one (step 4), and paste it in Admin → AI provider. |
| "Nothing assigned to you" in the Support inbox | The inbox now opens on **All drafts**. "Assigned to me" lists only drafts given to you; tick **On duty** for yourself in Admin → Users & staff to receive some. |
| Daily questions didn't appear today | The top of **Admin → Daily posts** says why: off, no AI provider, an error (with **Try again now**), or simply not due yet. They are spread between 09:00 and 21:00, and only publish while `npm start` is running. |
| Asked a question as admin, but no draft | Questions from staff accounts never get drafts automatically. Ask from a member account, or use **Staff tools → Generate draft reply** on the thread. |
| AI provider says "The saved key cannot be read" | The `data\secret.key` file that encrypts saved keys was deleted or replaced. Paste the key again and Save. |

---

## Optional: run the automated tests

The tests run in a temporary schema inside `openrings_community` and remove it afterwards, so your forum data is not touched. In the connection string, write `#` in the password as `%23`:

```
set TEST_DATABASE_URL=postgres://openrings:YOUR_PASSWORD@localhost:5432/openrings_community
npm test
```

(In PowerShell, the first line is `$env:TEST_DATABASE_URL = "postgres://..."`.)

You should see `# pass 10` and `# fail 0`.

---

## Later: moving to openrings.org

When local testing is done:

1. On the server: install Node.js 22+ and create the database exactly as in step 3. This can be on the same PostgreSQL server as your PBX database, but keep it a separate database.
2. Copy the `community` folder (without `node_modules`), then run `npm ci --omit=dev`.
3. In the server's `.env`:

   ```ini
   NODE_ENV=production
   SITE_URL=https://openrings.org
   BASE_PATH=/community
   HOST=127.0.0.1
   TRUST_PROXY=loopback
   ```

   Then enter a separate production API key in **Admin → AI provider** on the server.

4. Add the nginx block from `deploy/nginx-community.conf`, and run the forum as a service with `deploy/openrings-community.service` (or Docker).
5. **Start with a fresh database** so your test posts don't go live. To keep your local data instead (forums, settings, knowledge base, accounts):

   ```
   pg_dump -U openrings -h localhost -Fc openrings_community -f community.dump
   ```

   Then on the server: `pg_restore -U openrings -d openrings_community community.dump`

6. Add `Sitemap: https://openrings.org/community/sitemap.xml` to openrings.org's `robots.txt` and submit the sitemap in Google Search Console.
