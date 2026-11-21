import { z } from 'zod';
import { val, one } from '../db.js';
import { config } from '../config.js';
import { aiConfigured } from '../services/ai-settings.js';
import { generateStructured } from './client.js';
import { assistantSystemPrompt } from './prompts.js';
import { getSetting, getBool, getNumber } from '../services/settings.js';
import { enqueueJob, hasQueuedJob } from '../services/jobs.js';
import { ensureAiUser, pickOnDutyEngineer } from '../services/users.js';
import { getThread, getForumById, threadTranscript, createPost, relatedThreads } from '../services/forum.js';
import { saveDraft, pendingDraftForThread } from '../services/drafts.js';
import { isStaff, threadPath, formatDateTime } from '../lib/format.js';

const ReplySchema = z.object({
  should_reply: z.boolean(),
  reply_markdown: z.string(),
});

const MAX_TRANSCRIPT_CHARS = 200_000;
const ANSWER_ROLES = ['ai', 'support', 'admin'];

export const REPLY_MODES = ['review', 'review_fallback', 'auto'];
export const replyMode = async () => {
  const m = await getSetting('reply_mode');
  return REPLY_MODES.includes(m) ? m : 'review';
};
const isReview = (mode) => mode === 'review' || mode === 'review_fallback';

/** A random wait between the min and max delay settings (seconds). */
async function replyDelaySeconds() {
  const min = await getNumber('ai_reply_delay_seconds');
  const max = Math.max(min, await getNumber('ai_reply_delay_max_seconds'));
  return Math.round(min + Math.random() * (max - min));
}

const firstPostId = (threadId) => val('SELECT MIN(id) FROM posts WHERE thread_id = $1 AND deleted_at IS NULL', threadId);
/** Answers from the support side: automated posts plus staff posts. */
const answerCount = (threadId) =>
  val(
    `SELECT COUNT(*) FROM posts p JOIN users u ON u.id = p.user_id
     WHERE p.thread_id = $1 AND p.deleted_at IS NULL AND u.role = ANY($2)`,
    threadId, ANSWER_ROLES,
  );
const staffHasPosted = async (threadId) =>
  !!(await one(
    `SELECT 1 FROM posts p JOIN users u ON u.id = p.user_id
     WHERE p.thread_id = $1 AND p.deleted_at IS NULL AND u.role IN ('admin','support') LIMIT 1`,
    threadId,
  ));

/**
 * Called after any new post. Queues an answer (a draft in review mode) when the rules allow it.
 * Returns the job id, or null when nothing was queued.
 */
export async function queueAiReplyIfNeeded({ thread, post, author, force = false, delaySeconds = null }) {
  if (!(await aiConfigured())) return null;
  if (author.role === 'ai') return null;
  if (!force) {
    if (!(await getBool('ai_autoreply_enabled'))) return null;
    if (isStaff(author)) return null;
    if (!thread.ai_enabled || thread.is_locked) return null;
    const forum = await getForumById(thread.forum_id);
    if (!forum?.ai_enabled) return null;
    const isFirstPost = post.id === (await firstPostId(thread.id));
    if (!isFirstPost) {
      if (!(await getBool('ai_followups_enabled'))) return null;
      if ((await answerCount(thread.id)) >= (await getNumber('ai_max_replies_per_thread'))) return null;
      // In auto mode, automated answers step back once a person from support has joined.
      if ((await replyMode()) === 'auto' && (await getBool('ai_stop_when_staff_replies')) && (await staffHasPosted(thread.id))) return null;
    }
  }
  if (await hasQueuedJob('ai_reply', 'threadId', thread.id)) return null;
  const delay = delaySeconds ?? (await replyDelaySeconds());
  return enqueueJob('ai_reply', { threadId: thread.id, triggerPostId: post.id, force }, { delaySeconds: delay });
}

