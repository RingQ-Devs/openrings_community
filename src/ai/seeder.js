import { z } from 'zod';
import { all, one, val, run } from '../db.js';
import { config } from '../config.js';
import { aiConfigured } from '../services/ai-settings.js';
import { generateStructured } from './client.js';
import { seedSystemPrompt, followupSystemPrompt, personaSystemPrompt } from './prompts.js';
import { getSetting, setSetting, getBool, getNumber, claimSetting } from '../services/settings.js';
import { enqueueJob, hasQueuedJob } from '../services/jobs.js';
import { getUserById, parsePersona, createUser, USERNAME_RE } from '../services/users.js';
import { getForumById, createThread, createPost, getThread, threadTranscript } from '../services/forum.js';
import { queueAiReplyIfNeeded } from './responder.js';
import { localDate, zonedTime } from '../lib/format.js';

const SeedSchema = z.object({
  posts: z.array(z.object({ slot: z.number().int(), title: z.string(), body: z.string() })),
});
const FollowupSchema = z.object({ body: z.string() });
const PersonaSchema = z.object({
  personas: z.array(
    z.object({
      username: z.string(),
      location: z.string(),
      job: z.string(),
      organization: z.string(),
      experience: z.enum(['beginner', 'intermediate', 'advanced', 'expert']),
      writing_style: z.string(),
      bio: z.string(),
    }),
  ),
});

const rand = (min, max) => min + Math.random() * (max - min);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function weightedForum(forums) {
  const total = forums.reduce((s, f) => s + f.seed_weight, 0);
  let r = Math.random() * total;
  for (const f of forums) if ((r -= f.seed_weight) < 0) return f;
  return forums[forums.length - 1];
}

const seedableForums = () => all('SELECT * FROM forums WHERE seed_weight > 0 AND staff_only = 0 AND ai_enabled = 1');

const activePersonas = () => all("SELECT * FROM users WHERE role = 'persona' AND is_active = 1 AND is_banned = 0");

async function takeTopicHints(count) {
  const lines = (await getSetting('topic_bank')).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const chosen = shuffle(lines).slice(0, count);
  await setSetting('topic_bank', lines.filter((l) => !chosen.includes(l)).join('\n'));
  return chosen;
}

/** Spread publish times across the rest of today's posting window (site time zone). */
export async function publishTimes(count, date = localDate(), now = new Date()) {
  const startHour = await getNumber('seed_window_start_hour');
  const endHour = Math.max(startHour + 1, (await getNumber('seed_window_end_hour')) || 21);
  let start = Math.max(zonedTime(date, startHour).getTime(), now.getTime() + 5 * 60_000);
  let end = zonedTime(date, endHour).getTime();
  if (end - start < 60 * 60_000) end = start + 3 * 60 * 60_000; // window already over: spread over 3 hours
  return Array.from({ length: count }, () => new Date(rand(start, end)))
    .sort((a, b) => a - b)
    .map((d) => d.toISOString());
}

/**
 * Questions whose time passed while the forum was not running (more than 30 minutes ago) are not
 * published all at once: they get new random times in the rest of today's posting window, or in
 * tomorrow's window when less than an hour of today's is left.
 */
export async function spreadOverduePosts(now = new Date()) {
  const overdue = await all(
    `SELECT id FROM scheduled_posts WHERE status = 'approved' AND publish_at < $1 ORDER BY publish_at`,
    new Date(now.getTime() - 30 * 60_000).toISOString(),
  );
  if (!overdue.length) return 0;
  const today = localDate(config.timezone, now);
  const endToday = zonedTime(today, Math.max((await getNumber('seed_window_start_hour')) + 1, (await getNumber('seed_window_end_hour')) || 21));
  const date = endToday.getTime() - now.getTime() < 60 * 60_000 ? localDate(config.timezone, new Date(now.getTime() + 86400_000)) : today;
  const times = await publishTimes(overdue.length, date, now);
  for (const [i, sp] of overdue.entries()) {
    await run(`UPDATE scheduled_posts SET publish_at = $1, updated_at = now() WHERE id = $2`, times[i], sp.id);
  }
  console.log(`[daily] ${overdue.length} overdue question(s) rescheduled across the posting window of ${date}`);
  return overdue.length;
}

