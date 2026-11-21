import { one, all, val, run, nowIso, tx } from '../db.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../lib/security.js';

export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,23}$/;
export const AI_USERNAME = 'OpenRings_Assistant';
const SESSION_DAYS = 30;

const publicCols = `id, username, email, role, title, bio, location, website, persona_json, is_active, is_banned,
  on_duty, post_count, like_count, created_at, last_seen_at`;

export const getUserById = (id) => one(`SELECT ${publicCols} FROM users WHERE id = $1`, id);
export const getUserByUsername = (username) =>
  one(`SELECT ${publicCols} FROM users WHERE lower(username) = lower($1)`, username);

export async function validateRegistration({ username, email, password }) {
  const errors = [];
  if (!USERNAME_RE.test(username || '')) {
    errors.push('Username must be 3–24 characters: letters, numbers, dot, dash or underscore.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || email.length > 200) errors.push('Enter a valid email address.');
  if (!password || password.length < 8) errors.push('Password must be at least 8 characters.');
  if (password && password.length > 200) errors.push('Password is too long.');
  if (!errors.length) {
    if (await one('SELECT 1 FROM users WHERE lower(username) = lower($1)', username)) errors.push('That username is taken.');
    if (await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', email)) errors.push('An account with that email already exists.');
  }
  return errors;
}

export async function createUser({ username, email = null, password = null, role = 'member', title = null, bio = '', location = '', personaJson = null, createdAt = null }) {
  const id = await val(
    `INSERT INTO users (username, email, password_hash, role, title, bio, location, persona_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now())) RETURNING id`,
    username, email, password ? hashPassword(password) : null, role, title, bio, location, personaJson, createdAt,
  );
  return getUserById(id);
}

export async function authenticate(login, password) {
  const row = await one(
    'SELECT id, password_hash FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)',
    login,
  );
  if (!row || !row.password_hash) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return getUserById(row.id);
}

export async function setPassword(userId, password) {
  await run('UPDATE users SET password_hash = $1 WHERE id = $2', hashPassword(password), userId);
}

export async function checkPassword(userId, password) {
  const hash = await val('SELECT password_hash FROM users WHERE id = $1', userId);
  return !!hash && verifyPassword(password, hash);
}

export async function updateProfile(userId, { bio = '', location = '', website = '' }) {
  await run(
    'UPDATE users SET bio = $1, location = $2, website = $3 WHERE id = $4',
    bio.slice(0, 1000),
    location.slice(0, 80),
    /^https?:\/\//i.test(website) ? website.slice(0, 200) : '',
    userId,
  );
}

// ---- sessions --------------------------------------------------------------

export async function createSession(userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await run('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', sha256(token), userId, expires);
  return { token, maxAge: SESSION_DAYS * 86400_000 };
}

export async function userForSession(token) {
  if (!token) return null;
  const row = await one(
    `SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now() AND u.is_banned = 0`,
    sha256(token),
  );
  return row ? getUserById(row.id) : null;
}

export async function destroySession(token) {
  if (token) await run('DELETE FROM sessions WHERE id = $1', sha256(token));
}

export async function touchLastSeen(user) {
  const last = user.last_seen_at ? Date.parse(user.last_seen_at) : 0;
  if (Date.now() - last > 60_000) await run('UPDATE users SET last_seen_at = now() WHERE id = $1', user.id);
}

// ---- listings --------------------------------------------------------------

const MEMBER_SORTS = {
  messages: 'post_count DESC, id ASC',
  likes: 'like_count DESC, post_count DESC',
  newest: 'created_at DESC',
  staff: "CASE role WHEN 'admin' THEN 0 WHEN 'support' THEN 1 ELSE 2 END, post_count DESC",
};

export function listMembers({ tab = 'messages', limit = 30, offset = 0 } = {}) {
  const order = MEMBER_SORTS[tab] || MEMBER_SORTS.messages;
  // The automated account is listed only once it has posted (auto reply mode).
  const where =
    tab === 'staff'
      ? "(role IN ('admin','support') OR (role = 'ai' AND post_count > 0))"
      : "is_banned = 0 AND (role <> 'persona' OR is_active = 1) AND (role <> 'ai' OR post_count > 0)";
  return all(`SELECT ${publicCols} FROM users WHERE ${where} ORDER BY ${order} LIMIT $1 OFFSET $2`, limit, offset);
}

export function newestMember() {
  return one("SELECT id, username, role FROM users WHERE role IN ('member','persona','support') AND is_banned = 0 ORDER BY created_at DESC LIMIT 1");
}

export function onlineMembers(minutes = 15) {
  return all(
    `SELECT id, username, role FROM users WHERE last_seen_at > now() - make_interval(mins => $1) ORDER BY last_seen_at DESC LIMIT 30`,
    minutes,
  );
}

export function searchUsers(q, limit = 100) {
  const like = `%${q}%`;
  return all(`SELECT ${publicCols} FROM users WHERE username ILIKE $1 OR email ILIKE $1 ORDER BY id DESC LIMIT $2`, like, limit);
}

export function listPersonas() {
  return all(`SELECT ${publicCols} FROM users WHERE role = 'persona' ORDER BY is_active DESC, username`);
}

export function parsePersona(user) {
  try {
    return user?.persona_json ? JSON.parse(user.persona_json) : {};
  } catch {
    return {};
  }
}

const ASSISTANT_TITLE = 'Automated answers';
const ASSISTANT_BIO = 'Posts automated first answers to new questions. RingQ Support engineers follow up when needed.';

/** The account that posts automated answers (only used in "auto" reply mode). */
export async function ensureAiUser() {
  let user = await one(`SELECT ${publicCols} FROM users WHERE role = 'ai' ORDER BY id LIMIT 1`);
  if (!user) {
    return createUser({ username: AI_USERNAME, role: 'ai', title: ASSISTANT_TITLE, bio: ASSISTANT_BIO });
  }
  // Older installs named this account differently; bring it in line.
  if (user.title !== ASSISTANT_TITLE || user.bio !== ASSISTANT_BIO || user.username === 'OpenRings_AI') {
    const username = user.username === 'OpenRings_AI' && !(await getUserByUsername(AI_USERNAME)) ? AI_USERNAME : user.username;
    await run('UPDATE users SET username = $1, title = $2, bio = $3 WHERE id = $4', username, ASSISTANT_TITLE, ASSISTANT_BIO, user.id);
    user = await getUserById(user.id);
  }
  return user;
}

/** Support engineers and admins, for "post as" lists and the duty roster. */
export function listSupportStaff() {
  return all(`SELECT ${publicCols} FROM users WHERE role IN ('support','admin') AND is_banned = 0 ORDER BY role DESC, username`);
}

/**
 * Pick who a new draft is assigned to: a random on-duty engineer; if nobody is on duty,
 * any support engineer; failing that, any admin.
 */
export async function pickOnDutyEngineer() {
  for (const where of [
    "role IN ('support','admin') AND on_duty = 1",
    "role = 'support'",
    "role = 'admin'",
  ]) {
    const u = await one(`SELECT ${publicCols} FROM users WHERE ${where} AND is_banned = 0 ORDER BY random() LIMIT 1`);
    if (u) return u;
  }
  return null;
}

export async function setRole(userId, role) {
  await run('UPDATE users SET role = $1 WHERE id = $2', role, userId);
}

export async function deleteAllSessions(userId) {
  await run('DELETE FROM sessions WHERE user_id = $1', userId);
}

const EDITABLE = ['title', 'role', 'is_banned', 'is_active', 'on_duty', 'bio', 'location', 'persona_json', 'username'];
export const updateUser = (id, fields) =>
  tx(async () => {
    for (const [k, v] of Object.entries(fields)) {
      if (EDITABLE.includes(k)) await run(`UPDATE users SET ${k} = $1 WHERE id = $2`, v, id);
    }
  });

export { nowIso };
