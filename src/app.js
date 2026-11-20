import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { aiConfigured } from './services/ai-settings.js';
import { userForSession, touchLastSeen } from './services/users.js';
import { getBool, getSetting } from './services/settings.js';
import { randomToken, safeEqual } from './lib/security.js';
import { icon } from './lib/icons.js';
import * as fmt from './lib/format.js';
import * as h from './lib/view.js';
import publicRoutes from './routes/public.js';
import postingRoutes from './routes/posting.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import supportRoutes from './routes/support.js';
import { countPendingDrafts } from './services/drafts.js';
import { bootstrap } from './bootstrap.js';

export async function createApp() {
  await bootstrap();
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          // Avatars use inline size/colour attributes; user content can never carry style attributes (sanitized).
          styleSrcAttr: ["'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          upgradeInsecureRequests: config.cookieSecure ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(express.json({ limit: '256kb' }));

  const router = express.Router();
  router.use('/static', express.static(path.join(config.root, 'public'), { maxAge: config.isProduction ? '7d' : 0 }));

  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: config.basePath || '/' };

  // Session + locals
  router.use(async (req, res, next) => {
    req.cookieOpts = cookieOpts;
    req.user = await userForSession(req.cookies.sid);
    if (req.user) await touchLastSeen(req.user);

    // CSRF: double-submit token bound to a cookie.
    let csrf = req.cookies.csrf;
    if (!csrf || csrf.length < 20) {
      csrf = randomToken(24);
      res.cookie('csrf', csrf, { ...cookieOpts, maxAge: 365 * 86400_000 });
    }
    req.csrfToken = csrf;

    // One-shot flash message
    let flash = null;
    if (req.cookies.flash) {
      try {
        flash = JSON.parse(req.cookies.flash);
      } catch {}
      res.clearCookie('flash', cookieOpts);
    }
    res.flash = (type, message) => res.cookie('flash', JSON.stringify({ type, message }), { ...cookieOpts, maxAge: 60_000 });

    const url = (p = '/') => config.basePath + p;
    const isStaffUser = fmt.isStaff(req.user);
    const disclosePersonas = await getBool('disclose_personas');
    const supportTeamName = await getSetting('support_team_name');
    Object.assign(res.locals, {
      user: req.user,
      isStaff: isStaffUser,
      inboxCount: isStaffUser ? await countPendingDrafts() : 0,
      supportTeamName,
      badges: (u) => h.badges(u, disclosePersonas, supportTeamName),
      isAdmin: req.user?.role === 'admin',
      csrfToken: csrf,
      flash,
      url,
      absUrl: (p = '/') => config.siteUrl + config.basePath + p,
      currentPath: req.path,
      site: {
        name: config.siteName,
        productName: config.productName,
        mainSiteUrl: config.mainSiteUrl,
        docsUrl: config.docsUrl,
      },
      icon,
      fmt,
      h,
      aiOn: await aiConfigured(),
      disclosePersonas,
      announcement: await getSetting('announcement'),
      meta: { title: config.siteName, description: `Questions, answers and solutions for ${config.productName}, the open-source telephony switch, with help from the ${supportTeamName} team.`, canonical: null, noindex: false },
    });
    next();
  });

  router.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const sent = req.body?._csrf || req.get('x-csrf-token');
    if (!safeEqual(sent, req.csrfToken)) {
      return res.status(403).render('error', { status: 403, message: 'Your session expired or the form was tampered with. Go back, refresh the page and try again.' });
    }
    next();
  });

  router.use(authRoutes);
  router.use(publicRoutes);
  router.use(postingRoutes);
  router.use('/support', supportRoutes);
  router.use('/admin', adminRoutes);

  router.use((req, res) => res.status(404).render('error', { status: 404, message: 'We could not find that page. It may have been moved or deleted.' }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { status: 500, message: 'Something went wrong on our side. Please try again.' });
  });

  app.use(config.basePath || '/', router);
  if (config.basePath) app.get('/', (req, res) => res.redirect(config.basePath + '/'));
  return app;
}
