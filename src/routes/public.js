import express from 'express';
import { config } from '../config.js';
import * as forum from '../services/forum.js';
import { listMembers, getUserByUsername, onlineMembers, newestMember, parsePersona } from '../services/users.js';
import { plainExcerpt } from '../lib/markdown.js';
import { threadPath, forumPath } from '../lib/format.js';
import { pageParam } from './guards.js';
import { one } from '../db.js';
import { getSetting } from '../services/settings.js';

const router = express.Router();

async function sidebarData() {
  const [stats, latest, online, newest] = await Promise.all([
    forum.forumStats(),
    forum.latestThreads({ limit: 6 }),
    onlineMembers(),
    newestMember(),
  ]);
  return { stats, latest, online, newest };
}

router.get('/', async (req, res) => {
  res.locals.meta.canonical = res.locals.absUrl('/');
  res.render('index', {
    categories: await forum.listCategoriesWithForums(),
    sidebar: await sidebarData(),
  });
});

router.get('/whats-new', async (req, res) => {
  const page = pageParam(req);
  const unanswered = req.query.filter === 'unanswered';
  const perPage = 30;
  const threads = await forum.latestThreads({ limit: perPage, offset: (page - 1) * perPage, unanswered });
  const total = await forum.countAllThreads({ unanswered });
  res.locals.meta.title = unanswered ? 'Unanswered questions' : "What's new";
  res.locals.meta.canonical = res.locals.absUrl('/whats-new');
  res.render('whats-new', { threads, page, pages: Math.max(1, Math.ceil(total / perPage)), unanswered, sidebar: await sidebarData() });
});

router.get('/forums/:slug/', async (req, res, next) => {
  const f = await forum.getForumBySlug(req.params.slug);
  if (!f) return next();
  const page = pageParam(req);
  const pages = Math.max(1, Math.ceil(f.thread_count / forum.THREADS_PER_PAGE));
  res.locals.meta.title = page > 1 ? `${f.title} – page ${page}` : f.title;
  res.locals.meta.description = f.description;
  res.locals.meta.canonical = res.locals.absUrl(forumPath(f) + (page > 1 ? `?page=${page}` : ''));
  res.render('forum', {
    forum: f,
    category: await forum.getCategory(f.category_id),
    threads: await forum.listThreads(f.id, { page }),
    page,
    pages,
    sidebar: await sidebarData(),
  });
});

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit/i;

router.get('/threads/:slugid/', async (req, res, next) => {
  const m = /^(.*)\.(\d+)$/.exec(req.params.slugid);
  if (!m) return next();
  const thread = await forum.getThread(Number(m[2]));
  if (!thread || (thread.deleted_at && !res.locals.isStaff)) return next();
  const page = pageParam(req);
  if (m[1] !== thread.slug) {
    return res.redirect(301, res.locals.url(threadPath(thread) + (page > 1 ? `?page=${page}` : '')));
  }
  const totalPosts = thread.reply_count + 1;
  const pages = Math.max(1, Math.ceil(totalPosts / forum.POSTS_PER_PAGE));
  if (page > pages) return res.redirect(res.locals.url(threadPath(thread) + `?page=${pages}`));

  if (!BOT_RE.test(req.get('user-agent') || '')) await forum.incrementViews(thread.id);

  const [posts, first, f, related] = await Promise.all([
    forum.listPosts(thread.id, { page, viewerId: req.user?.id ?? 0 }),
    forum.firstPost(thread.id),
    forum.getForumById(thread.forum_id),
    forum.relatedThreads(thread, 5),
  ]);
  const solutionPost = thread.solution_post_id ? await forum.getPost(thread.solution_post_id) : null;
  const solution =
    solutionPost && !solutionPost.deleted_at
      ? { ...solutionPost, excerpt: plainExcerpt(solutionPost.body, 400), page: await forum.postPage(solutionPost) }
      : null;

  res.locals.meta.title = page > 1 ? `${thread.title} – page ${page}` : thread.title;
  res.locals.meta.description = plainExcerpt(first?.body, 160);
  res.locals.meta.canonical = res.locals.absUrl(threadPath(thread) + (page > 1 ? `?page=${page}` : ''));
  res.locals.meta.ogType = 'article';

  const pendingDraft = res.locals.isStaff
    ? await one(
        `SELECT d.id, u.username AS assigned_username FROM reply_drafts d LEFT JOIN users u ON u.id = d.assigned_to
         WHERE d.thread_id = $1 AND d.status = 'pending'`,
        thread.id,
      )
    : null;

  res.render('thread', {
    pendingDraft,
    thread,
    forum: f,
    category: await forum.getCategory(f.category_id),
    posts,
    page,
    pages,
    solution,
    related,
    allForums: res.locals.isStaff ? await forum.listForums() : [],
    canReply: !!req.user && (!thread.is_locked || res.locals.isStaff),
    jsonLd: page === 1 ? discussionJsonLd(res, thread, posts) : null,
  });
});