// ---------------------------------------------------------------------------
// Scheduler tick: plan today's batch once per day, publish due posts.
// ---------------------------------------------------------------------------

export async function schedulerTick(now = new Date()) {
  const actions = { planned: false, published: 0 };
  if ((await aiConfigured()) && (await getBool('seed_enabled'))) {
    const today = localDate(config.timezone, now);
    // claimSetting is atomic, so only one process plans each day.
    if ((await getSetting('seed_last_plan_date')) !== today && (await claimSetting('seed_last_plan_date', today))) {
      await enqueueJob('seed_generate', { date: today, count: await getNumber('seed_posts_per_day') });
      actions.planned = true;
    }
  }
  actions.rescheduled = await spreadOverduePosts(now);
  const due = await all(
    `SELECT * FROM scheduled_posts WHERE status = 'approved' AND publish_at <= $1 ORDER BY publish_at LIMIT 10`,
    now.toISOString(),
  );
  for (const sp of due) {
    try {
      await publishScheduledPost(sp);
      actions.published++;
    } catch (err) {
      await run(`UPDATE scheduled_posts SET status = 'failed', error = $1, updated_at = now() WHERE id = $2`, String(err.message), sp.id);
    }
  }
  return actions;
}

export async function publishScheduledPost(sp) {
  // Claim the row first so two processes never publish the same question twice.
  const claimed = await run(
    `UPDATE scheduled_posts SET status = 'published', publish_at = LEAST(publish_at, now()), updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'approved')`,
    sp.id,
  );
  if (!claimed.rowCount) throw new Error('Already published or rejected');
  const persona = await getUserById(sp.persona_id);
  const forum = await getForumById(sp.forum_id);
  if (!persona || !forum) throw new Error('Persona or forum no longer exists');
  const { threadId, postId } = await createThread({ forum, user: persona, title: sp.title, body: sp.body, isSeeded: true });
  await run('UPDATE scheduled_posts SET thread_id = $1 WHERE id = $2', threadId, sp.id);
  const minDelay = await getNumber('seed_answer_delay_min_minutes');
  const maxDelay = Math.max(minDelay, await getNumber('seed_answer_delay_max_minutes'));
  await queueAiReplyIfNeeded({
    thread: await getThread(threadId),
    post: { id: postId },
    author: persona,
    delaySeconds: Math.round(rand(minDelay, maxDelay) * 60),
  });
  return threadId;
}

// ---------------------------------------------------------------------------
// Job: generate a batch of questions.
// ---------------------------------------------------------------------------

