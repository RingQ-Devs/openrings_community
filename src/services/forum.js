import { one, all, val, run, tx } from '../db.js';
import { renderMarkdown, plainExcerpt } from '../lib/markdown.js';
import { slugify, isStaff } from '../lib/format.js';

export const THREADS_PER_PAGE = 25;
export const POSTS_PER_PAGE = 20;

const trustedAuthor = (user) => isStaff(user) || user?.role === 'ai';

// ---- categories & forums ----------------------------------------------------

export async function listCategoriesWithForums() {
  const categories = await all('SELECT * FROM categories ORDER BY sort_order, id');
  const forums = await all(
    `SELECT f.*, t.id AS last_thread_id, t.title AS last_thread_title, t.slug AS last_thread_slug,
            t.last_post_at AS last_post_at, u.username AS last_username, u.role AS last_role
     FROM forums f
     LEFT JOIN LATERAL (
       SELECT id, title, slug, last_post_at, last_post_user_id FROM threads
       WHERE forum_id = f.id AND deleted_at IS NULL ORDER BY last_post_at DESC LIMIT 1) t ON true
     LEFT JOIN users u ON u.id = t.last_post_user_id
     ORDER BY f.sort_order, f.id`,
  );
  return categories.map((c) => ({ ...c, forums: forums.filter((f) => f.category_id === c.id) }));
}

export const listForums = () =>
  all(
    `SELECT f.*, c.title AS category_title FROM forums f JOIN categories c ON c.id = f.category_id
     ORDER BY c.sort_order, c.id, f.sort_order, f.id`,
  );
export const getForumBySlug = (slug) => one('SELECT * FROM forums WHERE slug = $1', slug);
export const getForumById = (id) => one('SELECT * FROM forums WHERE id = $1', id);
export const getCategory = (id) => one('SELECT * FROM categories WHERE id = $1', id);
export const listCategories = () => all('SELECT * FROM categories ORDER BY sort_order, id');

export function createCategory({ title, description = '', sort_order = 0 }) {
  return val('INSERT INTO categories (title, description, sort_order) VALUES ($1, $2, $3) RETURNING id', title, description, sort_order);
}

export async function updateCategory(id, { title, description, sort_order }) {
  await run('UPDATE categories SET title = $1, description = $2, sort_order = $3 WHERE id = $4', title, description, sort_order, id);
}

export async function deleteCategory(id) {
  if (await val('SELECT COUNT(*) FROM forums WHERE category_id = $1', id)) {
    throw new Error('Move or delete the forums in this category first.');
  }
  await run('DELETE FROM categories WHERE id = $1', id);
}

export async function uniqueForumSlug(base, exceptId = 0) {
  let slug = slugify(base, 60);
  let n = 2;
  while (await one('SELECT 1 FROM forums WHERE slug = $1 AND id <> $2', slug, exceptId)) slug = `${slugify(base, 56)}-${n++}`;
  return slug;
}

