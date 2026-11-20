import express from 'express';
import * as forum from '../services/forum.js';
import { queueAiReplyIfNeeded, forceAiReply, replyMode } from '../ai/responder.js';
import { discardPendingForThread } from '../services/drafts.js';
import { getSetting } from '../services/settings.js';
import { renderMarkdown } from '../lib/markdown.js';
import { isStaff, threadPath } from '../lib/format.js';
import { requireUser, requireStaff, limit } from './guards.js';
import { getUserById } from '../services/users.js';

const router = express.Router();
const intParam = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : 0);

const threadUrl = (res, thread, postId = null, page = 1) =>
  res.locals.url(threadPath(thread) + (page > 1 ? `?page=${page}` : '') + (postId ? `#post-${postId}` : ''));

async function postableForums(user) {
  return (await forum.listForums()).filter((f) => !f.staff_only || isStaff(user));
}

router.get('/post-thread', requireUser, async (req, res) => {
  const selected = req.query.forum ? await forum.getForumBySlug(String(req.query.forum)) : null;
  res.locals.meta.title = 'Ask a question';
  res.locals.meta.noindex = true;
  res.render('post-thread', { forums: await postableForums(req.user), values: { forum_id: selected?.id || '' }, errors: [] });
});

router.post('/post-thread', requireUser, limit('thread', 5, 10 * 60_000), async (req, res) => {
  const values = {
    forum_id: intParam(req.body.forum_id),
    title: String(req.body.title || '').trim(),
    body: String(req.body.body || ''),
  };
  const f = await forum.getForumById(values.forum_id);
  const errors = forum.validateThreadInput(values);
  if (!f) errors.unshift('Choose a forum for your question.');
  else if (f.staff_only && !isStaff(req.user)) errors.unshift('Only staff can post in that forum.');
  if (req.body.website_url) errors.push('Posting failed.');
  if (errors.length) {
    res.locals.meta.noindex = true;
    return res.status(400).render('post-thread', { forums: await postableForums(req.user), values, errors });
  }
  const { threadId, postId } = await forum.createThread({ forum: f, user: req.user, title: values.title, body: values.body });
  const thread = await forum.getThread(threadId);
  const queued = await queueAiReplyIfNeeded({ thread, post: { id: postId }, author: req.user });
  if (isStaff(req.user)) {
    res.flash('info', 'Posted. Questions from staff accounts do not get a draft reply automatically. To get one, open Staff tools on this thread and click “Generate draft reply”, or ask from a member account.');
  } else if (queued) {
    const team = await getSetting('support_team_name');
    res.flash('info', (await replyMode()) !== 'auto'
      ? `Thanks for posting! A ${team} engineer will reply here soon.`
      : 'Thanks for posting! A reply will appear below in a moment, no need to refresh.');
  }
  res.redirect(threadUrl(res, thread));
});

async function loadThread(req, res, next) {
  const thread = await forum.getThread(intParam(req.params.id));
  if (!thread || thread.deleted_at) return res.status(404).render('error', { status: 404, message: 'Thread not found.' });
  req.thread = thread;
  next();
}

async function loadPost(req, res, next) {
  const post = await forum.getPost(intParam(req.params.id));
  if (!post || post.deleted_at) return res.status(404).render('error', { status: 404, message: 'Post not found.' });
  req.post = post;
  req.thread = await forum.getThread(post.thread_id);
  if (!req.thread || req.thread.deleted_at) return res.status(404).render('error', { status: 404, message: 'Thread not found.' });
  next();
}

router.post('/threads/:id/reply', requireUser, loadThread, limit('reply', 20, 10 * 60_000), async (req, res) => {
  const { thread } = req;
  if (thread.is_locked && !isStaff(req.user)) {
    return res.status(403).render('error', { status: 403, message: 'This thread is locked.' });
  }
  const body = String(req.body.body || '');
  const errors = forum.validatePostBody(body);
  if (errors.length) {
    res.flash('error', errors.join(' '));
    return res.redirect(threadUrl(res, thread));
  }
  const postId = await forum.createPost({ thread, user: req.user, body });
  // A staff member answered by hand, so any waiting draft is out of date.
  if (isStaff(req.user)) await discardPendingForThread(thread.id, req.user);
  await queueAiReplyIfNeeded({ thread: await forum.getThread(thread.id), post: { id: postId }, author: req.user });
  const page = await forum.postPage(await forum.getPost(postId));
  res.redirect(threadUrl(res, thread, postId, page));
});

