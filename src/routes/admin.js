import express from 'express';
import { one, all, val, run } from '../db.js';
import { config } from '../config.js';
import { getAiSettings, isConfigured, modelLabel, saveAiSettings, aiConfigured, CLAUDE_EFFORTS, OPENAI_EFFORTS, LOCAL_DEFAULTS } from '../services/ai-settings.js';
import { checkAiConnection } from '../ai/check.js';
import { maskKey } from '../lib/secrets.js';
import * as forum from '../services/forum.js';
import { allSettings, setSetting, getSetting } from '../services/settings.js';
import { recentJobs, jobStats, enqueueJob } from '../services/jobs.js';
import { countPendingDrafts } from '../services/drafts.js';
import { searchUsers, getUserById, updateUser, createUser, validateRegistration, listPersonas, parsePersona, deleteAllSessions, USERNAME_RE } from '../services/users.js';
import { createPersona, generatePersonas, publishScheduledPost } from '../ai/seeder.js';
import { scheduleWaitingDrafts } from '../ai/responder.js';
import { localDate, zonedTime } from '../lib/format.js';
import { ICON_NAMES } from '../lib/icons.js';
import { requireAdmin } from './guards.js';

const router = express.Router();
router.use(requireAdmin);
router.use((req, res, next) => {
  res.locals.meta.noindex = true;
  res.locals.adminSection = req.path.split('/')[1] || 'dashboard';
  next();
});

const intParam = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : 0);
const back = (res, path, type, message) => {
  if (message) res.flash(type, message);
  res.redirect(res.locals.url('/admin' + path));
};

// ---- dashboard -------------------------------------------------------------------

router.get('/', async (req, res) => {
  const today = localDate();
  res.locals.meta.title = 'Admin dashboard';
  res.render('admin/dashboard', {
    version: config.version,
    stats: await forum.forumStats(),
    jobs: await jobStats(),
    queue: await all(
      `SELECT sp.*, u.username AS persona_username, f.title AS forum_title FROM scheduled_posts sp
       JOIN users u ON u.id = sp.persona_id JOIN forums f ON f.id = sp.forum_id
       WHERE sp.plan_date = $1 OR sp.status IN ('pending','approved') ORDER BY sp.publish_at LIMIT 20`,
      today,
    ),
    failed: await all(`SELECT * FROM jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 5`),
    creditProblem: !!(await one(
      `SELECT 1 FROM jobs WHERE last_error ILIKE '%credit balance%' AND status IN ('queued','failed')
       AND updated_at > now() - interval '1 day' LIMIT 1`,
    )),
    newMembers: await all(`SELECT * FROM users WHERE role = 'member' ORDER BY id DESC LIMIT 8`),
    pendingDrafts: await countPendingDrafts(),
    onDuty: await all(`SELECT id, username, role FROM users WHERE role IN ('support','admin') AND on_duty = 1 AND is_banned = 0 ORDER BY username`),
    aiConfigured: await aiConfigured(),
    aiModel: modelLabel(await getAiSettings()),
    settings: await allSettings(),
    today,
  });
});

// ---- settings --------------------------------------------------------------------

const BOOL_KEYS = ['ai_autoreply_enabled', 'ai_followups_enabled', 'ai_stop_when_staff_replies', 'seed_enabled', 'seed_require_approval', 'disclose_personas'];
const NUM_KEYS = {
  ai_reply_delay_seconds: [0, 86400],
  ai_reply_delay_max_seconds: [0, 86400],
  review_fallback_minutes: [1, 1440],
  ai_max_replies_per_thread: [1, 50],
  seed_posts_per_day: [0, 20],
  seed_window_start_hour: [0, 23],
  seed_window_end_hour: [1, 24],
  seed_answer_delay_min_minutes: [0, 1440],
  seed_answer_delay_max_minutes: [0, 1440],
  seed_followup_rate: [0, 1],
};

router.get('/settings', async (req, res) => {
  res.locals.meta.title = 'AI & automation settings';
  const ai = await getAiSettings();
  res.render('admin/settings', { settings: await allSettings(), config, aiConfigured: isConfigured(ai), aiModel: modelLabel(ai) });
});