export async function createForum(f) {
  const slug = await uniqueForumSlug(f.slug || f.title);
  return val(
    `INSERT INTO forums (category_id, slug, title, description, icon, sort_order, staff_only, ai_enabled, seed_weight)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    f.category_id, slug, f.title, f.description || '', f.icon || 'chat', f.sort_order || 0, f.staff_only ? 1 : 0,
    f.ai_enabled === undefined ? 1 : f.ai_enabled ? 1 : 0, f.seed_weight ?? 1,
  );
}

export async function updateForum(id, f) {
  const slug = await uniqueForumSlug(f.slug || f.title, id);
  await run(
    `UPDATE forums SET category_id = $1, slug = $2, title = $3, description = $4, icon = $5, sort_order = $6,
       staff_only = $7, ai_enabled = $8, seed_weight = $9 WHERE id = $10`,
    f.category_id, slug, f.title, f.description || '', f.icon || 'chat', f.sort_order || 0, f.staff_only ? 1 : 0,
    f.ai_enabled ? 1 : 0, f.seed_weight ?? 0, id,
  );
}

export async function recountForum(forumId) {
  await run(
    `UPDATE forums SET
       thread_count = (SELECT COUNT(*) FROM threads WHERE forum_id = $1 AND deleted_at IS NULL),
       post_count = (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id
                     WHERE t.forum_id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL)
     WHERE id = $1`,
    forumId,
  );
}

async function recountThread(threadId) {
  const last = await one(
    'SELECT id, user_id, created_at FROM posts WHERE thread_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
    threadId,
  );
  const count = await val('SELECT COUNT(*) FROM posts WHERE thread_id = $1 AND deleted_at IS NULL', threadId);
  await run(
    'UPDATE threads SET reply_count = $1, last_post_id = $2, last_post_at = $3, last_post_user_id = $4 WHERE id = $5',
    Math.max(0, count - 1), last?.id ?? null, last?.created_at ?? null, last?.user_id ?? null, threadId,
  );
}

async function recountUser(userId) {
  await run(
    `UPDATE users SET
       post_count = (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id
                     WHERE p.user_id = $1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL),
       like_count = (SELECT COALESCE(SUM(p.like_count), 0) FROM posts p WHERE p.user_id = $1 AND p.deleted_at IS NULL)
     WHERE id = $1`,
    userId,
  );
}

// ---- threads ------------------------------------------------------------------

const threadSelect = `
  SELECT t.id, t.forum_id, t.user_id, t.title, t.slug, t.is_pinned, t.is_locked, t.is_solved, t.solution_post_id,
         t.ai_enabled, t.is_seeded, t.view_count, t.reply_count, t.last_post_id, t.last_post_at, t.last_post_user_id,
         t.created_at, t.deleted_at,
         u.username AS author_username, u.role AS author_role,
         lu.username AS last_username, lu.role AS last_role,
         f.slug AS forum_slug, f.title AS forum_title
  FROM threads t
  JOIN users u ON u.id = t.user_id
  JOIN forums f ON f.id = t.forum_id
  LEFT JOIN users lu ON lu.id = t.last_post_user_id`;

export function listThreads(forumId, { page = 1, perPage = THREADS_PER_PAGE } = {}) {
  return all(
    `${threadSelect} WHERE t.forum_id = $1 AND t.deleted_at IS NULL
     ORDER BY t.is_pinned DESC, t.last_post_at DESC LIMIT $2 OFFSET $3`,
    forumId, perPage, (page - 1) * perPage,
  );
}

export function latestThreads({ limit = 25, offset = 0, unanswered = false } = {}) {
  const extra = unanswered ? 'AND t.reply_count = 0' : '';
  return all(`${threadSelect} WHERE t.deleted_at IS NULL ${extra} ORDER BY t.last_post_at DESC LIMIT $1 OFFSET $2`, limit, offset);
}

export const countAllThreads = ({ unanswered = false } = {}) =>
  val(`SELECT COUNT(*) FROM threads WHERE deleted_at IS NULL ${unanswered ? 'AND reply_count = 0' : ''}`);

export const getThread = (id) => one(`${threadSelect} WHERE t.id = $1`, id);

export function userThreads(userId, limit = 20) {
  return all(`${threadSelect} WHERE t.user_id = $1 AND t.deleted_at IS NULL ORDER BY t.created_at DESC LIMIT $2`, userId, limit);
}

export function validateThreadInput({ title, body }) {
  const errors = [];
  if (!title || title.trim().length < 8) errors.push('Title must be at least 8 characters.');
  if (title && title.length > 150) errors.push('Title must be 150 characters or fewer.');
  errors.push(...validatePostBody(body));
  return errors;
}

export function validatePostBody(body) {
  const errors = [];
  if (!body || body.trim().length < 2) errors.push('Message cannot be empty.');
  if (body && body.length > 30000) errors.push('Message is too long (30,000 characters max).');
  return errors;
}

const insertPost = ({ threadId, user, body, isAi, at }) =>
  val(
    'INSERT INTO posts (thread_id, user_id, body, body_html, is_ai, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    threadId, user.id, body, renderMarkdown(body, { trusted: trustedAuthor(user) }), isAi ? 1 : 0, at,
  );

export function createThread({ forum, user, title, body, isSeeded = false, createdAt = null }) {
  return tx(async () => {
    const at = createdAt || new Date().toISOString();
    const cleanTitle = title.trim().replace(/\s+/g, ' ');
    const threadId = await val(
      `INSERT INTO threads (forum_id, user_id, title, slug, is_seeded, created_at, last_post_at, last_post_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $2) RETURNING id`,
      forum.id, user.id, cleanTitle, slugify(cleanTitle), isSeeded ? 1 : 0, at,
    );
    const postId = await insertPost({ threadId, user, body, isAi: false, at });
    await run('UPDATE threads SET last_post_id = $1 WHERE id = $2', postId, threadId);
    await run('UPDATE forums SET thread_count = thread_count + 1, post_count = post_count + 1 WHERE id = $1', forum.id);
    await run('UPDATE users SET post_count = post_count + 1 WHERE id = $1', user.id);
    return { threadId, postId };
  });
}

export function createPost({ thread, user, body, isAi = false }) {
  return tx(async () => {
    const at = new Date().toISOString();
    const postId = await insertPost({ threadId: thread.id, user, body, isAi, at });
    await run(
      'UPDATE threads SET reply_count = reply_count + 1, last_post_id = $1, last_post_at = $2, last_post_user_id = $3 WHERE id = $4',
      postId, at, user.id, thread.id,
    );
    await run('UPDATE forums SET post_count = post_count + 1 WHERE id = $1', thread.forum_id);
    await run('UPDATE users SET post_count = post_count + 1 WHERE id = $1', user.id);
    return postId;
  });
}

export function listPosts(threadId, { page = 1, perPage = POSTS_PER_PAGE, viewerId = 0 } = {}) {
  return all(
    `SELECT p.id, p.thread_id, p.user_id, p.body, p.body_html, p.is_ai, p.like_count, p.created_at, p.updated_at,
            u.username, u.role, u.title AS user_title, u.created_at AS user_joined, u.post_count AS user_post_count,
            u.like_count AS user_like_count, u.location AS user_location,
            EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked
     FROM posts p JOIN users u ON u.id = p.user_id
     WHERE p.thread_id = $2 AND p.deleted_at IS NULL
     ORDER BY p.id LIMIT $3 OFFSET $4`,
    viewerId, threadId, perPage, (page - 1) * perPage,
  );
}

/** Posts after a given post id (live updates on the thread page), with their position in the thread. */
export function listPostsAfter(threadId, afterId, viewerId = 0, limit = 20) {
  return all(
    `SELECT p.id, p.thread_id, p.user_id, p.body, p.body_html, p.is_ai, p.like_count, p.created_at, p.updated_at,
            u.username, u.role, u.title AS user_title, u.created_at AS user_joined, u.post_count AS user_post_count,
            u.like_count AS user_like_count, u.location AS user_location,
            EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked,
            (SELECT COUNT(*) FROM posts x WHERE x.thread_id = p.thread_id AND x.deleted_at IS NULL AND x.id <= p.id) AS position
     FROM posts p JOIN users u ON u.id = p.user_id
     WHERE p.thread_id = $2 AND p.deleted_at IS NULL AND p.id > $3
     ORDER BY p.id LIMIT $4`,
    viewerId, threadId, afterId, limit,
  );
}

/** All posts of a thread in order (used to build AI context). */
export function threadTranscript(threadId) {
  return all(
    `SELECT p.id, p.body, p.is_ai, p.created_at, p.user_id, u.username, u.role
     FROM posts p JOIN users u ON u.id = p.user_id
     WHERE p.thread_id = $1 AND p.deleted_at IS NULL ORDER BY p.id`,
    threadId,
  );
}

const postCols = 'id, thread_id, user_id, body, body_html, is_ai, like_count, created_at, updated_at, deleted_at';
export const getPost = (id) => one(`SELECT ${postCols} FROM posts WHERE id = $1`, id);

export function firstPost(threadId) {
  return one(`SELECT ${postCols} FROM posts WHERE thread_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1`, threadId);
}

export async function postPage(post) {
  const position = await val(
    'SELECT COUNT(*) FROM posts WHERE thread_id = $1 AND deleted_at IS NULL AND id <= $2',
    post.thread_id, post.id,
  );
  return Math.max(1, Math.ceil(position / POSTS_PER_PAGE));
}

export async function editPost(post, body, author) {
  await run(
    'UPDATE posts SET body = $1, body_html = $2, updated_at = now() WHERE id = $3',
    body, renderMarkdown(body, { trusted: trustedAuthor(author) }), post.id,
  );
}

export async function deletePost(post) {
  const thread = await getThread(post.thread_id);
  const first = await firstPost(post.thread_id);
  if (first && first.id === post.id) return deleteThread(thread);
  await tx(async () => {
    await run('UPDATE posts SET deleted_at = now() WHERE id = $1', post.id);
    if (thread.solution_post_id === post.id) {
      await run('UPDATE threads SET solution_post_id = NULL, is_solved = 0 WHERE id = $1', thread.id);
    }
    await recountThread(thread.id);
    await recountForum(thread.forum_id);
    await recountUser(post.user_id);
  });
  return 'post';
}

export async function deleteThread(thread) {
  await tx(async () => {
    await run('UPDATE threads SET deleted_at = now() WHERE id = $1', thread.id);
    await recountForum(thread.forum_id);
    for (const { user_id } of await all('SELECT DISTINCT user_id FROM posts WHERE thread_id = $1', thread.id)) {
      await recountUser(user_id);
    }
  });
  return 'thread';
}

export async function moveThread(thread, forumId) {
  await tx(async () => {
    await run('UPDATE threads SET forum_id = $1 WHERE id = $2', forumId, thread.id);
    await recountForum(thread.forum_id);
    await recountForum(forumId);
  });
}

export async function setThreadFlag(threadId, flag, value) {
  if (!['is_pinned', 'is_locked', 'ai_enabled'].includes(flag)) throw new Error('bad flag');
  await run(`UPDATE threads SET ${flag} = $1 WHERE id = $2`, value ? 1 : 0, threadId);
}

export async function renameThread(threadId, title) {
  const clean = title.trim().replace(/\s+/g, ' ');
  await run('UPDATE threads SET title = $1, slug = $2 WHERE id = $3', clean, slugify(clean), threadId);
}

export async function markSolution(thread, postId) {
  await run('UPDATE threads SET solution_post_id = $1, is_solved = $2 WHERE id = $3', postId || null, postId ? 1 : 0, thread.id);
}

export function toggleLike(post, userId) {
  return tx(async () => {
    const removed = await run('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', post.id, userId);
    const delta = removed.rowCount ? -1 : 1;
    if (!removed.rowCount) await run('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', post.id, userId);
    await run('UPDATE users SET like_count = GREATEST(0, like_count + $1) WHERE id = $2', delta, post.user_id);
    const count = await val('UPDATE posts SET like_count = GREATEST(0, like_count + $1) WHERE id = $2 RETURNING like_count', delta, post.id);
    return { liked: delta > 0, count };
  });
}

export async function incrementViews(threadId) {
  await run('UPDATE threads SET view_count = view_count + 1 WHERE id = $1', threadId);
}

export async function forumStats() {
  return one(
    `SELECT
       (SELECT COUNT(*) FROM threads WHERE deleted_at IS NULL) AS threads,
       (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id WHERE p.deleted_at IS NULL AND t.deleted_at IS NULL) AS posts,
       (SELECT COUNT(*) FROM users WHERE role <> 'ai' AND is_banned = 0) AS members,
       (SELECT COUNT(*) FROM threads WHERE deleted_at IS NULL AND is_solved = 1) AS solved`,
  );
}

export async function userRecentPosts(userId, limit = 15) {
  const rows = await all(
    `SELECT p.id, p.body, p.created_at, p.is_ai, t.id AS thread_id, t.title AS thread_title, t.slug AS thread_slug,
            f.title AS forum_title, f.slug AS forum_slug
     FROM posts p JOIN threads t ON t.id = p.thread_id JOIN forums f ON f.id = t.forum_id
     WHERE p.user_id = $1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL
     ORDER BY p.id DESC LIMIT $2`,
    userId, limit,
  );
  return rows.map((p) => ({ ...p, excerpt: plainExcerpt(p.body, 220) }));
}

// ---- search (PostgreSQL full-text search) ------------------------------------------

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MARK_OPEN = '⟦';
const MARK_CLOSE = '⟧';

/**
 * anyTerm=false: all words must match (normal search box).
 * anyTerm=true:  any word may match (used for "similar threads").
 */
export async function search(q, { limit = 30, anyTerm = false } = {}) {
  const terms = String(q || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu);
  if (!terms) return [];
  const text = terms.slice(0, 12).join(anyTerm ? ' or ' : ' ');
  const rows = await all(
    `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS query),
     hits AS (
       SELECT DISTINCT ON (t.id) t.id AS thread_id, p.id AS post_id,
              ts_rank(t.title_search, q.query) * 4 + ts_rank(p.search, q.query) AS rank,
              p.body
       FROM threads t
       JOIN posts p ON p.thread_id = t.id AND p.deleted_at IS NULL
       CROSS JOIN q
       WHERE t.deleted_at IS NULL AND (t.title_search @@ q.query OR p.search @@ q.query)
       ORDER BY t.id, (p.search @@ q.query) DESC, p.id
     )
     SELECT h.thread_id, h.post_id, h.rank,
            ts_headline('english', h.body, q.query,
              'StartSel=${MARK_OPEN}, StopSel=${MARK_CLOSE}, MaxWords=35, MinWords=15, MaxFragments=1') AS snip
     FROM hits h CROSS JOIN q
     ORDER BY h.rank DESC LIMIT $2`,
    text, limit,
  );
  const results = [];
  for (const hit of rows) {
    const thread = await getThread(hit.thread_id);
    if (!thread) continue;
    const snippet = escapeHtml(hit.snip || '').replaceAll(MARK_OPEN, '<mark>').replaceAll(MARK_CLOSE, '</mark>');
    results.push({ thread, postId: hit.post_id, snippet });
  }
  return results;
}

export async function relatedThreads(thread, limit = 5) {
  const results = await search(thread.title, { limit: limit + 1, anyTerm: true });
  return results.map((r) => r.thread).filter((t) => t.id !== thread.id).slice(0, limit);
}

export async function sitemapEntries() {
  return {
    forums: await all('SELECT slug FROM forums ORDER BY id'),
    threads: await all('SELECT id, slug, last_post_at FROM threads WHERE deleted_at IS NULL ORDER BY last_post_at DESC LIMIT 45000'),
  };
}
