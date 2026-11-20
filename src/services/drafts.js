import { one, all, val, run, tx } from '../db.js';
import { createPost, getThread } from './forum.js';
import { getUserById } from './users.js';
import { isStaff } from '../lib/format.js';

/** Create the pending draft for a thread, or refresh it if one is already waiting. */
export async function saveDraft({ threadId, replyToPostId, body, assignedTo, model }) {
  const existing = await one(`SELECT id FROM reply_drafts WHERE thread_id = $1 AND status = 'pending'`, threadId);
  if (existing) {
    await run(
      'UPDATE reply_drafts SET body = $1, reply_to_post_id = $2, model = $3, updated_at = now() WHERE id = $4',
      body, replyToPostId, model, existing.id,
    );
    return existing.id;
  }
  return val(
    `INSERT INTO reply_drafts (thread_id, reply_to_post_id, body, assigned_to, model) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    threadId, replyToPostId, body, assignedTo, model,
  );
}

export const getDraft = (id) => one('SELECT * FROM reply_drafts WHERE id = $1', id);

export function pendingDraftForThread(threadId) {
  return one(`SELECT * FROM reply_drafts WHERE thread_id = $1 AND status = 'pending'`, threadId);
}

export function countPendingDrafts(userId = null) {
  return userId
    ? val(`SELECT COUNT(*) FROM reply_drafts WHERE status = 'pending' AND assigned_to = $1`, userId)
    : val(`SELECT COUNT(*) FROM reply_drafts WHERE status = 'pending'`);
}

export function listPendingDrafts({ assignedTo = null, viewerId = 0 } = {}) {
  return all(
    `SELECT d.*, t.title AS thread_title, t.slug AS thread_slug, t.is_seeded, t.reply_count, f.title AS forum_title,
            a.username AS assigned_username,
            rp.body AS reply_to_body, ru.username AS reply_to_username,
            fp.body AS first_body, fu.username AS first_username
     FROM reply_drafts d
     JOIN threads t ON t.id = d.thread_id AND t.deleted_at IS NULL
     JOIN forums f ON f.id = t.forum_id
     LEFT JOIN users a ON a.id = d.assigned_to
     LEFT JOIN posts rp ON rp.id = d.reply_to_post_id
     LEFT JOIN users ru ON ru.id = rp.user_id
     LEFT JOIN LATERAL (SELECT body, user_id FROM posts WHERE thread_id = t.id AND deleted_at IS NULL ORDER BY id LIMIT 1) fp ON true
     LEFT JOIN users fu ON fu.id = fp.user_id
     WHERE d.status = 'pending' AND ($1::int IS NULL OR d.assigned_to = $1)
     ORDER BY (d.assigned_to = $2) DESC NULLS LAST, d.created_at`,
    assignedTo, viewerId,
  );
}

export function recentPostedDrafts(limit = 20) {
  return all(
    `SELECT d.id, d.updated_at, d.thread_id, t.title AS thread_title, t.slug AS thread_slug, d.post_id,
            pa.username AS posted_as_username, rv.username AS reviewer_username
     FROM reply_drafts d JOIN threads t ON t.id = d.thread_id
     LEFT JOIN users pa ON pa.id = d.posted_as LEFT JOIN users rv ON rv.id = d.reviewed_by
     WHERE d.status = 'posted' ORDER BY d.updated_at DESC LIMIT $1`,
    limit,
  );
}

/**
 * A support engineer approves a draft: it is posted in the thread under `postAsId`
 * (a support or admin account), with the reviewer's edits.
 */
export async function postDraft(draft, { body, postAsId, reviewer, allowAutomated = false }) {
  const postAs = await getUserById(postAsId);
  const automated = allowAutomated && postAs?.role === 'ai';
  if (!postAs || (!isStaff(postAs) && !automated)) throw new Error('Choose a support engineer to post as.');
  const result = await tx(async () => {
    const claimed = await run(
      `UPDATE reply_drafts SET status = 'posted', posted_as = $1, reviewed_by = $2, body = $3, updated_at = now()
       WHERE id = $4 AND status = 'pending'`,
      postAs.id, reviewer?.id ?? null, body, draft.id,
    );
    if (!claimed.rowCount) throw new Error('This draft was already posted or discarded.');
    const thread = await getThread(draft.thread_id);
    if (!thread || thread.deleted_at) throw new Error('The thread no longer exists.');
    const postId = await createPost({ thread, user: postAs, body, isAi: automated });
    await run('UPDATE reply_drafts SET post_id = $1 WHERE id = $2', postId, draft.id);
    return { postId, thread };
  });
  return result;
}

export async function discardDraft(draft, reviewer) {
  await run(
    `UPDATE reply_drafts SET status = 'discarded', reviewed_by = $1, updated_at = now() WHERE id = $2 AND status = 'pending'`,
    reviewer?.id ?? null, draft.id,
  );
}

/** A staff member replied by hand: the waiting draft is out of date. */
export async function discardPendingForThread(threadId, reviewer) {
  await run(
    `UPDATE reply_drafts SET status = 'discarded', reviewed_by = $1, updated_at = now() WHERE thread_id = $2 AND status = 'pending'`,
    reviewer?.id ?? null, threadId,
  );
}