router.post('/settings', async (req, res) => {
  for (const key of BOOL_KEYS) await setSetting(key, req.body[key] ? '1' : '0');
  for (const [key, [min, max]] of Object.entries(NUM_KEYS)) {
    const n = Number(req.body[key]);
    if (req.body[key] !== undefined && req.body[key] !== '' && Number.isFinite(n)) await setSetting(key, Math.min(max, Math.max(min, n)));
  }
  await setSetting('announcement', String(req.body.announcement || '').slice(0, 500));
  const mode = ['review', 'review_fallback', 'auto'].includes(req.body.reply_mode) ? req.body.reply_mode : 'review';
  await setSetting('reply_mode', mode);
  const team = String(req.body.support_team_name || '').trim().slice(0, 40);
  if (team) await setSetting('support_team_name', team);
  const scheduled = await scheduleWaitingDrafts(mode);
  back(res, '/settings', 'success', scheduled
    ? `Settings saved. ${scheduled} draft${scheduled === 1 ? '' : 's'} waiting in the Support inbox will now be posted automatically${mode === 'auto' ? '' : ' if nobody reviews them in time'}.`
    : 'Settings saved.');
});

// ---- AI provider -------------------------------------------------------------------

router.get('/ai', async (req, res) => {
  const ai = await getAiSettings();
  let results = null;
  try {
    const last = JSON.parse((await getSetting('ai_last_test')) || 'null');
    // Show the last test only if it is recent and for the provider that is selected now.
    if (last && last.provider === ai.provider && Date.now() - Date.parse(last.at) < 30 * 60_000) results = last;
  } catch {
    results = null;
  }
  res.locals.meta.title = 'AI provider';
  res.render('admin/ai', {
    ai,
    active: modelLabel(ai),
    ready: isConfigured(ai),
    keys: { anthropic: maskKey(ai.anthropic.apiKey), openai: maskKey(ai.openai.apiKey), local: maskKey(ai.local.apiKey) },
    claudeEfforts: CLAUDE_EFFORTS,
    openaiEfforts: OPENAI_EFFORTS,
    defaults: { ...config.ai, local: LOCAL_DEFAULTS },
    results,
  });
});

router.post('/ai', async (req, res) => {
  await saveAiSettings(req.body);
  const ai = await getAiSettings();
  if (req.body.action === 'test') {
    const results = await checkAiConnection(ai, { testCall: true });
    await setSetting('ai_last_test', JSON.stringify({ at: new Date().toISOString(), provider: ai.provider, results }));
    const failed = results.some((r) => r.ok === false);
    return back(res, '/ai', failed ? 'error' : 'success', failed ? 'Saved. The connection test found a problem, see below.' : `Saved and tested. Drafts now use: ${modelLabel(ai)}.`);
  }
  await setSetting('ai_last_test', '');
  back(res, '/ai', isConfigured(ai) || ai.provider === 'none' ? 'success' : 'error',
    isConfigured(ai) || ai.provider === 'none'
      ? `Saved. Drafts now use: ${modelLabel(ai)}.`
      : 'Saved, but the selected provider is missing its API key or settings, so drafts are off.');
});

router.get('/knowledge', async (req, res) => {
  res.locals.meta.title = 'Knowledge base';
  res.render('admin/knowledge', {
    knowledge: await getSetting('knowledge_base'),
    savedAt: await getSetting('knowledge_base_saved_at'),
    backup: await getSetting('knowledge_base_backup'),
    backupAt: await getSetting('knowledge_base_backup_at'),
  });
});

router.post('/knowledge', async (req, res) => {
  await setSetting('knowledge_base', String(req.body.knowledge_base || '').slice(0, 400_000));
  await setSetting('knowledge_base_saved_at', new Date().toISOString());
  back(res, '/knowledge', 'success', 'Knowledge base saved. Every new draft uses it from now on.');
});

router.get('/topics', async (req, res) => {
  res.locals.meta.title = 'Topic ideas';
  res.render('admin/topics', { topics: await getSetting('topic_bank') });
});

router.post('/topics', async (req, res) => {
  await setSetting('topic_bank', String(req.body.topic_bank || '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n'));
  back(res, '/topics', 'success', 'Topic ideas saved.');
});

// ---- forums ------------------------------------------------------------------------

router.get('/forums', async (req, res) => {
  res.locals.meta.title = 'Forums';
  res.render('admin/forums', { categories: await forum.listCategoriesWithForums(), icons: ICON_NAMES });
});

const forumFields = (b) => ({
  category_id: intParam(b.category_id),
  title: String(b.title || '').trim(),
  slug: String(b.slug || '').trim(),
  description: String(b.description || '').trim(),
  icon: ICON_NAMES.includes(b.icon) ? b.icon : 'chat',
  sort_order: Number(b.sort_order) || 0,
  staff_only: !!b.staff_only,
  ai_enabled: !!b.ai_enabled,
  seed_weight: Math.max(0, Math.min(10, Number(b.seed_weight) || 0)),
});