router.post('/threads/:id/moderate', requireUser, requireStaff, loadThread, async (req, res) => {
  const { thread } = req;
  const action = String(req.body.action || '');
  const flags = {
    pin: ['is_pinned', 1], unpin: ['is_pinned', 0],
    lock: ['is_locked', 1], unlock: ['is_locked', 0],
    ai_on: ['ai_enabled', 1], ai_off: ['ai_enabled', 0],
  };
  if (flags[action]) {
    await forum.setThreadFlag(thread.id, ...flags[action]);
    res.flash('success', 'Thread updated.');
  } else if (action === 'ai_reply_now') {
    const job = await forceAiReply(thread, req.user);
    const review = (await replyMode()) !== 'auto';
    res.flash('info', job
      ? (review ? 'Writing a draft reply. It will appear in the Support inbox in a minute.' : 'An automated answer will appear in a minute.')
      : 'A reply is already being written, or the answer writer is not configured.');
  } else if (action === 'move') {
    const target = await forum.getForumById(intParam(req.body.forum_id));
    if (target && target.id !== thread.forum_id) {
      await forum.moveThread(thread, target.id);
      res.flash('success', `Moved to ${target.title}.`);
    }
  } else if (action === 'rename') {
    const title = String(req.body.title || '').trim();
    if (title.length >= 8 && title.length <= 150) await forum.renameThread(thread.id, title);
  } else if (action === 'delete') {
    await forum.deleteThread(thread);
    res.flash('success', 'Thread deleted.');
    return res.redirect(res.locals.url(`/forums/${thread.forum_slug}/`));
  }
  res.redirect(threadUrl(res, await forum.getThread(thread.id)));
});

router.get('/posts/:id/edit', requireUser, loadPost, (req, res) => {
  if (req.post.user_id !== req.user.id && !isStaff(req.user)) {
    return res.status(403).render('error', { status: 403, message: 'You can only edit your own posts.' });
  }
  res.locals.meta.title = 'Edit post';
  res.locals.meta.noindex = true;
  res.render('edit-post', { post: req.post, thread: req.thread, errors: [] });
});

router.post('/posts/:id/edit', requireUser, loadPost, async (req, res) => {
  const { post, thread } = req;
  if (post.user_id !== req.user.id && !isStaff(req.user)) {
    return res.status(403).render('error', { status: 403, message: 'You can only edit your own posts.' });
  }
  const body = String(req.body.body || '');
  const errors = forum.validatePostBody(body);
  if (errors.length) return res.status(400).render('edit-post', { post: { ...post, body }, thread, errors });
  await forum.editPost(post, body, await getUserById(post.user_id));
  res.flash('success', 'Post updated.');
  res.redirect(threadUrl(res, thread, post.id, await forum.postPage(post)));
});

router.post('/posts/:id/delete', requireUser, requireStaff, loadPost, async (req, res) => {
  const kind = await forum.deletePost(req.post);
  res.flash('success', kind === 'thread' ? 'Thread deleted.' : 'Post deleted.');
  if (kind === 'thread') return res.redirect(res.locals.url(`/forums/${req.thread.forum_slug}/`));
  res.redirect(threadUrl(res, req.thread));
});

router.post('/posts/:id/like', requireUser, limit('like', 60, 60_000), loadPost, async (req, res) => {
  const wantsJson = req.get('accept')?.includes('application/json');
  if (req.post.user_id === req.user.id) {
    if (wantsJson) return res.status(400).json({ error: 'You cannot like your own post.' });
    res.flash('error', 'You cannot like your own post.');
    return res.redirect(threadUrl(res, req.thread, req.post.id, await forum.postPage(req.post)));
  }
  const result = await forum.toggleLike(req.post, req.user.id);
  if (wantsJson) return res.json(result);
  res.redirect(threadUrl(res, req.thread, req.post.id, await forum.postPage(req.post)));
});

router.post('/posts/:id/solution', requireUser, loadPost, async (req, res) => {
  const { thread, post } = req;
  if (thread.user_id !== req.user.id && !isStaff(req.user)) {
    return res.status(403).render('error', { status: 403, message: 'Only the person who asked, or staff, can choose the solution.' });
  }
  const unset = thread.solution_post_id === post.id;
  await forum.markSolution(thread, unset ? null : post.id);
  res.flash('success', unset ? 'Solution removed.' : 'Marked as the solution. Thanks for closing the loop!');
  res.redirect(threadUrl(res, thread, post.id, await forum.postPage(post)));
});

router.post('/preview', requireUser, limit('preview', 60, 60_000), (req, res) => {
  res.json({ html: renderMarkdown(String(req.body?.body || '').slice(0, 30000), { trusted: isStaff(req.user) }) });
});

export default router;
