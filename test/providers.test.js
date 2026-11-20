import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { startFakeOpenAI } from './fake-openai.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Self-hosted "Open Rings AI", the AI provider page, the review-with-fallback mode and daily status.
let t;
let fake;
before(async () => {
  fake = await startFakeOpenAI();
  t = await setup({ env: { AI_PROVIDER: '' } });
});
after(async () => {
  await t?.close();
  await fake?.close();
});

const forumId = async (slug) => (await t.db.one('SELECT id FROM forums WHERE slug = $1', slug)).id;
const lastThread = () => t.db.one('SELECT * FROM threads ORDER BY id DESC LIMIT 1');
let admin;
let member;

test('AI provider page: dropdown choice is saved and stays after reload', async () => {
  admin = t.client();
  await admin.login('admin', 'admin-password-1');
  let page = (await admin.get('/admin/ai')).text;
  assert.match(page, /<select name="provider" data-provider-select>/);
  assert.match(page, /value="none" selected/);

  await admin.post('/admin/ai', { action: 'save', provider: 'local', local_base_url: fake.url, local_model: 'openrings-ai' });
  page = (await admin.get('/admin/ai')).text;
  assert.match(page, /value="local" selected/);
  assert.match(page, /Open Rings AI \(self-hosted\) · openrings-ai/);
  assert.doesNotMatch(page, /data-provider-section="local" hidden/, 'the selected provider settings are visible');
  assert.match(page, /data-provider-section="anthropic" hidden/, 'other providers are hidden');
});