router.post('/categories', async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return back(res, '/forums', 'error', 'Category title is required.');
  await forum.createCategory({ title, description: String(req.body.description || ''), sort_order: Number(req.body.sort_order) || 0 });
  back(res, '/forums', 'success', 'Category created.');
});

router.post('/categories/:id', async (req, res) => {
  const id = intParam(req.params.id);
  try {
    if (req.body.action === 'delete') await forum.deleteCategory(id);
    else await forum.updateCategory(id, { title: String(req.body.title || '').trim(), description: String(req.body.description || ''), sort_order: Number(req.body.sort_order) || 0 });
    back(res, '/forums', 'success', 'Category saved.');
  } catch (err) {
    back(res, '/forums', 'error', err.message);
  }
});

router.post('/forums', async (req, res) => {
  const f = forumFields(req.body);
  if (!f.title || !(await forum.getCategory(f.category_id))) return back(res, '/forums', 'error', 'Title and category are required.');
  await forum.createForum(f);
  back(res, '/forums', 'success', 'Forum created.');
});

router.post('/forums/:id', async (req, res) => {
  const f = forumFields(req.body);
  if (!f.title || !(await forum.getCategory(f.category_id))) return back(res, '/forums', 'error', 'Title and category are required.');
  await forum.updateForum(intParam(req.params.id), f);
  back(res, '/forums', 'success', 'Forum saved.');
});

// ---- users & staff -----------------------------------------------------------------

const staffList = () => all("SELECT * FROM users WHERE role <> 'persona' ORDER BY id DESC LIMIT 100");

router.get('/users', async (req, res) => {
  const q = String(req.query.q || '').trim();
  res.locals.meta.title = 'Users';
  res.render('admin/users', { q, users: q ? await searchUsers(q) : await staffList(), errors: [], values: {} });
});

router.post('/users', async (req, res) => {
  const values = { username: String(req.body.username || '').trim(), email: String(req.body.email || '').trim(), password: String(req.body.password || '') };
  const role = ['member', 'support', 'admin'].includes(req.body.role) ? req.body.role : 'support';
  const errors = await validateRegistration(values);
  if (errors.length) {
    return res.status(400).render('admin/users', { q: '', users: await staffList(), errors, values: { ...values, password: '', role } });
  }
  await createUser({ ...values, role, title: String(req.body.title || '').trim() || (role === 'support' ? 'RingQ Support' : null) });
  back(res, '/users', 'success', `Account ${values.username} created.`);
});

router.post('/users/:id', async (req, res) => {
  const target = await getUserById(intParam(req.params.id));
  if (!target || target.role === 'ai') return back(res, '/users', 'error', 'User not found.');
  if (target.id === req.user.id && req.body.role && req.body.role !== 'admin') return back(res, '/users', 'error', 'You cannot remove your own admin role.');
  const fields = { title: String(req.body.title || '').trim() || null };
  if (['member', 'support', 'admin'].includes(req.body.role) && target.role !== 'persona') fields.role = req.body.role;
  fields.is_banned = req.body.is_banned ? 1 : 0;
  fields.on_duty = req.body.on_duty && ['support', 'admin'].includes(fields.role || target.role) ? 1 : 0;
  if (target.id === req.user.id) fields.is_banned = 0;
  await updateUser(target.id, fields);
  if (fields.is_banned) await deleteAllSessions(target.id);
  back(res, `/users${req.body.q ? `?q=${encodeURIComponent(req.body.q)}` : ''}`, 'success', `Updated ${target.username}.`);
});

// ---- personas ----------------------------------------------------------------------

const isUniqueViolation = (err) => err?.code === '23505';

router.get('/personas', async (req, res) => {
  res.locals.meta.title = 'Personas';
  res.render('admin/personas', { personas: (await listPersonas()).map((p) => ({ ...p, persona: parsePersona(p) })) });
});

router.post('/personas', async (req, res) => {
  try {
    await createPersona({
      username: String(req.body.username || '').trim(),
      location: String(req.body.location || '').trim(),
      job: String(req.body.job || '').trim(),
      organization: String(req.body.organization || '').trim(),
      experience: String(req.body.experience || 'intermediate'),
      writing_style: String(req.body.writing_style || '').trim(),
      bio: String(req.body.bio || '').trim(),
    });
    back(res, '/personas', 'success', 'Persona created.');
  } catch (err) {
    back(res, '/personas', 'error', isUniqueViolation(err) ? 'That username is taken.' : err.message);
  }
});

router.post('/personas/generate', async (req, res) => {
  try {
    const created = await generatePersonas(Math.max(1, Math.min(10, Number(req.body.count) || 5)));
    back(res, '/personas', 'success', `Created ${created.length} personas.`);
  } catch (err) {
    back(res, '/personas', 'error', `AI could not create personas: ${err.message}`);
  }
});

