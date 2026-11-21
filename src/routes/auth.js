import express from 'express';
import { authenticate, createSession, destroySession, validateRegistration, createUser, updateProfile, checkPassword, setPassword, deleteAllSessions } from '../services/users.js';
import { requireUser, limit, safeNext } from './guards.js';

const router = express.Router();

async function startSession(req, res, user) {
  const { token, maxAge } = await createSession(user.id);
  res.cookie('sid', token, { ...req.cookieOpts, maxAge });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(res.locals.url('/'));
  res.locals.meta.title = 'Log in';
  res.locals.meta.noindex = true;
  res.render('login', { next: req.query.next || '', error: null, login: '' });
});

router.post('/login', limit('login', 10, 15 * 60_000), async (req, res) => {
  const { login = '', password = '', next = '' } = req.body;
  const user = await authenticate(login.trim(), password);
  res.locals.meta.noindex = true;
  if (!user) return res.status(400).render('login', { next, error: 'Incorrect username/email or password.', login });
  if (user.is_banned) return res.status(403).render('login', { next, error: 'This account has been suspended.', login });
  await startSession(req, res, user);
  res.flash('success', `Welcome back, ${user.username}!`);
  res.redirect(safeNext(next, res.locals.url('/')));
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(res.locals.url('/'));
  res.locals.meta.title = 'Join the community';
  res.locals.meta.noindex = true;
  res.render('register', { errors: [], values: {}, next: req.query.next || '' });
});

router.post('/register', limit('register', 5, 60 * 60_000), async (req, res) => {
  const values = {
    username: (req.body.username || '').trim(),
    email: (req.body.email || '').trim(),
    password: req.body.password || '',
  };
  res.locals.meta.noindex = true;
  const errors = req.body.website_url ? ['Registration failed.'] : await validateRegistration(values);
  if (!req.body.agree) errors.push('Please accept the community rules.');
  if (errors.length) return res.status(400).render('register', { errors, values: { ...values, password: '' }, next: req.body.next || '' });
  const user = await createUser({ username: values.username, email: values.email, password: values.password });
  await startSession(req, res, user);
  res.flash('success', `Welcome to the community, ${user.username}! Ask your first question any time.`);
  res.redirect(safeNext(req.body.next, res.locals.url('/')));
});

router.post('/logout', async (req, res) => {
  await destroySession(req.cookies.sid);
  res.clearCookie('sid', req.cookieOpts);
  res.redirect(res.locals.url('/'));
});

router.get('/account', requireUser, (req, res) => {
  res.locals.meta.title = 'Account settings';
  res.locals.meta.noindex = true;
  res.render('account', { errors: [] });
});

router.post('/account', requireUser, async (req, res) => {
  await updateProfile(req.user.id, {
    bio: (req.body.bio || '').trim(),
    location: (req.body.location || '').trim(),
    website: (req.body.website || '').trim(),
  });
  res.flash('success', 'Profile saved.');
  res.redirect(res.locals.url('/account'));
});

router.post('/account/password', requireUser, limit('password', 10, 15 * 60_000), async (req, res) => {
  const { current = '', password = '' } = req.body;
  const errors = [];
  if (!(await checkPassword(req.user.id, current))) errors.push('Your current password is incorrect.');
  if (password.length < 8) errors.push('New password must be at least 8 characters.');
  if (errors.length) {
    res.locals.meta.noindex = true;
    return res.status(400).render('account', { errors });
  }
  await setPassword(req.user.id, password);
  await deleteAllSessions(req.user.id);
  await startSession(req, res, req.user);
  res.flash('success', 'Password changed. Other devices have been signed out.');
  res.redirect(res.locals.url('/account'));
});

export default router;
