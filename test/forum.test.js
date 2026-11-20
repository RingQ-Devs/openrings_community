import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

let t;
before(async () => {
  t = await setup();
});
after(async () => t?.close());

const forumId = async (slug) => (await t.db.one('SELECT id FROM forums WHERE slug = $1', slug)).id;
const lastThread = () => t.db.one('SELECT * FROM threads ORDER BY id DESC LIMIT 1');
const postsOf = (threadId) =>
  t.db.all('SELECT p.*, u.role FROM posts p JOIN users u ON u.id = p.user_id WHERE thread_id = $1 AND deleted_at IS NULL ORDER BY p.id', threadId);
const count = (sql, ...params) => t.db.val(sql, ...params);
// Public pages must not mention AI. The automated account's username is allowed (auto mode only).
function assertNoAiWording(html, label) {
  const text = html.replace(/OpenRings_Assistant/g, '');
  const m = /.{0,50}(\bAI\b|AI-generated|assistant).{0,30}/i.exec(text);
  assert.equal(m, null, `${label}: found "${m?.[0]}"`);
}

test('bootstrap creates forums, personas, AI user and admin', async () => {
  assert.ok((await count('SELECT COUNT(*) FROM forums')) >= 10);
  assert.ok((await count("SELECT COUNT(*) FROM users WHERE role = 'persona'")) >= 10);
  assert.equal(await count("SELECT COUNT(*) FROM users WHERE role = 'ai'"), 1);
  assert.equal(await t.db.val("SELECT username FROM users WHERE role = 'ai'"), 'OpenRings_Assistant');
  assert.equal(await count("SELECT COUNT(*) FROM users WHERE role = 'admin'"), 1);
});

test('public pages render', async () => {
  const c = t.client();
  for (const path of ['/', '/whats-new', '/whats-new?filter=unanswered', '/members/', '/members/?tab=staff', '/members/OpenRings_Assistant/', '/forums/troubleshooting/', '/search?q=sip', '/rules', '/sitemap.xml', '/robots.txt']) {
    const r = await c.get(path);
    assert.equal(r.status, 200, path);
  }
  assert.equal((await c.get('/does-not-exist')).status, 404);
  assert.equal((await c.get('/posts/abc')).status, 404);
  assert.equal((await c.get('/threads/nothing.999999/')).status, 404);
});

test('registration validates input and logs the user in', async () => {
  const c = t.client();
  const bad = await c.post('/register', { username: 'x', email: 'nope', password: 'short', agree: '1' });
  assert.equal(bad.status, 400);
  await c.register('alice_admin');
  const home = await c.get('/');
  assert.match(home.text, /alice_admin/);
  const dup = await t.client().post('/register', { username: 'ALICE_admin', email: 'other@example.com', password: 'password-123', agree: '1' });
  assert.equal(dup.status, 400);
  assert.match(dup.text, /taken/);
  // login is case-insensitive on username
  const again = t.client();
  assert.equal((await again.login('Alice_Admin', 'password-123')).status, 302);
  // open-redirect protection
  const evil = await t.client().post('/login', { login: 'alice_admin', password: 'password-123', next: '//evil.example' });
  assert.equal(evil.location, '/');
});

test('POST without a CSRF token is rejected', async () => {
  const c = t.client();
  await c.register('bob_csrf');
  const r = await c.post('/post-thread', { forum_id: await forumId('troubleshooting'), title: 'No csrf here please', body: 'hello' }, { csrf: false });
  assert.equal(r.status, 403);
});

const pendingDrafts = (threadId) => t.db.all(`SELECT * FROM reply_drafts WHERE thread_id = $1 AND status = 'pending'`, threadId);
let supportUser;
async function supportClient() {
  const { createUser, getUserByUsername } = await import('../src/services/users.js');
  supportUser = (await getUserByUsername('ringq_dan')) ||
    (await createUser({ username: 'ringq_dan', email: 'dan@ringq.example', password: 'support-pass-1', role: 'support', title: 'Support Engineer' }));
  await t.db.run('UPDATE users SET on_duty = 1 WHERE id = $1', supportUser.id);
  const c = t.client();
  await c.login('ringq_dan', 'support-pass-1');
  return c;
}