router.post('/personas/:id', async (req, res) => {
  const p = await getUserById(intParam(req.params.id));
  if (!p || p.role !== 'persona') return back(res, '/personas', 'error', 'Persona not found.');
  if (req.body.action === 'toggle') {
    await updateUser(p.id, { is_active: p.is_active ? 0 : 1 });
    return back(res, '/personas', 'success', `${p.username} ${p.is_active ? 'paused' : 'activated'}.`);
  }
  const username = String(req.body.username || p.username).trim();
  if (!USERNAME_RE.test(username)) return back(res, '/personas', 'error', 'Invalid username.');
  try {
    await updateUser(p.id, {
      username,
      location: String(req.body.location || '').trim(),
      bio: String(req.body.bio || '').trim(),
      persona_json: JSON.stringify({
        job: String(req.body.job || '').trim(),
        organization: String(req.body.organization || '').trim(),
        experience: String(req.body.experience || 'intermediate'),
        writing_style: String(req.body.writing_style || '').trim(),
      }),
    });
    back(res, '/personas', 'success', `Saved ${username}.`);
  } catch (err) {
    back(res, '/personas', 'error', isUniqueViolation(err) ? 'That username is taken.' : err.message);
  }
});

// ---- daily content queue -----------------------------------------------------------

/** Explains what the daily-posts scheduler did today, in plain words. */
async function dailyStatus() {
  const date = localDate();
  const items = await all(`SELECT status, publish_at FROM scheduled_posts WHERE plan_date = $1 ORDER BY publish_at`, date);
  const job = await one(`SELECT * FROM jobs WHERE type = 'seed_generate' AND payload->>'date' = $1 ORDER BY id DESC LIMIT 1`, date);
  const ai = await getAiSettings();
  const s = await allSettings();
  const count = (st) => items.filter((i) => i.status === st).length;
  const next = items.find((i) => i.status === 'approved' && Date.parse(i.publish_at) > Date.now());
  let state;
  if (s.seed_enabled !== '1') state = { level: 'warn', text: 'Daily posts are turned off (Answer settings → Create new discussions every day).' };
  else if (!isConfigured(ai)) state = { level: 'error', text: 'No AI provider is set up, so no questions can be written. Set one up in AI provider.' };
  else if (job && job.status === 'failed') state = { level: 'error', text: `Writing today's questions failed: ${job.last_error}`, retryJobId: job.id };
  else if (job && (job.status === 'queued' || job.status === 'running')) state = { level: 'info', text: job.attempts ? `Writing today's questions, retrying after an error: ${job.last_error || ''}` : "Writing today's questions now. Refresh in a minute." };
  else if (!items.length && s.seed_last_plan_date !== date) state = { level: 'info', text: "Today's questions will be written within a minute while the forum is running." };
  else if (!items.length) state = { level: 'warn', text: 'Nothing was planned for today. Use “Generate with AI” below to create questions now.' };
  else state = { level: 'ok', text: `${items.length} planned today: ${count('published')} published, ${count('approved')} waiting for their time, ${count('pending')} waiting for your approval.` };
  return { date, state, next: next?.publish_at || null, window: `${s.seed_window_start_hour}:00–${s.seed_window_end_hour}:00`, timezone: config.timezone, perDay: s.seed_posts_per_day };
}


router.get('/queue', async (req, res) => {
  const status = ['pending', 'approved', 'published', 'rejected', 'failed'].includes(req.query.status) ? req.query.status : null;
  res.locals.meta.title = 'Daily posts queue';
  res.render('admin/queue', {
    status,
    items: await all(
      `SELECT sp.*, u.username AS persona_username, f.title AS forum_title, t.slug AS thread_slug
       FROM scheduled_posts sp JOIN users u ON u.id = sp.persona_id JOIN forums f ON f.id = sp.forum_id
       LEFT JOIN threads t ON t.id = sp.thread_id
       WHERE ($1::text IS NULL OR sp.status = $1) ORDER BY sp.publish_at DESC LIMIT 100`,
      status,
    ),
    counts: Object.fromEntries((await all('SELECT status, COUNT(*) AS n FROM scheduled_posts GROUP BY status')).map((r) => [r.status, r.n])),
    forums: await forum.listForums(),
    personas: (await listPersonas()).filter((p) => p.is_active),
    aiConfigured: await aiConfigured(),
    pendingGenerate: await val(`SELECT COUNT(*) FROM jobs WHERE type = 'seed_generate' AND status IN ('queued','running')`),
    today: await dailyStatus(),
  });
});

