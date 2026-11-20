import express from 'express';
import { requireUser, requireStaff } from './guards.js';
import { listPendingDrafts, getDraft, postDraft, discardDraft, recentPostedDrafts } from '../services/drafts.js';
import { listSupportStaff } from '../services/users.js';
import { validatePostBody, postPage, getPost } from '../services/forum.js';
import { queueAiReplyIfNeeded, afterSupportAnswer } from '../ai/responder.js';
import { getThread } from '../services/forum.js';
import { plainExcerpt } from '../lib/markdown.js';
import { threadPath } from '../lib/format.js';

const router = express.Router();
router.use(requireUser, requireStaff);
router.use((req, res, next) => {
  res.locals.meta.noindex = true;
  next();
});

const intParam = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : 0);

router.get('/inbox', async (req, res) => {
  const mine = req.query.view === 'mine';
  const drafts = await listPendingDrafts({ assignedTo: mine ? req.user.id : null, viewerId: req.user.id });
  res.locals.meta.title = 'Support inbox';
  res.render('support/inbox', {
    mine,
    drafts: drafts.map((d) => ({
      ...d,
      question: plainExcerpt(d.first_body, 600),
      latest: d.reply_to_body && d.reply_to_body !== d.first_body ? plainExcerpt(d.reply_to_body, 600) : null,
    })),
    staff: await listSupportStaff(),
    recent: await recentPostedDrafts(10),
  });
});

router.post('/drafts/:id', async (req, res) => {
  const draft = await getDraft(intParam(req.params.id));
  const back = (type, message) => {
    res.flash(type, message);
    res.redirect(res.locals.url('/support/inbox' + (req.body.view === 'mine' ? '?view=mine' : '')));
  };
  if (!draft || draft.status !== 'pending') return back('error', 'That draft was already handled.');

  if (req.body.action === 'discard') {
    await discardDraft(draft, req.user);
    return back('success', 'Draft discarded.');
  }
  if (req.body.action === 'regenerate') {
    const thread = await getThread(draft.thread_id);
    const job = thread && (await queueAiReplyIfNeeded({ thread, post: { id: draft.reply_to_post_id }, author: req.user, force: true, delaySeconds: 0 }));
    return back('info', job ? 'Writing a new draft. Refresh in a minute.' : 'A new draft is already being written.');
  }

  const body = String(req.body.body || '').trim();
  const errors = validatePostBody(body);
  if (errors.length) return back('error', errors.join(' '));
  try {
    const { postId, thread } = await postDraft(draft, { body, postAsId: intParam(req.body.post_as), reviewer: req.user });
    await afterSupportAnswer(thread);
    const page = await postPage(await getPost(postId));
    res.flash('success', 'Reply posted.');
    if (req.body.action === 'post_open') {
      return res.redirect(res.locals.url(threadPath(thread) + (page > 1 ? `?page=${page}` : '') + `#post-${postId}`));
    }
    res.redirect(res.locals.url('/support/inbox' + (req.body.view === 'mine' ? '?view=mine' : '')));
  } catch (err) {
    back('error', err.message);
  }
});

export default router;