function discussionJsonLd(res, thread, posts) {
  const [first, ...replies] = posts;
  if (!first) return null;
  const person = (p) => ({ '@type': 'Person', name: p.username, url: res.locals.absUrl(`/members/${encodeURIComponent(p.username)}/`) });
  return {
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    headline: thread.title,
    url: res.locals.absUrl(threadPath(thread)),
    datePublished: thread.created_at,
    author: person(first),
    text: plainExcerpt(first.body, 1000),
    interactionStatistic: [
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: thread.reply_count },
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/ViewAction', userInteractionCount: thread.view_count },
    ],
    comment: replies.slice(0, 20).map((p) => ({
      '@type': 'Comment',
      author: person(p),
      datePublished: p.created_at,
      text: plainExcerpt(p.body, 600),
    })),
  };
}

/**
 * Live updates for an open thread page: new posts (as ready-made HTML) and whether a reply
 * is being prepared right now. The page polls this, so replies appear without reloading.
 */
router.get('/threads/:id/live', async (req, res) => {
  const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
  const after = /^\d{1,9}$/.test(String(req.query.after)) ? Number(req.query.after) : 0;
  const thread = await forum.getThread(id);
  if (!thread || thread.deleted_at) return res.status(404).json({ error: 'not found' });
  const rows = await forum.listPostsAfter(thread.id, after, req.user?.id ?? 0);
  const canReply = !!req.user && (!thread.is_locked || res.locals.isStaff);
  const render = (p) =>
    new Promise((resolve, reject) =>
      res.render('partials/post', { p, number: p.position, thread, canReply }, (err, html) => (err ? reject(err) : resolve(html))),
    );
  const posts = [];
  for (const p of rows) posts.push({ id: p.id, html: await render(p) });

  // "A reply is being prepared": an automatic answer is queued or being written for this thread.
  const mode = await getSetting('reply_mode');
  const pending = !!(await one(
    `SELECT 1 FROM jobs WHERE status IN ('queued','running') AND payload->>'threadId' = $1
       AND type = 'ai_reply' AND $2 = 'auto' AND run_at < now() + interval '2 minutes'
     UNION ALL
     SELECT 1 FROM jobs j JOIN reply_drafts d ON d.id = (j.payload->>'draftId')::int
     WHERE j.type = 'draft_fallback' AND j.status IN ('queued','running') AND d.thread_id = $3
       AND j.run_at < now() + interval '2 minutes'
     LIMIT 1`,
    String(thread.id), mode, thread.id,
  ));
  res.set('Cache-Control', 'no-store').json({ posts, pending, replyCount: thread.reply_count });
});

router.get('/posts/:id', async (req, res, next) => {
  const post = await forum.getPost(Number(req.params.id) || 0);
  if (!post || post.deleted_at) return next();
  const thread = await forum.getThread(post.thread_id);
  if (!thread || thread.deleted_at) return next();
  const page = await forum.postPage(post);
  res.redirect(res.locals.url(threadPath(thread) + (page > 1 ? `?page=${page}` : '') + `#post-${post.id}`));
});

router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').slice(0, 200).trim();
  res.locals.meta.title = q ? `Search: ${q}` : 'Search';
  res.locals.meta.noindex = true;
  res.render('search', { q, results: q ? await forum.search(q, { limit: 40 }) : [], sidebar: await sidebarData() });
});

const MEMBER_TABS = { messages: 'Most messages', likes: 'Most likes', newest: 'Newest members', staff: 'Support team' };

router.get('/members/', async (req, res) => {
  const tab = MEMBER_TABS[req.query.tab] ? req.query.tab : 'messages';
  res.locals.meta.title = 'Members';
  res.locals.meta.canonical = res.locals.absUrl('/members/');
  res.render('members', { tab, tabs: MEMBER_TABS, members: await listMembers({ tab, limit: 60 }), sidebar: await sidebarData() });
});

router.get('/members/:username/', async (req, res, next) => {
  const member = await getUserByUsername(req.params.username);
  if (!member || (member.role === 'persona' && !member.is_active && !res.locals.isStaff)) return next();
  res.locals.meta.title = `${member.username} – member profile`;
  res.locals.meta.description = member.bio ? plainExcerpt(member.bio, 160) : `${member.username} is a member of the ${config.siteName}.`;
  res.locals.meta.canonical = res.locals.absUrl(`/members/${encodeURIComponent(member.username)}/`);
  res.render('member', {
    member,
    persona: member.role === 'persona' ? parsePersona(member) : null,
    posts: await forum.userRecentPosts(member.id, 20),
    threads: await forum.userThreads(member.id, 10),
  });
});

router.get('/rules', (req, res) => {
  res.locals.meta.title = 'Community rules';
  res.render('rules');
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nDisallow: ${config.basePath}/admin\nDisallow: ${config.basePath}/search\nDisallow: ${config.basePath}/login\nDisallow: ${config.basePath}/register\nDisallow: ${config.basePath}/post-thread\n\nSitemap: ${config.siteUrl}${config.basePath}/sitemap.xml\n`,
  );
});

router.get('/sitemap.xml', async (req, res) => {
  const { forums, threads } = await forum.sitemapEntries();
  const abs = res.locals.absUrl;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const urls = [
    `<url><loc>${esc(abs('/'))}</loc><changefreq>hourly</changefreq></url>`,
    ...forums.map((f) => `<url><loc>${esc(abs(forumPath(f)))}</loc><changefreq>daily</changefreq></url>`),
    ...threads.map((t) => `<url><loc>${esc(abs(threadPath(t)))}</loc><lastmod>${t.last_post_at}</lastmod></url>`),
  ];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
});

export default router;