router.post('/queue/generate', async (req, res) => {
  if (!(await aiConfigured())) return back(res, '/queue', 'error', 'AI is not configured. Set it up in Admin → AI provider.');
  const count = Math.max(1, Math.min(20, Number(req.body.count) || 3));
  await enqueueJob('seed_generate', { date: localDate(), count, manual: true });
  back(res, '/queue', 'info', `Generating ${count} new questions. Refresh in a minute.`);
});

router.post('/queue/approve-all', async (req, res) => {
  const { rowCount } = await run(`UPDATE scheduled_posts SET status = 'approved', updated_at = now() WHERE status = 'pending'`);
  back(res, '/queue', 'success', rowCount
    ? `Approved ${rowCount} question${rowCount === 1 ? '' : 's'}. Any whose time has passed are published within a few seconds.`
    : 'Nothing was waiting for approval.');
});

router.post('/queue/manual', async (req, res) => {
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  const f = await forum.getForumById(intParam(req.body.forum_id));
  const persona = await getUserById(intParam(req.body.persona_id));
  if (!f || !persona || persona.role !== 'persona' || forum.validateThreadInput({ title, body }).length) {
    return back(res, '/queue', 'error', 'Pick a forum and persona, and enter a title (8+ characters) and question.');
  }
  // datetime-local has no time zone: read it as SITE_TIMEZONE wall-clock time.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(req.body.publish_at || ''));
  const publishAt = m ? zonedTime(m[1], Number(m[2]), Number(m[3])) : new Date();
  await run(
    `INSERT INTO scheduled_posts (plan_date, forum_id, persona_id, title, body, status, publish_at) VALUES ($1, $2, $3, $4, $5, 'approved', $6)`,
    localDate(), f.id, persona.id, title, body, Number.isNaN(publishAt.getTime()) ? new Date().toISOString() : publishAt.toISOString(),
  );
  back(res, '/queue', 'success', 'Question scheduled.');
});

router.post('/queue/:id', async (req, res) => {
  const sp = await one('SELECT * FROM scheduled_posts WHERE id = $1', intParam(req.params.id));
  if (!sp) return back(res, '/queue', 'error', 'Item not found.');
  const action = req.body.action;
  if (sp.status === 'published') return back(res, '/queue', 'error', 'Already published — edit the thread instead.');
  const title = String(req.body.title ?? sp.title).trim();
  const body = String(req.body.body ?? sp.body).trim();
  const forumId = req.body.forum_id && (await forum.getForumById(intParam(req.body.forum_id))) ? intParam(req.body.forum_id) : sp.forum_id;

  if (action === 'save' || action === 'approve' || action === 'publish') {
    if (forum.validateThreadInput({ title, body }).length) return back(res, '/queue', 'error', 'Title (8+ chars) and question are required.');
    await run(
      `UPDATE scheduled_posts SET title = $1, body = $2, forum_id = $3, status = CASE WHEN $4 THEN 'approved' ELSE status END, updated_at = now() WHERE id = $5`,
      title, body, forumId, action === 'approve', sp.id,
    );
  }
  if (action === 'save' || action === 'approve') {
    return back(res, '/queue', 'success', action === 'approve' ? 'Approved — it will publish at its scheduled time.' : 'Saved.');
  }
  if (action === 'reject') {
    await run(`UPDATE scheduled_posts SET status = 'rejected', updated_at = now() WHERE id = $1`, sp.id);
    return back(res, '/queue', 'success', 'Rejected.');
  }
  if (action === 'publish') {
    try {
      const threadId = await publishScheduledPost({ ...sp, title, body, forum_id: forumId });
      const t = await forum.getThread(threadId);
      res.flash('success', 'Published. The AI answer will follow after the configured delay.');
      return res.redirect(res.locals.url(`/threads/${t.slug}.${t.id}/`));
    } catch (err) {
      return back(res, '/queue', 'error', err.message);
    }
  }
  back(res, '/queue');
});

// ---- AI job log ---------------------------------------------------------------------

router.get('/jobs', async (req, res) => {
  res.locals.meta.title = 'AI activity';
  res.render('admin/jobs', { jobs: (await recentJobs(150)).map((j) => ({ ...j, payloadObj: j.payload || {}, resultObj: j.result || null })) });
});

router.post('/jobs/:id/retry', async (req, res) => {
  await run(
    `UPDATE jobs SET status = 'queued', run_at = now(), attempts = 0, updated_at = now() WHERE id = $1 AND status IN ('failed','skipped')`,
    intParam(req.params.id),
  );
  back(res, '/jobs', 'success', 'Job queued again.');
});

export default router;
