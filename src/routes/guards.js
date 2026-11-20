import { isStaff } from '../lib/format.js';
import { rateLimit } from '../lib/security.js';

export function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') return res.redirect(res.locals.url(`/login?next=${encodeURIComponent(req.originalUrl)}`));
  return res.status(401).render('error', { status: 401, message: 'Please log in to do that.' });
}

export function requireStaff(req, res, next) {
  if (isStaff(req.user)) return next();
  return res.status(403).render('error', { status: 403, message: 'Only RingQ staff can do that.' });
}

export function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  if (!req.user) return requireUser(req, res, next);
  return res.status(403).render('error', { status: 403, message: 'Administrators only.' });
}

/** Express middleware factory: limit by user id (or IP). */
export function limit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.user?.id ?? req.ip}`;
    if (rateLimit(key, max, windowMs)) return next();
    res.status(429).render('error', { status: 429, message: 'You are doing that too often. Please wait a few minutes and try again.' });
  };
}

export const pageParam = (req) => Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));

export function safeNext(next, fallback) {
  // Only same-site paths: "/x" is fine; "//evil.com" and "/\\evil.com" are not.
  return typeof next === 'string' && /^\/(?![\/\\])/.test(next) && !/[\r\n]/.test(next) ? next : fallback;
}