test('review mode: questions get drafts that an on-duty engineer posts under their name', async () => {
  t.resetRateLimits();
  await t.settings.setSetting('reply_mode', 'review');
  const support = await supportClient();
  const member = t.client();
  await member.register('carol_member');
  const r = await member.post('/post-thread', {
    forum_id: await forumId('troubleshooting'),
    title: 'One-way audio on remote extensions',
    body: 'Remote phones connect but **audio** only goes one way. <script>alert(1)</script>',
  });
  assert.equal(r.status, 302);
  const thread = await lastThread();
  assert.match(r.location, new RegExp(`/threads/${thread.slug}\\.${thread.id}/`));

  // Markdown is rendered and scripts are stripped
  const first = (await postsOf(thread.id))[0];
  assert.match(first.body_html, /<strong>audio<\/strong>/);
  assert.doesNotMatch(first.body_html, /<script/);

  await t.runJobsNow();
  assert.equal((await postsOf(thread.id)).length, 1, 'nothing is posted without review');
  const [draft] = await pendingDrafts(thread.id);
  assert.ok(draft, 'a draft is waiting');
  assert.equal(draft.assigned_to, supportUser.id, 'assigned to the on-duty engineer');

  // Members see nothing about drafts; staff see the inbox and a notice
  const memberView = await member.get(r.location);
  assert.match(memberView.text, /RingQ Support engineer will reply|RingQ Support team follows this thread/);
  assert.doesNotMatch(memberView.text, /draft/i);
  assert.match((await support.get(r.location)).text, /draft reply for this thread is waiting/);
  const inbox = await support.get('/support/inbox');
  assert.equal(inbox.status, 200);
  assert.match(inbox.text, /One-way audio on remote extensions/);
  assert.equal((await member.get('/support/inbox')).status, 403, 'members cannot open the inbox');

  // The engineer edits and posts the draft
  await support.post(`/support/drafts/${draft.id}`, { action: 'post', post_as: String(supportUser.id), body: draft.body + '\n\nAlso check the router.' });
  let posts = await postsOf(thread.id);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].role, 'support');
  assert.match(posts[1].body, /Also check the router/);
  const page = (await member.get(r.location)).text;
  assert.match(page, /badge--staff">RingQ Support</);
  assertNoAiWording(page, 'thread page');
  assert.doesNotMatch(page, /Automated/);

  // A thank-you gets no draft
  await member.post(`/threads/${thread.id}/reply`, { body: 'Thanks, that sorted it!' });
  await t.runJobsNow();
  assert.equal((await pendingDrafts(thread.id)).length, 0);

  // A new question does; a manual staff reply discards it
  await member.post(`/threads/${thread.id}/reply`, { body: 'Which ports exactly do I need to open?' });
  await t.runJobsNow();
  assert.equal((await pendingDrafts(thread.id)).length, 1);
  await support.post(`/threads/${thread.id}/reply`, { body: 'Open 5060 UDP/TCP and 16384-32768 UDP.' });
  assert.equal((await pendingDrafts(thread.id)).length, 0, 'manual staff reply supersedes the draft');

  // Staff can request a draft on demand, and discard it
  await support.post(`/threads/${thread.id}/moderate`, { action: 'ai_reply_now' });
  await member.post(`/threads/${thread.id}/reply`, { body: 'And for TLS?' });
  await t.runJobsNow();
  const [again] = await pendingDrafts(thread.id);
  assert.ok(again);
  await support.post(`/support/drafts/${again.id}`, { action: 'discard' });
  assert.equal((await pendingDrafts(thread.id)).length, 0);
  assert.equal((await support.post(`/support/drafts/${again.id}`, { action: 'post', post_as: String(supportUser.id), body: 'late' })).status, 302);
  assert.equal((await postsOf(thread.id)).filter((p) => p.body === 'late').length, 0, 'a discarded draft cannot be posted');
});