function buildTranscript(posts, team) {
  const label = (p) => (p.role === 'ai' ? 'automated answer' : p.role === 'support' || p.role === 'admin' ? team : 'member');
  const blocks = posts.map((p, i) => `[#${i + 1}] ${p.username} (${label(p)}) · ${formatDateTime(p.created_at)}\n${p.body.trim()}`);
  let text = blocks.join('\n\n');
  if (text.length > MAX_TRANSCRIPT_CHARS && blocks.length > 3) {
    // Keep the opening post and as many of the latest posts as fit; say so explicitly.
    const head = blocks[0];
    const tail = [];
    let size = head.length;
    for (let i = blocks.length - 1; i > 0 && size + blocks[i].length < MAX_TRANSCRIPT_CHARS; i--) {
      tail.unshift(blocks[i]);
      size += blocks[i].length;
    }
    const omitted = blocks.length - 1 - tail.length;
    text = [head, `[… ${omitted} earlier posts omitted for length …]`, ...tail].join('\n\n');
  }
  return text;
}

export async function buildReplyPrompt(thread, forum, posts, { mode, team }) {
  const related = await relatedThreads(thread, 4);
  const relatedText = related.length
    ? `\n\nRelated discussions in this community. Link to one only if it really helps, using the full URL:\n${related
        .map((t) => `- ${t.title} — ${config.siteUrl}${config.basePath}${threadPath(t)}`)
        .join('\n')}`
    : '';
  const last = posts[posts.length - 1];
  const who = isReview(mode) ? `a draft reply for a ${team} engineer to review and post` : 'the automated answer';
  return `Forum: ${forum.title}${forum.description ? ` — ${forum.description}` : ''}
Thread title: ${thread.title}

<thread>
${buildTranscript(posts, team)}
</thread>${relatedText}

Write ${who}. Respond to the latest post (#${posts.length} by ${last.username}) and take the whole thread into account.`;
}

function mockReply(thread, posts) {
  const last = posts[posts.length - 1];
  if (/^\s*(thanks|thank you|solved|fixed)/i.test(last.body)) return { should_reply: false, reply_markdown: '' };
  return {
    should_reply: true,
    reply_markdown: `Thanks for the details, @${last.username}. *(Demo text, test mode.)*\n\nFor **${thread.title}**, start with these checks:\n\n1. Confirm the extension or trunk shows as registered: \`or_cli -x "show registrations"\`.\n2. Check NAT / external IP settings, and that SIP (\`5060\`) and RTP (\`16384-32768/udp\`) are open.\n3. Reproduce the issue and capture the SIP log.\n\nIf it still fails, post your version and the relevant log lines and we'll dig in. The quick start guide is here: ${config.docsUrl}`,
  };
}

/** Job handler: write an answer, then save it as a draft (review mode) or post it (auto mode). */
export async function runAiReply(job) {
  const { threadId, force } = job.payload;
  const thread = await getThread(threadId);
  if (!thread || thread.deleted_at) return { status: 'skipped', result: { reason: 'thread deleted' } };
  if (!force && (!thread.ai_enabled || thread.is_locked)) return { status: 'skipped', result: { reason: 'answers disabled or thread locked' } };

  const mode = await replyMode();
  const team = await getSetting('support_team_name');
  const posts = await threadTranscript(threadId);
  if (!posts.length) return { status: 'skipped', result: { reason: 'no posts' } };
  const last = posts[posts.length - 1];
  if (ANSWER_ROLES.includes(last.role)) return { status: 'skipped', result: { reason: 'the latest post is already an answer' } };
  if (!force && mode === 'auto' && (await getBool('ai_stop_when_staff_replies')) && posts.some((p) => p.role === 'admin' || p.role === 'support')) {
    return { status: 'skipped', result: { reason: 'staff are handling this thread' } };
  }

  const forum = await getForumById(thread.forum_id);
  const { data, usage, model } = await generateStructured({
    system: assistantSystemPrompt(await getSetting('knowledge_base'), { mode, team }),
    prompt: await buildReplyPrompt(thread, forum, posts, { mode, team }),
    schema: ReplySchema,
    mock: () => mockReply(thread, posts),
  });

  if (!data.should_reply || !data.reply_markdown.trim()) {
    return { status: 'skipped', result: { reason: 'no reply needed', model, usage } };
  }

  // Re-check the thread still exists (the AI call can take a while).
  const fresh = await getThread(threadId);
  if (!fresh || fresh.deleted_at) return { status: 'skipped', result: { reason: 'thread deleted meanwhile' } };
  const body = data.reply_markdown.trim();

  if (isReview(mode)) {
    const existing = await pendingDraftForThread(threadId);
    const assignee = existing ? { id: existing.assigned_to } : await pickOnDutyEngineer();
    const draftId = await saveDraft({ threadId, replyToPostId: last.id, body, assignedTo: assignee?.id ?? null, model });
    // With the fallback option, a draft nobody reviews in time is posted as an automated answer.
    if (mode === 'review_fallback' && !(await hasQueuedJob('draft_fallback', 'draftId', draftId))) {
      const minutes = Math.max(1, await getNumber('review_fallback_minutes'));
      await enqueueJob('draft_fallback', { draftId }, { delaySeconds: minutes * 60 });
    }
    return { status: 'done', result: { draftId, assignedTo: assignee?.id ?? null, model, usage } };
  }

  const assistant = await ensureAiUser();
  const postId = await createPost({ thread: fresh, user: assistant, body, isAi: true });
  await afterSupportAnswer(fresh);
  return { status: 'done', result: { postId, model, usage } };
}