test('connection test results are kept after the redirect', async () => {
  await admin.post('/admin/ai', { action: 'test', provider: 'local', local_base_url: fake.url, local_model: 'openrings-ai' });
  let page = (await admin.get('/admin/ai')).text;
  assert.match(page, /has the model &#34;openrings-ai&#34;|has the model "openrings-ai"/);
  assert.match(page, /Test call succeeded in/);

  await admin.post('/admin/ai', { action: 'test', provider: 'local', local_base_url: fake.url, local_model: 'no-such-model' });
  page = (await admin.get('/admin/ai')).text;
  assert.match(page, /has no model called/);
  await admin.post('/admin/ai', { action: 'save', provider: 'local', local_base_url: fake.url, local_model: 'openrings-ai' });
});

test('Open Rings AI (self-hosted) writes drafts, even when the server lacks strict JSON support', async () => {
  member = t.client();
  await member.register('sara_member');
  await member.post('/post-thread', { forum_id: await forumId('call-routing-ivr'), title: 'How to set IVR with office hours', body: 'How to set IVR?' });
  const thread = await lastThread();
  await t.runJobsNow();
  let draft = await t.db.one(`SELECT * FROM reply_drafts WHERE thread_id = $1 AND status = 'pending'`, thread.id);
  assert.match(draft.body, /Self-hosted answer/);
  const req = fake.state.requests.filter((r) => r.url === '/v1/chat/completions').at(-1);
  assert.equal(req.body.model, 'openrings-ai');
  assert.equal(req.body.response_format.type, 'json_schema');
  assert.equal(req.headers.authorization, 'Bearer not-needed');

  // A server that rejects json_schema: falls back to plain JSON mode
  fake.state.chatMode = 'reject_json_schema';
  await member.post(`/threads/${thread.id}/reply`, { body: 'And for public holidays?' });
  await t.runJobsNow();
  const tries = fake.state.requests.filter((r) => r.url === '/v1/chat/completions').slice(-2).map((r) => r.body.response_format?.type);
  assert.deepEqual(tries, ['json_schema', 'json_object']);
  draft = await t.db.one(`SELECT * FROM reply_drafts WHERE thread_id = $1 AND status = 'pending'`, thread.id);
  assert.match(draft.body, /Self-hosted answer/);
  fake.state.chatMode = 'ok';
});

test('review with fallback: an unreviewed draft is posted automatically, labelled Automated', async () => {
  await t.settings.setSetting('reply_mode', 'review_fallback');
  await t.settings.setSetting('review_fallback_minutes', '30');
  await member.post('/post-thread', { forum_id: await forumId('call-routing-ivr'), title: 'Queue callback when all agents busy', body: 'Is there a callback option?' });
  const thread = await lastThread();
  await t.db.run(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'queued' AND type = 'ai_reply'`);
  await t.worker.runDueJobs(5);
  const fallback = await t.db.one(`SELECT * FROM jobs WHERE type = 'draft_fallback' ORDER BY id DESC LIMIT 1`);
  assert.ok(Date.parse(fallback.run_at) > Date.now() + 25 * 60_000, 'waits for the review time');

  await t.runJobsNow(); // time passes, nobody reviewed
  const posts = await t.db.all('SELECT p.*, u.role FROM posts p JOIN users u ON u.id = p.user_id WHERE thread_id = $1 ORDER BY p.id', thread.id);
  assert.equal(posts.at(-1).role, 'ai');
  assert.equal(await t.db.val(`SELECT status FROM reply_drafts WHERE thread_id = $1 ORDER BY id DESC LIMIT 1`, thread.id), 'posted');
  const html = (await member.get(`/threads/${thread.slug}.${thread.id}/`)).text;
  assert.match(html, /badge--bot">Automated</);

  // If an engineer posts the draft first, the fallback does nothing
  await member.post('/post-thread', { forum_id: await forumId('call-routing-ivr'), title: 'Music on hold for a queue', body: 'Can I upload my own?' });
  const t2 = await lastThread();
  await t.db.run(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'queued' AND type = 'ai_reply'`);
  await t.worker.runDueJobs(5);
  const d2 = await t.db.one(`SELECT * FROM reply_drafts WHERE thread_id = $1 AND status = 'pending'`, t2.id);
  const adminId = await t.db.val("SELECT id FROM users WHERE username = 'admin'");
  await admin.post(`/support/drafts/${d2.id}`, { action: 'post', post_as: String(adminId), body: d2.body });
  await t.runJobsNow();
  const roles = (await t.db.all('SELECT u.role FROM posts p JOIN users u ON u.id = p.user_id WHERE thread_id = $1 ORDER BY p.id', t2.id)).map((r) => r.role);
  assert.deepEqual(roles, ['member', 'admin'], 'no automated post after an engineer answered');
  await t.settings.setSetting('reply_mode', 'review');
});

test('replies wait a random time between the min and max delay', async () => {
  await t.settings.setSetting('ai_reply_delay_seconds', '600');
  await t.settings.setSetting('ai_reply_delay_max_seconds', '1200');
  await member.post('/post-thread', { forum_id: await forumId('troubleshooting'), title: 'Phones reboot every night', body: 'Why?' });
  const job = await t.db.one(`SELECT * FROM jobs WHERE type = 'ai_reply' ORDER BY id DESC LIMIT 1`);
  const wait = (Date.parse(job.run_at) - Date.now()) / 1000;
  assert.ok(wait > 590 && wait < 1210, `waited ${wait}s`);
  await t.settings.setSetting('ai_reply_delay_seconds', '20');
  await t.settings.setSetting('ai_reply_delay_max_seconds', '');
});

test("daily posts page explains today's status", async () => {
  await t.settings.setSetting('seed_enabled', '1');
  await t.settings.setSetting('seed_last_plan_date', '');
  let page = (await admin.get('/admin/queue')).text;
  assert.match(page, /Today&#39;s daily posts|Today's daily posts/);
  await t.seeder.schedulerTick();
  await t.runJobsNow();
  page = (await admin.get('/admin/queue')).text;
  assert.match(page, /planned today: 0 published, \d waiting for their time/);
  await admin.post('/admin/ai', { action: 'save', provider: 'none' });
  page = (await admin.get('/admin/queue')).text;
  assert.match(page, /No AI provider is set up/);
});

test('live thread updates: the reply shows up without reloading, with a "being prepared" notice', async () => {
  await admin.post('/admin/ai', { action: 'save', provider: 'mock' });
  await admin.post('/admin/settings', { reply_mode: 'auto', ai_autoreply_enabled: '1', ai_followups_enabled: '1', seed_enabled: '1', ai_reply_delay_seconds: '0', support_team_name: 'RingQ Support' });
  const r = await member.post('/post-thread', { forum_id: await forumId('softphones-webrtc'), title: 'How to download the softphone', body: 'Where do I get it?' });
  assert.match((await member.get(r.location)).text, /A reply will appear below in a moment/);
  const thread = await lastThread();
  const page = (await member.get(r.location)).text;
  const lastPost = Number(/data-last-post="(\d+)"/.exec(page)[1]);
  assert.match(page, new RegExp(`data-thread-id="${thread.id}"`));

  let live = await member.get(`/threads/${thread.id}/live?after=${lastPost}`);
  let data = JSON.parse(live.text);
  assert.equal(data.posts.length, 0);
  assert.equal(data.pending, true, 'shows "a reply is being prepared"');

  await t.runJobsNow();
  data = JSON.parse((await member.get(`/threads/${thread.id}/live?after=${lastPost}`)).text);
  assert.equal(data.pending, false);
  assert.equal(data.posts.length, 1);
  assert.match(data.posts[0].html, /id="post-\d+"/);
  assert.match(data.posts[0].html, /badge--bot">Automated</);
  assert.match(data.posts[0].html, /#2</, 'numbered as the second post');
  assert.equal((await t.client().get(`/threads/999999/live?after=0`)).status, 404);
});

test('switching to automatic posts the drafts already waiting in the inbox', async () => {
  await admin.post('/admin/settings', { reply_mode: 'review', ai_autoreply_enabled: '1', ai_followups_enabled: '1', seed_enabled: '1', ai_reply_delay_seconds: '0', support_team_name: 'RingQ Support' });
  // A second member: the first one has reached the "5 new threads per 10 minutes" limit.
  const member2 = t.client();
  await member2.register('omar_member');
  await member2.post('/post-thread', { forum_id: await forumId('softphones-webrtc'), title: 'Browser dialer has no audio', body: 'Microphone allowed, still silent.' });
  const thread = await lastThread();
  await t.runJobsNow();
  assert.equal(await t.db.val(`SELECT COUNT(*) FROM reply_drafts WHERE thread_id = $1 AND status = 'pending'`, thread.id), 1);

  await admin.post('/admin/settings', { reply_mode: 'auto', ai_autoreply_enabled: '1', ai_followups_enabled: '1', seed_enabled: '1', ai_reply_delay_seconds: '0', support_team_name: 'RingQ Support' });
  assert.match((await admin.get('/admin/settings')).text, /waiting in the Support inbox will now be posted automatically/);
  await t.runJobsNow();
  const roles = (await t.db.all('SELECT u.role FROM posts p JOIN users u ON u.id = p.user_id WHERE thread_id = $1 ORDER BY p.id', thread.id)).map((x) => x.role);
  assert.deepEqual(roles, ['member', 'ai']);
  assert.equal(await t.db.val(`SELECT COUNT(*) FROM reply_drafts WHERE status = 'pending'`), 0);
});

test('daily questions waiting for approval can be approved in one click', async () => {
  const persona = await t.db.val("SELECT id FROM users WHERE role = 'persona' LIMIT 1");
  const fid = await forumId('troubleshooting');
  for (const title of ['Pending question one about trunks', 'Pending question two about phones']) {
    await t.db.run(
      `INSERT INTO scheduled_posts (plan_date, forum_id, persona_id, title, body, status, publish_at) VALUES ('2026-11-20', $1, $2, $3, 'Body text for the pending question.', 'pending', now() - interval '1 minute')`,
      fid, persona, title,
    );
  }
  assert.match((await admin.get('/admin/queue')).text, /Approve all 2 waiting questions/);
  await admin.post('/admin/queue/approve-all', {});
  assert.equal(await t.db.val(`SELECT COUNT(*) FROM scheduled_posts WHERE status = 'pending'`), 0);
  assert.equal((await t.seeder.schedulerTick()).published, 2, 'overdue ones publish right away');
});

test('Open Rings AI: clear messages when the engine is not running or the model name is wrong', async () => {
  await admin.post('/admin/ai', { action: 'test', provider: 'local', local_base_url: 'http://127.0.0.1:9/v1', local_model: '' });
  let page = (await admin.get('/admin/ai')).text;
  assert.match(page, /The Open Rings AI engine is not running at http:\/\/127\.0\.0\.1:9\/v1/);
  assert.match(page, /npm run ai:setup/);
  assert.doesNotMatch(page, /ollama/i, 'no third-party engine name in the admin panel');

  await admin.post('/admin/ai', { action: 'test', provider: 'local', local_base_url: fake.url, local_model: 'openring-ai' });
  page = (await admin.get('/admin/ai')).text;
  assert.match(page, /no model called &#34;openring-ai&#34;|no model called "openring-ai"/);
  assert.match(page, /Did you mean &#34;openrings-ai&#34;|Did you mean "openrings-ai"/);

  // A queued answer whose engine is offline keeps retrying (so it is written once the engine starts).
  const { retryPolicy, EngineOfflineError } = await import('../src/ai/client.js');
  assert.equal(retryPolicy(new EngineOfflineError('offline')).maxAttempts, 26);
});

test('Open Rings AI setup: downloads the model, creates openrings-ai, tests it and selects it', async () => {
  const engine = await import('../src/ai/engine.js');
  assert.equal(engine.engineRoot('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434');
  assert.equal(await engine.engineVersion('http://127.0.0.1:9'), null);
  const root = fake.url.replace(/\/v1$/, '');
  assert.equal(await engine.engineVersion(root), '0.12.0');

  // The setup script itself, against the stand-in engine (nothing is installed when one is running).
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, ['scripts/setup-openrings-ai.js', '--url', root, '--base', 'llama3.2:3b', '--no-activate'], { cwd: process.cwd() });
  assert.match(stdout, /engine 0\.12\.0 is running/);
  assert.match(stdout, /downloaded/);
  assert.match(stdout, /"openrings-ai" is ready \(built on llama3\.2:3b\)/);
  assert.match(stdout, /answered in/);
  assert.match(stdout, /Skipped \(--no-activate\)/);
  assert.doesNotMatch(stdout, /ollama/i);
  assert.equal(fake.state.created.from, 'llama3.2:3b');
  assert.equal(fake.state.created.parameters.num_ctx, 16384);

  const progress = [];
  await engine.downloadModel(root, 'gemma3:4b', (p) => progress.push(p));
  assert.deepEqual(progress.at(-1), { status: 'success', done: 5000, total: 5000 });

  // Selecting it in the forum, as the script's last step does.
  await engine.useOpenRingsAi(`${root}/v1`);
  const { clearSettingsCache } = await import('../src/services/settings.js');
  clearSettingsCache();
  const page = (await admin.get('/admin/ai')).text;
  assert.match(page, /value="local" selected/);
  assert.match(page, /Open Rings AI \(self-hosted\) · openrings-ai/);
});