test('automatic mode posts from the labelled automated account and steps back for staff', async () => {
  t.resetRateLimits();
  await t.settings.setSetting('reply_mode', 'auto');
  const support = await supportClient();
  const member = t.client();
  await member.register('hank_member');
  const r = await member.post('/post-thread', { forum_id: await forumId('troubleshooting'), title: 'Calls drop after thirty seconds', body: 'Every call drops after 30s.' });
  const thread = await lastThread();
  await t.runJobsNow();
  let posts = await postsOf(thread.id);
  assert.equal(posts[1].role, 'ai');
  const html = (await member.get(r.location)).text;
  assert.match(html, /badge--bot">Automated</);
  assert.match(html, /Automated answer/);
  assertNoAiWording(html, 'auto-mode thread');

  await support.post(`/threads/${thread.id}/reply`, { body: 'Support here, check session timers.' });
  await member.post(`/threads/${thread.id}/reply`, { body: 'Where are session timers configured?' });
  await t.runJobsNow();
  posts = await postsOf(thread.id);
  assert.equal(posts.filter((p) => p.role === 'ai').length, 1, 'no automated answer after staff joined');
  await t.settings.setSetting('reply_mode', 'review');
});

test('likes, solutions, edits, search and permissions', async () => {
  t.resetRateLimits();
  const support = await supportClient();
  const asker = t.client();
  await asker.register('dina_asks');
  await asker.post('/post-thread', { forum_id: await forumId('call-routing-ivr'), title: 'IVR with holiday schedule', body: 'How do I set holidays?' });
  const thread = await lastThread();
  await support.post(`/threads/${thread.id}/reply`, { body: 'Use a time-of-day condition with an anti-action.' });
  const answer = (await postsOf(thread.id)).find((p) => p.role === 'support');

  const like = await asker.post(`/posts/${answer.id}/like`, {}, { json: true });
  assert.deepEqual(like.json, { liked: true, count: 1 });
  const unlike = await asker.post(`/posts/${answer.id}/like`, {}, { json: true });
  assert.deepEqual(unlike.json, { liked: false, count: 0 });

  await asker.post(`/posts/${answer.id}/solution`);
  assert.equal(await t.db.val('SELECT is_solved FROM threads WHERE id = $1', thread.id), 1);

  const stranger = t.client();
  await stranger.register('eve_stranger');
  assert.equal((await stranger.post(`/posts/${answer.id}/solution`)).status, 403);
  assert.equal((await stranger.post(`/posts/${answer.id}/edit`, { body: 'hacked' })).status, 403);
  assert.equal((await stranger.post(`/posts/${answer.id}/delete`)).status, 403);

  const first = (await postsOf(thread.id))[0];
  await asker.post(`/posts/${first.id}/edit`, { body: 'How do I set public holidays for Christmas?' });
  assert.match(await t.db.val('SELECT body FROM posts WHERE id = $1', first.id), /Christmas/);

  const results = await asker.get('/search?q=christmas');
  assert.match(results.text, /IVR with holiday schedule/);
  const titleHit = await asker.get('/search?q=holiday%20schedule');
  assert.match(titleHit.text, /<mark>/);

  // Staff delete: post first, then whole thread
  const admin = t.client();
  await admin.login('admin', 'admin-password-1');
  await admin.post(`/posts/${answer.id}/delete`);
  assert.equal(await t.db.val('SELECT is_solved FROM threads WHERE id = $1', thread.id), 0, 'deleting the solution unsolves the thread');
  await admin.post(`/threads/${thread.id}/moderate`, { action: 'delete' });
  assert.equal((await asker.get(`/threads/${thread.slug}.${thread.id}/`)).status, 404);
});

test('public pages carry the site header and never mention AI', async () => {
  const c = t.client();
  for (const path of ['/', '/whats-new', '/members/', '/members/?tab=staff', '/rules', '/forums/troubleshooting/', '/login', '/register']) {
    const html = (await c.get(path)).text;
    assertNoAiWording(html, path);
    assert.doesNotMatch(html, /RingQ Switch|Cal4care|Download OpenRings|Download Open Rings|Powered by/i, path);
    assert.doesNotMatch(html, />(Features|Architecture|Compare|Blog|FAQ|Contact)</, `${path}: no main-site menu`);
    assert.equal((html.match(/href="\/post-thread/g) || []).length, path === '/login' || path === '/register' ? 1 : 1, `${path}: one Ask a question link`);
    assert.match(html, /© \d{4} Open Rings<\/div>/, path);
  }
});

test('the Ask a question button pre-selects the current forum', async () => {
  const html = (await t.client().get('/forums/troubleshooting/')).text;
  assert.match(html, /href="\/post-thread\?forum=troubleshooting"/);
});

test('knowledge base edits are saved and used for new drafts', async () => {
  const admin = t.client();
  await admin.login('admin', 'admin-password-1');
  const kb = '# OpenRings knowledge base\n\n## Features\n- WhatsApp channel for customer messages.\n';
  await admin.post('/admin/knowledge', { knowledge_base: kb });
  assert.match((await admin.get('/admin/knowledge')).text, /WhatsApp channel for customer messages/);
  assert.equal(await t.settings.getSetting('knowledge_base'), kb);
  const { assistantSystemPrompt } = await import('../src/ai/prompts.js');
  assert.match(assistantSystemPrompt(await t.settings.getSetting('knowledge_base')), /WhatsApp channel/);
  assert.equal((await admin.post('/admin/knowledge/reset')).status, 404, 'no reload-from-file action');
});

test('an old starter knowledge base is upgraded once and keeps admin additions', async () => {
  const fs = await import('node:fs');
  const oldTemplate = fs.readFileSync(new URL('../src/migrations/knowledge-template-v1.md', import.meta.url), 'utf8');
  const edited = oldTemplate.replace('## Call features', '## Call features\n- WhatsApp: customers can message us on WhatsApp.');
  await t.settings.setSetting('knowledge_base', edited);
  const { upgradeOldKnowledgeBase } = await import('../src/migrations/knowledge-upgrade.js');
  assert.equal(await upgradeOldKnowledgeBase(), true);
  const kb = await t.settings.getSetting('knowledge_base');
  assert.match(kb, /## What OpenRings is/);
  assert.doesNotMatch(kb, /RingQ Switch/);
  assert.match(kb, /## Added in the admin panel\n- WhatsApp: customers can message us on WhatsApp\./);
  assert.equal(await t.settings.getSetting('knowledge_base_backup'), edited);
  assert.equal(await upgradeOldKnowledgeBase(), false, 'runs only once');
});

test('admin panel is admin-only and pages render', async () => {
  const member = t.client();
  await member.register('frank_member');
  assert.equal((await member.get('/admin')).status, 403);
  assert.equal((await t.client().get('/admin')).status, 302);
  const admin = t.client();
  await admin.login('admin', 'admin-password-1');
  for (const p of ['/admin', '/admin/settings', '/admin/knowledge', '/admin/topics', '/admin/forums', '/admin/users', '/admin/users?q=frank', '/admin/personas', '/admin/queue', '/admin/queue?status=pending', '/admin/jobs']) {
    assert.equal((await admin.get(p)).status, 200, p);
  }
  // settings save
  await admin.post('/admin/settings', { ai_autoreply_enabled: '1', ai_followups_enabled: '1', ai_stop_when_staff_replies: '1', seed_enabled: '1', disclose_personas: '1', seed_posts_per_day: '4', announcement: 'Hello world' });
  assert.match((await member.get('/')).text, /Hello world/);
  // create a support account from the admin panel
  const r = await admin.post('/admin/users', { username: 'ringq_maya', email: 'maya@ringq.example', password: 'support-pass-2', role: 'support' });
  assert.equal(r.status, 302);
  const maya = await t.db.one("SELECT id, role FROM users WHERE username = 'ringq_maya'");
  assert.equal(maya.role, 'support');
  await admin.post(`/admin/users/${maya.id}`, { role: 'support', title: 'Support Engineer', on_duty: '1' });
  assert.equal(await t.db.val('SELECT on_duty FROM users WHERE id = $1', maya.id), 1);
  await admin.post(`/admin/users/${maya.id}`, { role: 'support', title: 'Support Engineer' });
  assert.equal(await t.db.val('SELECT on_duty FROM users WHERE id = $1', maya.id), 0);
  // reply mode + team name
  await admin.post('/admin/settings', { reply_mode: 'review', support_team_name: 'RingQ Support', ai_autoreply_enabled: '1', ai_followups_enabled: '1', seed_enabled: '1' });
});

test('daily seeding plans, publishes and answers persona questions', async () => {
  await t.settings.setSetting('seed_enabled', '1');
  await t.settings.setSetting('seed_require_approval', '0');
  await t.settings.setSetting('seed_posts_per_day', '3');
  await t.settings.setSetting('seed_last_plan_date', '');

  const actions = await t.seeder.schedulerTick();
  assert.equal(actions.planned, true);
  assert.equal((await t.seeder.schedulerTick()).planned, false, 'plans only once per day');
  await t.runJobsNow();

  const planned = await t.db.all(`SELECT * FROM scheduled_posts WHERE status = 'approved'`);
  assert.equal(planned.length, 3);
  for (const sp of planned) assert.ok(Date.parse(sp.publish_at) > Date.now(), 'scheduled in the future');

  // Time passes: everything is due
  await t.db.run(`UPDATE scheduled_posts SET publish_at = now() - interval '1 second'`);
  assert.equal((await t.seeder.schedulerTick()).published, 3);
  const seeded = await t.db.all('SELECT * FROM threads WHERE is_seeded = 1');
  assert.equal(seeded.length, 3);
  for (const th of seeded) assert.equal(await t.db.val('SELECT role FROM users WHERE id = $1', th.user_id), 'persona');

  // Answers are delayed, then drafted for the support team
  const queued = await t.db.all(`SELECT * FROM jobs WHERE type = 'ai_reply' AND status = 'queued'`);
  assert.equal(queued.length, 3);
  assert.ok(queued.every((j) => Date.parse(j.run_at) > Date.now() + 60_000), 'seeded answers are delayed');
  await t.settings.setSetting('seed_followups_min', '1');
  await t.settings.setSetting('seed_followups_max', '1');
  await t.runJobsNow();
  const support = await supportClient();
  for (const th of seeded) {
    const [d] = await pendingDrafts(th.id);
    assert.ok(d, 'each seeded question has a draft');
    await support.post(`/support/drafts/${d.id}`, { action: 'post', post_as: String(supportUser.id), body: d.body });
  }
  await t.runJobsNow();
  for (const th of seeded) {
    const roles = (await postsOf(th.id)).map((p) => p.role);
    // member question, support answer, member follow-up; the next answer waits as a draft
    assert.deepEqual(roles, ['persona', 'support', 'persona']);
    assert.equal((await pendingDrafts(th.id)).length, 1);
  }

  // Sample-member label is off by default and can be turned on
  const c = t.client();
  const url = `/threads/${seeded[0].slug}.${seeded[0].id}/`;
  assert.doesNotMatch((await c.get(url)).text, /badge--persona/);
  await t.settings.setSetting('disclose_personas', '1');
  assert.match((await c.get(url)).text, /badge--persona"[^>]*>Sample question/);
  await t.settings.setSetting('disclose_personas', '0');
});

test('approval mode holds generated questions until an admin approves', async () => {
  await t.settings.setSetting('seed_require_approval', '1');
  const admin = t.client();
  await admin.login('admin', 'admin-password-1');
  await admin.post('/admin/queue/generate', { count: '2' });
  await t.runJobsNow();
  const pending = await t.db.all(`SELECT * FROM scheduled_posts WHERE status = 'pending' ORDER BY id`);
  assert.equal(pending.length, 2);
  await t.db.run(`UPDATE scheduled_posts SET publish_at = now() - interval '1 second' WHERE status = 'pending'`);
  assert.equal((await t.seeder.schedulerTick()).published, 0, 'pending items are not published');

  await admin.post(`/admin/queue/${pending[0].id}`, { action: 'approve', title: 'Edited title for the queue item', body: pending[0].body });
  await admin.post(`/admin/queue/${pending[1].id}`, { action: 'reject' });
  assert.equal((await t.seeder.schedulerTick()).published, 1);
  assert.equal((await lastThread()).title, 'Edited title for the queue item');
  assert.equal((await t.seeder.schedulerTick()).published, 0, 'never published twice');
});

test('staff who post a question are told how to get a draft', async () => {
  const admin = t.client();
  await admin.login('admin', 'admin-password-1');
  const r = await admin.post('/post-thread', { forum_id: await forumId('sip-trunks-providers'), title: 'How to configure SIP trunk', body: 'How to configure SIP trunk' });
  const page = await admin.get(r.location);
  assert.match(page.text, /Questions from staff accounts do not get a draft reply automatically/);
});

test('staff-only forums and locked threads', async () => {
  t.resetRateLimits();
  const member = t.client();
  await member.register('gina_member');
  const r = await member.post('/post-thread', { forum_id: await forumId('announcements'), title: 'Trying to post here', body: 'hello' });
  assert.equal(r.status, 400);

  await member.post('/post-thread', { forum_id: await forumId('general-discussion'), title: 'A general question here', body: 'hello there' });
  const thread = await lastThread();
  const admin = t.client();
  await admin.login('admin', 'admin-password-1');
  await admin.post(`/threads/${thread.id}/moderate`, { action: 'lock' });
  const reply = await member.post(`/threads/${thread.id}/reply`, { body: 'can I still reply?' });
  assert.equal(reply.status, 403);
});
