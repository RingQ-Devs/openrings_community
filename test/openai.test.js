import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { startFakeOpenAI } from './fake-openai.js';

let t;
let fake;
before(async () => {
  fake = await startFakeOpenAI();
  t = await setup({
    env: { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-fake', OPENAI_BASE_URL: fake.url, OPENAI_REASONING_EFFORT: 'low' },
  });
});
after(async () => {
  await t?.close();
  await fake?.close();
});

const forumId = async (slug) => (await t.db.one('SELECT id FROM forums WHERE slug = $1', slug)).id;
const lastJob = () => t.db.one('SELECT * FROM jobs ORDER BY id DESC LIMIT 1');

test('drafts are written with OpenAI and land in the Support inbox', async () => {
  const member = t.client();
  await member.register('olivia_member');
  await member.post('/post-thread', { forum_id: await forumId('network-nat-security'), title: 'Which ports to open on the VPS firewall', body: 'Remote phones get one-way audio.' });
  const thread = await t.db.one('SELECT * FROM threads ORDER BY id DESC LIMIT 1');
  await t.runJobsNow();

  const draft = await t.db.one(`SELECT * FROM reply_drafts WHERE thread_id = $1 AND status = 'pending'`, thread.id);
  assert.ok(draft, 'draft created');
  assert.match(draft.body, /16384-32768\/udp/);
  assert.equal(draft.model, 'gpt-5.5');

  const req = fake.state.requests.at(-1);
  assert.equal(req.url, '/v1/responses');
  assert.equal(req.headers.authorization, 'Bearer sk-test-fake');
  assert.equal(req.body.model, 'gpt-5.5');
  assert.equal(req.body.store, false);
  assert.equal(req.body.max_output_tokens, 16000);
  assert.deepEqual(req.body.reasoning, { effort: 'low' });
  assert.equal(req.body.text.format.type, 'json_schema');
  assert.equal(req.body.text.format.strict, true);
  assert.deepEqual(req.body.text.format.schema.required.sort(), ['reply_markdown', 'should_reply']);
  assert.match(req.body.instructions, /<knowledge_base>/);
  assert.match(req.body.input, /<thread>[\s\S]*one-way audio/);

  const job = await lastJob();
  assert.equal(job.status, 'done');
  assert.equal(job.result.usage.cache_read_input_tokens, 900);
});

test('daily questions are generated with OpenAI', async () => {
  await t.settings.setSetting('seed_last_plan_date', '');
  await t.settings.setSetting('seed_posts_per_day', '2');
  await t.seeder.schedulerTick();
  await t.runJobsNow();
  const planned = await t.db.all(`SELECT title FROM scheduled_posts ORDER BY id`);
  assert.equal(planned.length, 2);
  assert.match(planned[0].title, /Fake OpenAI question number 1/);
});

test('an OpenAI quota error is retried later, a refusal is not', async () => {
  const member = t.client();
  await member.register('quentin_member');
  fake.state.mode = 'quota';
  await member.post('/post-thread', { forum_id: await forumId('troubleshooting'), title: 'Calls drop after thirty seconds', body: 'Every call drops.' });
  await t.db.run(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'queued'`);
  await t.worker.runDueJobs(5);
  let job = await lastJob();
  assert.equal(job.status, 'queued', 'quota errors keep the job queued');
  assert.match(job.last_error, /quota/);

  fake.state.mode = 'refusal';
  await t.db.run(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'queued'`);
  await t.worker.runDueJobs(5);
  job = await t.db.one('SELECT * FROM jobs WHERE id = $1', job.id);
  assert.equal(job.status, 'failed', 'a refusal fails without retrying');
  assert.match(job.last_error, /declined/);
  fake.state.mode = 'ok';
});

test('the AI provider and key can be set in the admin panel (stored encrypted)', async () => {
  const admin = t.client();
  await admin.login('admin', 'admin-password-1');
  const page = await admin.get('/admin/ai');
  assert.equal(page.status, 200);
  assert.match(page.text, /Using the key from \.env/);

  await admin.post('/admin/ai', { action: 'save', provider: 'openai', openai_api_key: 'sk-from-admin-panel-1234', openai_model: 'gpt-5.4-mini', openai_reasoning_effort: 'default' });
  const stored = await t.db.val("SELECT value FROM settings WHERE key = 'openai_api_key_enc'");
  assert.match(stored, /^v1:/);
  assert.doesNotMatch(stored, /sk-from-admin-panel/, 'key is encrypted in the database');
  const after = await admin.get('/admin/ai');
  assert.doesNotMatch(after.text, /sk-from-admin-panel-1234/, 'full key is never shown again');
  assert.match(after.text, /Saved key: sk-from…1234/);

  // The next draft uses the key and model from the admin panel
  const member = t.client();
  await member.register('petra_member');
  await member.post('/post-thread', { forum_id: await forumId('getting-started'), title: 'Minimum server size for 20 extensions', body: 'What do I need?' });
  await t.runJobsNow();
  const req = fake.state.requests.at(-1);
  assert.equal(req.headers.authorization, 'Bearer sk-from-admin-panel-1234');
  assert.equal(req.body.model, 'gpt-5.4-mini');
  assert.equal(req.body.reasoning, undefined, 'no reasoning effort when "model default"');

  // Connection test from the admin page
  await admin.post('/admin/ai', { action: 'test', provider: 'openai', openai_model: 'gpt-5.4-mini' });
  const tested = await admin.get('/admin/ai');
  assert.match(tested.text, /OpenAI API key works, model gpt-5.4-mini is available/);
  assert.match(tested.text, /Test call succeeded/);

  // Switch to "Off": nothing is queued for new questions
  await admin.post('/admin/ai', { action: 'save', provider: 'none' });
  const jobsBefore = await t.db.val('SELECT COUNT(*) FROM jobs');
  await member.post('/post-thread', { forum_id: await forumId('getting-started'), title: 'Another question while AI is off', body: 'Hello?' });
  assert.equal(await t.db.val('SELECT COUNT(*) FROM jobs'), jobsBefore);
  await admin.post('/admin/ai', { action: 'save', provider: 'openai', openai_remove_key: '1', openai_model: '' });
  assert.equal(await t.db.val("SELECT value FROM settings WHERE key = 'openai_api_key_enc'"), '');
});
