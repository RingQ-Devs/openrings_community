import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

// End-to-end scenarios for automatic answers, in "Automatic, in real time" mode:
//   1. a member's question: one answer per member message, up to "Max support answers per thread";
//   2. a daily discussion: the sample member's follow-ups and the answers to them, up to the
//      configured number, each after the configured random delay.
let t;
before(async () => {
  t = await setup();
});
after(async () => {
  await t?.close();
});

const forumId = async (slug) => (await t.db.one('SELECT id FROM forums WHERE slug = $1', slug)).id;
const roles = async (threadId) =>
  (await t.db.all('SELECT u.role FROM posts p JOIN users u ON u.id = p.user_id WHERE p.thread_id = $1 AND p.deleted_at IS NULL ORDER BY p.id', threadId)).map((r) => r.role);
const lastThread = () => t.db.one('SELECT * FROM threads ORDER BY id DESC LIMIT 1');

/** Runs the jobs that are queued now (as if their time had come) and returns their delays in minutes. */
async function step() {
  const queued = await t.db.all(
    `SELECT type, EXTRACT(EPOCH FROM run_at - created_at) / 60 AS minutes FROM jobs WHERE status = 'queued' ORDER BY id`,
  );
  await t.db.run(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'queued'`);
  await t.worker.runDueJobs(20);
  return queued.map((j) => ({ type: j.type, minutes: Number(j.minutes) }));
}

async function saveSettings(admin, extra = {}) {
  const r = await admin.post('/admin/settings', {
    reply_mode: 'auto', support_team_name: 'RingQ Support',
    ai_autoreply_enabled: '1', ai_followups_enabled: '1', ai_stop_when_staff_replies: '1',
    ai_reply_delay_seconds: '0', ai_reply_delay_max_seconds: '0', ai_max_replies_per_thread: '4',
    seed_enabled: '1', seed_posts_per_day: '3', seed_window_start_hour: '9', seed_window_end_hour: '21',
    seed_answer_delay_min_minutes: '10', seed_answer_delay_max_minutes: '90',
    seed_followups_min: '3', seed_followups_max: '3',
    seed_followup_delay_min_minutes: '30', seed_followup_delay_max_minutes: '240',
    ...extra,
  });
  assert.equal(r.status, 302);
}

let admin;

test('member question: one automatic answer per member message, up to the maximum per thread', async () => {
  admin = t.client();
  await admin.login('admin', 'admin-password-1');
  await saveSettings(admin);

  const member = t.client();
  await member.register('nadia_member');
  await member.post('/post-thread', { forum_id: await forumId('troubleshooting'), title: 'Calls drop after 30 seconds', body: 'Every outbound call drops after exactly 30 seconds.' });
  const thread = await lastThread();
  await step();
  assert.deepEqual(await roles(thread.id), ['member', 'ai'], 'the question gets one answer');

  // Time passes without the member writing back: no further answers (nothing new to answer).
  for (let i = 0; i < 3; i++) await step();
  assert.deepEqual(await roles(thread.id), ['member', 'ai']);

  const reply = async (body) => {
    await member.post(`/threads/${thread.id}/reply`, { body });
    await step();
  };
  await reply('I checked the trunk, it registers fine. Still drops at 30 seconds.');
  assert.deepEqual(await roles(thread.id), ['member', 'ai', 'member', 'ai'], 'a follow-up gets an answer');
  await reply('Thanks, checking that now.');
  assert.equal((await roles(thread.id)).filter((r) => r === 'ai').length, 2, 'a thank-you gets no answer');
  await reply('The SIP log shows a BYE from the carrier after the ACK timeout.');
  await reply('Changed the external IP setting, now it drops after 32 seconds instead.');
  assert.equal((await roles(thread.id)).filter((r) => r === 'ai').length, 4, 'four answers in total');
  await reply('Any other idea? Still dropping.');
  assert.equal((await roles(thread.id)).filter((r) => r === 'ai').length, 4, 'the maximum of 4 answers is respected');
});

test('daily discussion: follow-ups and answers up to the configured number, at random gaps', async () => {
  await saveSettings(admin, { seed_followups_min: '3', seed_followups_max: '3' });
  const { enqueueJob } = await import('../src/services/jobs.js');
  await enqueueJob('seed_generate', { count: 1 });
  await step();
  await t.db.run(`UPDATE scheduled_posts SET publish_at = now() - interval '1 second' WHERE status = 'approved'`);
  assert.equal((await t.seeder.schedulerTick()).published, 1);
  const thread = await lastThread();
  assert.equal(thread.is_seeded, 1);

  const delays = [];
  for (let i = 0; i < 12; i++) delays.push(...(await step()));
  assert.deepEqual(await roles(thread.id), ['persona', 'ai', 'persona', 'ai', 'persona', 'ai', 'persona', 'ai'], '3 follow-ups, 4 answers');
  assert.equal(await t.db.val(`SELECT COUNT(*) FROM jobs WHERE status = 'queued'`), 0, 'nothing more is planned');

  const answerDelays = delays.filter((d) => d.type === 'ai_reply').map((d) => d.minutes);
  const followupDelays = delays.filter((d) => d.type === 'seed_followup').map((d) => d.minutes);
  assert.equal(answerDelays.length, 4);
  assert.equal(followupDelays.length, 3);
  for (const m of answerDelays) assert.ok(m >= 9.9 && m <= 90.1, `answer delay ${m} min is within 10–90`);
  for (const m of followupDelays) assert.ok(m >= 29.9 && m <= 240.1, `follow-up delay ${m} min is within 30–240`);
});

test('daily discussion: follow-ups stop when the thread reaches the answer limit', async () => {
  await saveSettings(admin, { seed_followups_min: '5', seed_followups_max: '5', ai_max_replies_per_thread: '3' });
  const { enqueueJob } = await import('../src/services/jobs.js');
  await enqueueJob('seed_generate', { count: 1 });
  await step();
  await t.db.run(`UPDATE scheduled_posts SET publish_at = now() - interval '1 second' WHERE status = 'approved'`);
  await t.seeder.schedulerTick();
  const thread = await lastThread();
  for (let i = 0; i < 12; i++) await step();
  assert.deepEqual(await roles(thread.id), ['persona', 'ai', 'persona', 'ai', 'persona', 'ai'], 'no follow-up that would go unanswered');
});

test('daily discussion: the number of follow-ups varies between the min and max', async () => {
  await saveSettings(admin, { seed_followups_min: '0', seed_followups_max: '2', seed_posts_per_day: '6' });
  const { enqueueJob } = await import('../src/services/jobs.js');
  await enqueueJob('seed_generate', { count: 6 });
  await step();
  await t.db.run(`UPDATE scheduled_posts SET publish_at = now() - interval '1 second' WHERE status = 'approved'`);
  await t.seeder.schedulerTick();
  for (let i = 0; i < 12; i++) await step();
  const threads = await t.db.all(`SELECT id FROM threads WHERE is_seeded = 1 ORDER BY id DESC LIMIT 6`);
  const counts = [];
  for (const th of threads) {
    const r = await roles(th.id);
    const followups = r.filter((x) => x === 'persona').length - 1;
    assert.ok(followups >= 0 && followups <= 2, `follow-ups ${followups} within 0–2`);
    assert.equal(r.filter((x) => x === 'ai').length, followups + 1, 'every follow-up is answered');
    counts.push(followups);
  }
  assert.ok(new Set(counts).size > 1, `the counts differ between threads: ${counts}`);
});

test('the admin page shows the daily follow-up settings', async () => {
  const page = (await admin.get('/admin/settings')).text;
  assert.match(page, /name="seed_followups_min"/);
  assert.match(page, /name="seed_followups_max"/);
  assert.match(page, /name="seed_followup_delay_min_minutes"/);
  assert.doesNotMatch(page, /name="seed_followup_rate"/);
});