export async function runSeedGenerate(job) {
  const count = Math.max(1, Math.min(20, Number(job.payload.count) || 3));
  const forums = await seedableForums();
  const personas = await activePersonas();
  if (!forums.length) return { status: 'skipped', result: { reason: 'no forums enabled for daily posts' } };
  if (!personas.length) return { status: 'skipped', result: { reason: 'no active personas' } };

  // Prefer personas that have not posted recently.
  const recent = new Set(
    (await all(`SELECT persona_id FROM scheduled_posts WHERE created_at > now() - interval '3 days'`)).map((r) => r.persona_id),
  );
  const ordered = [...shuffle(personas.filter((p) => !recent.has(p.id))), ...shuffle(personas.filter((p) => recent.has(p.id)))];
  const hints = await takeTopicHints(Math.ceil(count * 0.6));

  const slots = Array.from({ length: count }, (_, i) => ({
    slot: i + 1,
    persona: ordered[i % ordered.length],
    forum: weightedForum(forums),
    hint: hints[i] || null,
  }));

  const recentTitles = (await all('SELECT title FROM threads WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 80')).map((r) => r.title);
  const prompt = `Write ${count} forum questions, one per slot below.

${slots
  .map((s) => {
    const p = parsePersona(s.persona);
    return `<slot number="${s.slot}">
Persona: ${s.persona.username} — ${p.job || 'IT professional'} at ${p.organization || 'a small business'}, ${s.persona.location || p.location || 'location not given'}. Experience: ${p.experience || 'intermediate'}. Writing style: ${p.writing_style || 'plain and clear'}.
Forum: ${s.forum.title} — ${s.forum.description}
Topic idea: ${s.hint || 'choose a realistic, specific question that fits this forum and persona'}
</slot>`;
  })
  .join('\n')}

Existing thread titles (do not duplicate):
${recentTitles.map((t) => `- ${t}`).join('\n') || '- (none yet)'}

Return one entry per slot, using the same slot numbers.`;

  const { data, usage, model } = await generateStructured({
    system: seedSystemPrompt(await getSetting('knowledge_base')),
    prompt,
    schema: SeedSchema,
    mock: () => ({
      posts: slots.map((s) => ({
        slot: s.slot,
        title: s.hint ? `Question about ${s.hint.toLowerCase()}`.slice(0, 120) : `How do I configure ${s.forum.title.toLowerCase()} for a ${10 + s.slot * 5} user office?`,
        body: `Hi all, I'm setting up OpenRings for our office (${10 + s.slot * 5} extensions). ${s.hint ? `Topic: ${s.hint}.` : ''} What is the recommended way to do this? Thanks in advance. *(Demo question, test mode.)*`,
      })),
    }),
  });

  const times = await publishTimes(count, localDate());
  const status = (await getBool('seed_require_approval')) ? 'pending' : 'approved';
  let created = 0;
  for (const s of slots) {
    const post = data.posts.find((p) => p.slot === s.slot);
    if (!post || post.title.trim().length < 8 || post.body.trim().length < 20) continue;
    await run(
      `INSERT INTO scheduled_posts (plan_date, forum_id, persona_id, title, body, topic_hint, status, publish_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      job.payload.date || localDate(), s.forum.id, s.persona.id, post.title.trim().slice(0, 150), post.body.trim(), s.hint, status, times[created],
    );
    created++;
  }
  return { status: 'done', result: { created, status, model, usage } };
}

// ---------------------------------------------------------------------------
// Follow-ups from the original poster on seeded threads.
// ---------------------------------------------------------------------------

/**
 * How many follow-ups this discussion gets: a number between the min and max settings, fixed per
 * thread (derived from its id), so it does not change between answers.
 */
export function followupTarget(threadId, min, max) {
  const lo = Math.max(0, Math.min(min, max));
  const hi = Math.max(lo, max);
  const spread = Math.imul(Number(threadId) | 0, 2654435761) >>> 0;
  return lo + (spread % (hi - lo + 1));
}

/** After an answer in a daily discussion: plan the sample member's next follow-up, if any. */
export async function maybeQueueSeedFollowup(thread) {
  const persona = await getUserById(thread.user_id);
  if (!persona || persona.role !== 'persona' || thread.is_locked) return null;
  const counts = await one(
    `SELECT COUNT(*) FILTER (WHERE u.role IN ('ai','support','admin')) AS answers,
            COUNT(*) FILTER (WHERE p.user_id = $2) - 1 AS followups
     FROM posts p JOIN users u ON u.id = p.user_id
     WHERE p.thread_id = $1 AND p.deleted_at IS NULL`,
    thread.id, thread.user_id,
  );
  const target = followupTarget(thread.id, await getNumber('seed_followups_min'), await getNumber('seed_followups_max'));
  if (counts.followups >= target) return null; // this discussion has had its follow-ups
  if (counts.answers !== counts.followups + 1) return null; // the latest follow-up is not answered yet
  if (counts.answers >= (await getNumber('ai_max_replies_per_thread'))) return null; // a new follow-up would go unanswered
  if (await hasQueuedJob('seed_followup', 'threadId', thread.id)) return null;
  const min = await getNumber('seed_followup_delay_min_minutes');
  const max = Math.max(min, await getNumber('seed_followup_delay_max_minutes'));
  return enqueueJob('seed_followup', { threadId: thread.id }, { delaySeconds: Math.round(rand(min, max) * 60) });
}

export async function runSeedFollowup(job) {
  const thread = await getThread(job.payload.threadId);
  if (!thread || thread.deleted_at || thread.is_locked) return { status: 'skipped', result: { reason: 'thread unavailable' } };
  const persona = await getUserById(thread.user_id);
  if (!persona || persona.role !== 'persona') return { status: 'skipped', result: { reason: 'thread not started by a persona' } };
  const posts = await threadTranscript(thread.id);
  if (!['ai', 'support', 'admin'].includes(posts[posts.length - 1]?.role)) return { status: 'skipped', result: { reason: 'someone else replied' } };

  const p = parsePersona(persona);
  const { data, usage, model } = await generateStructured({
    system: followupSystemPrompt(),
    prompt: `Member: ${persona.username} — ${p.job || 'IT professional'} at ${p.organization || 'a small business'}, ${persona.location}. Experience: ${p.experience || 'intermediate'}. Writing style: ${p.writing_style || 'plain'}.
Thread title: ${thread.title}

<thread>
${posts.map((x, i) => `[#${i + 1}] ${x.username}${['ai', 'support', 'admin'].includes(x.role) ? ' (support)' : ''}\n${x.body}`).join('\n\n')}
</thread>

Write ${persona.username}'s follow-up post.`,
    schema: FollowupSchema,
    mock: () => ({ body: 'We are on the latest version and the phones sit behind a standard office router. Which log should I check first? *(Demo follow-up, test mode.)*' }),
  });
  if (!data.body.trim()) return { status: 'skipped', result: { reason: 'empty follow-up' } };
  const postId = await createPost({ thread, user: persona, body: data.body.trim() });
  const minDelay = await getNumber('seed_answer_delay_min_minutes');
  const maxDelay = Math.max(minDelay, await getNumber('seed_answer_delay_max_minutes'));
  await queueAiReplyIfNeeded({ thread: await getThread(thread.id), post: { id: postId }, author: persona, delaySeconds: Math.round(rand(minDelay, maxDelay) * 60) });
  return { status: 'done', result: { postId, model, usage } };
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export async function createPersona({ username, location = '', job = '', organization = '', experience = 'intermediate', writing_style = '', bio = '' }) {
  if (!USERNAME_RE.test(username)) throw new Error(`Invalid username "${username}"`);
  // Spread join dates over the past months so the member list looks natural.
  const joined = new Date(Date.now() - rand(20, 400) * 86400_000).toISOString();
  return createUser({
    username,
    role: 'persona',
    bio,
    location,
    createdAt: joined,
    personaJson: JSON.stringify({ job, organization, experience, writing_style }),
  });
}

export async function generatePersonas(count = 5) {
  const existing = (await all('SELECT username FROM users')).map((r) => r.username.toLowerCase());
  const { data } = await generateStructured({
    system: personaSystemPrompt(),
    prompt: `Create ${count} new member profiles. These usernames are already taken: ${existing.slice(-200).join(', ') || 'none'}.`,
    schema: PersonaSchema,
    mock: () => ({
      personas: Array.from({ length: count }, (_, i) => ({
        username: `demo_user${Date.now() % 10000}${i}`,
        location: 'Singapore',
        job: 'IT administrator',
        organization: 'a 30-person logistics company',
        experience: 'intermediate',
        writing_style: 'short and direct',
        bio: 'I look after IT for a small logistics firm.',
      })),
    }),
  });
  const created = [];
  for (const p of data.personas) {
    const name = p.username.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24);
    if (!USERNAME_RE.test(name) || existing.includes(name.toLowerCase())) continue;
    created.push(await createPersona({ ...p, username: name }));
    existing.push(name.toLowerCase());
  }
  return created;
}
