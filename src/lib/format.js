import { config } from '../config.js';

export function slugify(text, max = 80) {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'thread';
}

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: config.timezone });
const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: config.timezone,
});

export const formatDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '');
export const formatDateTime = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : '');

export function timeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDate(iso);
}

export function compactNumber(n) {
  n = Number(n || 0);
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#4f46e5', '#b45309', '#be123c', '#0d9488', '#9333ea', '#65a30d'];

export function avatarColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initials(name) {
  const parts = String(name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(name).slice(0, 2).toUpperCase();
}

export const ROLE_LABELS = {
  admin: 'Administrator',
  support: 'Support engineer',
  ai: 'Automated answers',
  persona: 'Member',
  member: 'Member',
};

export const isStaff = (user) => !!user && (user.role === 'admin' || user.role === 'support');

export function threadPath(thread) {
  return `/threads/${thread.slug}.${thread.id}/`;
}

export function forumPath(forum) {
  return `/forums/${forum.slug}/`;
}

export function memberPath(user) {
  return `/members/${encodeURIComponent(user.username)}/`;
}

/** Current calendar date (YYYY-MM-DD) in a time zone. */
export function localDate(tz = config.timezone, at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function tzOffsetMinutes(at, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUtc - at.getTime()) / 60000;
}

/** Convert a wall-clock time on a date (YYYY-MM-DD) in tz to a UTC Date. */
export function zonedTime(dateStr, hour, minute = 0, tz = config.timezone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  return new Date(guess - tzOffsetMinutes(new Date(guess), tz) * 60000);
}
