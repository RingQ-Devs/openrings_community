import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setup } from './helpers.js';
import { startFakeOpenAI } from './fake-openai.js';

// What happens when the Open Rings AI engine stops and starts again, when daily posts are overdue
// because the forum was not running, and when answers failed on a wrong setting that is fixed later.
let t;
let admin;
before(async () => {
  t = await setup({ env: { AI_PROVIDER: '' } });
  admin = t.client();
  await admin.login('admin', 'admin-password-1');
});
after(async () => {
  await t?.close();
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const forumId = async (slug) => (await t.db.one('SELECT id FROM forums WHERE slug = $1', slug)).id;
const roles = async (threadId) =>
  (await t.db.all('SELECT u.role FROM posts p JOIN users u ON u.id = p.user_id WHERE p.thread_id = $1 ORDER BY p.id', threadId)).map((r) => r.role);

test('engine stopped: answers wait, retry every 2 minutes, admins see it, and they post once it runs again', async () => {
  const port = await freePort();
  const engineUrl = `http://127.0.0.1:${port}/v1`;
  await admin.post('/admin/ai', { action: 'save', provider: 'local', local_base_url: engineUrl, local_model: '' });
  await admin.post('/admin/settings', { reply_mode: 'auto', ai_autoreply_enabled: '1', ai_followups_enabled: '1', seed_enabled: '1', ai_reply_delay_seconds: '0', support_team_name: 'RingQ Support' });

  const member = t.client();
  await member.register('gita_member');
  await member.post('/post-thread', { forum_id: await forumId('troubleshooting'), title: 'Phones lose registration at night', body: 'Every night around 2 am all phones unregister.' });
  const thread = await t.db.one('SELECT * FROM threads ORDER BY id DESC LIMIT 1');

  // Engine not running: the job fails fast with a clear reason and is retried in about 2 minutes.
  await t.db.run(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'queued'`);
  await t.worker.runDueJobs(5);
  const job = await t.db.one(`SELECT * FROM jobs WHERE type = 'ai_reply' ORDER BY id DESC LIMIT 1`);
  assert.equal(job.status, 'queued');
  assert.match(job.last_error, /^The Open Rings AI engine is not running at .*ECONNREFUSED/);
  const retryInSeconds = (Date.parse(job.run_at) - Date.parse(job.updated_at)) / 1000;
  assert.ok(retryInSeconds > 100 && retryInSeconds <= 121, `retried after ${retryInSeconds} s`);
  assert.deepEqual(await roles(thread.id), ['member']);

  // Every admin page says so, with a button to check again.
  for (const page of ['/admin', '/admin/ai', '/admin/jobs']) {
    const html = (await admin.get(page)).text;
    assert.match(html, /The Open Rings AI engine is not answering/, page);
    assert.match(html, /1 answer and follow-up are waiting/, page);
  }
  // Checking while it is still down explains what to do.
  await admin.post('/admin/ai/engine-check', {});
  assert.match((await admin.get('/admin/ai')).text, /not running|not installed|starting/i);

  // The engine starts again: one click writes the waiting answer now.
  const engine = await startFakeOpenAI({ port });
  try {
    await admin.post('/admin/ai/engine-check', {});
    assert.match((await admin.get('/admin/ai')).text, /The Open Rings AI engine is running\. 1 waiting answer is being written now/);
    await t.worker.runDueJobs(5);
    assert.deepEqual(await roles(thread.id), ['member', 'ai']);
    assert.doesNotMatch((await admin.get('/admin')).text, /The Open Rings AI engine is not answering/, 'the warning is gone');
  } finally {
    await engine.close();
  }
});

test('answers that failed on a wrong setting are tried again when the AI provider is saved', async () => {
  const engine = await startFakeOpenAI();
  try {
    await admin.post('/admin/ai', { action: 'save', provider: 'local', local_base_url: engine.url, local_model: 'openring-ai' });
    engine.state.models = ['openrings-ai:latest'];
    const member = t.client();
    await member.register('omar_typo');
    await member.post('/post-thread', { forum_id: await forumId('troubleshooting'), title: 'Voicemail emails never arrive', body: 'Voicemail works but no email.' });
    const thread = await t.db.one('SELECT * FROM threads ORDER BY id DESC LIMIT 1');
    // Simulate the earlier permanent failure (the model name had a typo).
    await t.db.run(`UPDATE jobs SET status = 'failed', attempts = 1, last_error = '404 model ''openring-ai'' not found' WHERE type = 'ai_reply' AND status = 'queued'`);
    assert.deepEqual(await roles(thread.id), ['member']);

    await admin.post('/admin/ai', { action: 'save', provider: 'local', local_base_url: engine.url, local_model: '' });
    assert.match((await admin.get('/admin/ai')).text, /1 answer that failed earlier is being tried again/);
    await t.worker.runDueJobs(5);
    assert.deepEqual(await roles(thread.id), ['member', 'ai']);
  } finally {
    await engine.close();
  }
});

test('daily posts overdue because the forum was stopped are spread over the posting window, not posted at once', async () => {
  const { localDate, zonedTime } = await import('../src/lib/format.js');
  const { config } = await import('../src/config.js');
  const persona = await t.db.val("SELECT id FROM users WHERE role = 'persona' LIMIT 1");
  const fid = await forumId('troubleshooting');
  const insert = (title, ago) =>
    t.db.run(
      `INSERT INTO scheduled_posts (plan_date, forum_id, persona_id, title, body, status, publish_at)
       VALUES ('2026-11-20', $1, $2, $3, 'Body text for the overdue question.', 'approved', now() - $4::interval)`,
      fid, persona, title, ago,
    );
  for (let i = 1; i <= 5; i++) await insert(`Overdue question number ${i} from yesterday`, `${8 + i} hours`);
  await insert('Just missed by five minutes', '5 minutes');

  const now = new Date();
  const result = await t.seeder.schedulerTick(now);
  assert.equal(result.published, 1, 'only the one missed by a few minutes is published now');
  assert.equal(result.rescheduled, 5);

  const rows = await t.db.all(`SELECT publish_at FROM scheduled_posts WHERE status = 'approved' AND title LIKE 'Overdue question%'`);
  assert.equal(rows.length, 5);
  const startHour = Number(await t.settings.getSetting('seed_window_start_hour'));
  const endHour = Number(await t.settings.getSetting('seed_window_end_hour'));
  for (const r of rows) {
    const at = new Date(r.publish_at);
    assert.ok(at > now, 'in the future');
    const day = localDate(config.timezone, at);
    assert.ok(at >= zonedTime(day, startHour) && at <= zonedTime(day, endHour), `${r.publish_at} is inside the posting window`);
  }
  assert.ok(new Set(rows.map((r) => r.publish_at)).size === 5, 'each gets its own time');
});

test('engine running again: answers waiting on a long retry timer are written right away', async () => {
  const port = await freePort();
  await admin.post('/admin/ai', { action: 'save', provider: 'local', local_base_url: `http://127.0.0.1:${port}/v1`, local_model: '' });
  const member = t.client();
  await member.register('ines_waiting');
  await member.post('/post-thread', { forum_id: await forumId('troubleshooting'), title: 'Transfer drops the call', body: 'Attended transfer drops both legs.' });
  const thread = await t.db.one('SELECT * FROM threads ORDER BY id DESC LIMIT 1');
  // An answer that failed earlier and is not due again for an hour.
  await t.db.run(
    `UPDATE jobs SET attempts = 6, run_at = now() + interval '1 hour', last_error = 'The Open Rings AI engine is not running at x (ECONNREFUSED).'
     WHERE type = 'ai_reply' AND status = 'queued' AND payload->>'threadId' = $1`,
    String(thread.id),
  );
  assert.equal(await t.worker.probeEngine({ force: true }), 0, 'engine still down: nothing to do');
  const engine = await startFakeOpenAI({ port });
  try {
    assert.equal(await t.worker.probeEngine({ force: true }), 1, 'engine back: the waiting answer is due now');
    await t.worker.runDueJobs(5);
    assert.deepEqual(await roles(thread.id), ['member', 'ai']);
  } finally {
    await engine.close();
  }
});
