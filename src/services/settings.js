import fs from 'node:fs';
import path from 'node:path';
import { all, run } from '../db.js';
import { config } from '../config.js';

function readFileOr(file, fallback = '') {
  try {
    return fs.readFileSync(path.join(config.root, file), 'utf8');
  } catch {
    return fallback;
  }
}

/** Every admin-editable setting with its default value (stored as strings). */
export const SETTING_DEFAULTS = {
  // How answers are published:
  //   review          = drafts go to the Support inbox; a support engineer reviews and posts them under their name
  //   review_fallback = same, but a draft nobody reviews within review_fallback_minutes is posted
  //                     automatically from the automated account (labelled "Automated")
  //   auto            = answers post from the automated account without waiting for review
  reply_mode: 'review',
  review_fallback_minutes: '30',
  // Shown on staff badges and in public texts
  support_team_name: 'RingQ Support',
  // AI answers
  ai_autoreply_enabled: '1',
  ai_reply_delay_seconds: '20',
  // Optional upper bound: each reply waits a random time between the two values
  ai_reply_delay_max_seconds: '',
  ai_followups_enabled: '1',
  ai_max_replies_per_thread: '4',
  ai_stop_when_staff_replies: '1',
  // Daily seeded discussions
  seed_enabled: '1',
  seed_posts_per_day: '3',
  seed_window_start_hour: '9',
  seed_window_end_hour: '21',
  seed_require_approval: '0',
  seed_answer_delay_min_minutes: '10',
  seed_answer_delay_max_minutes: '90',
  // The sample member asks a random number of follow-up questions (between min and max) in each
  // daily discussion, each one after a random wait. Every follow-up is answered, up to
  // ai_max_replies_per_thread answers in the thread.
  seed_followups_min: '1',
  seed_followups_max: '3',
  seed_followup_delay_min_minutes: '30',
  seed_followup_delay_max_minutes: '240',
  seed_last_plan_date: '',
  disclose_personas: '1',
  // Content
  announcement: '',
  // Starting text only: copied into the database the first time; after that the database copy is used.
  knowledge_base: () => readFileOr('knowledge/openrings.md', '# OpenRings\n'),
  knowledge_base_saved_at: '',
  knowledge_base_backup: '',
  knowledge_base_backup_at: '',
  topic_bank: () => readFileOr('seed/topics.txt', ''),
};

// Small in-process cache: settings are read on every page view.
let cache = null;
let cacheAt = 0;
const CACHE_MS = 5000;

async function load() {
  if (!cache || Date.now() - cacheAt > CACHE_MS) {
    const rows = await all('SELECT key, value FROM settings');
    cache = new Map(rows.map((r) => [r.key, r.value]));
    cacheAt = Date.now();
  }
  return cache;
}

export async function getSetting(key) {
  const map = await load();
  if (map.has(key)) return map.get(key);
  const def = SETTING_DEFAULTS[key];
  if (typeof def === 'function') {
    // Persist file-backed defaults so admins edit a stable copy.
    const value = def();
    await setSetting(key, value);
    return value;
  }
  return def ?? '';
}

export const getBool = async (key) => (await getSetting(key)) === '1';
export const getNumber = async (key) => Number(await getSetting(key)) || 0;

export async function setSetting(key, value) {
  await run(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    key,
    String(value ?? ''),
  );
  cache = null;
}

/**
 * Atomically change a setting from anything else to `value`.
 * Returns true only for the caller that made the change (used to plan each day once).
 */
export async function claimSetting(key, value) {
  const { rowCount } = await run(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE settings.value IS DISTINCT FROM EXCLUDED.value`,
    key,
    String(value),
  );
  cache = null;
  return rowCount === 1;
}

export async function allSettings() {
  const out = {};
  for (const key of Object.keys(SETTING_DEFAULTS)) out[key] = await getSetting(key);
  return out;
}

export const clearSettingsCache = () => {
  cache = null;
};