/** Job handler: a draft nobody reviewed in time is posted from the automated account. */
export async function runDraftFallback(job) {
  const { getDraft } = await import('../services/drafts.js');
  const draft = await getDraft(job.payload.draftId);
  if (!draft || draft.status !== 'pending') return { status: 'skipped', result: { reason: 'draft already reviewed' } };
  const mode = await replyMode();
  if (mode !== 'review_fallback' && mode !== 'auto') return { status: 'skipped', result: { reason: 'automatic posting is turned off' } };
  const thread = await getThread(draft.thread_id);
  if (!thread || thread.deleted_at || thread.is_locked) return { status: 'skipped', result: { reason: 'thread unavailable' } };
  const posts = await threadTranscript(thread.id);
  if (ANSWER_ROLES.includes(posts[posts.length - 1]?.role)) return { status: 'skipped', result: { reason: 'already answered' } };

  const assistant = await ensureAiUser();
  const { postDraft } = await import('../services/drafts.js');
  const { postId } = await postDraft(draft, { body: draft.body, postAsId: assistant.id, reviewer: null, allowAutomated: true });
  await afterSupportAnswer(thread);
  return { status: 'done', result: { postId, postedAs: 'automated' } };
}

/**
 * After switching to an automatic mode, drafts already waiting in the Support inbox get posted:
 * right away in "auto", after the review time in "review_fallback".
 */
export async function scheduleWaitingDrafts(mode) {
  if (mode !== 'auto' && mode !== 'review_fallback') return 0;
  const { all: allRows } = await import('../db.js');
  const waiting = await allRows(`SELECT id FROM reply_drafts WHERE status = 'pending'`);
  const minutes = mode === 'auto' ? 0 : Math.max(1, await getNumber('review_fallback_minutes'));
  let n = 0;
  for (const d of waiting) {
    if (await hasQueuedJob('draft_fallback', 'draftId', d.id)) continue;
    await enqueueJob('draft_fallback', { draftId: d.id }, { delaySeconds: minutes * 60 + n * 5 });
    n++;
  }
  return n;
}

/** Called after the support side answered (automated post or a posted draft). */
export async function afterSupportAnswer(thread) {
  if (thread.is_seeded) {
    // Seeded discussions sometimes get a natural follow-up from the original poster.
    const { maybeQueueSeedFollowup } = await import('./seeder.js');
    await maybeQueueSeedFollowup(thread);
  }
}

/** Staff "Generate draft reply" action. */
export function forceAiReply(thread, requestedBy) {
  return queueAiReplyIfNeeded({ thread, post: { id: thread.last_post_id }, author: requestedBy, force: true, delaySeconds: 0 });
}
