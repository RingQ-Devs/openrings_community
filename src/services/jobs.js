import { one, all, val, run } from '../db.js';
import { bus } from '../lib/events.js';

export async function enqueueJob(type, payload = {}, { delaySeconds = 0, runAt = null } = {}) {
  const at = runAt || new Date(Date.now() + delaySeconds * 1000).toISOString();
  const id = await val('INSERT INTO jobs (type, payload, run_at) VALUES ($1, $2, $3) RETURNING id', type, JSON.stringify(payload), at);
  // Start it right away instead of waiting for the next worker tick.
  const dueInMs = Date.parse(at) - Date.now();
  if (dueInMs < 10_000) setTimeout(() => bus.emit('job-due'), Math.max(0, dueInMs) + 50);
  return id;
}

export async function hasQueuedJob(type, key, value) {
  return !!(await one(
    `SELECT 1 FROM jobs WHERE type = $1 AND status IN ('queued','running') AND payload->>$2 = $3 LIMIT 1`,
    type, key, String(value),
  ));
}

/** Atomically claim due jobs (safe even with several worker processes). */
export function claimDueJobs(limit = 3) {
  return all(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
       ORDER BY run_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    limit,
  );
}

export async function finishJob(id, status, result = null) {
  await run('UPDATE jobs SET status = $1, result = $2, updated_at = now() WHERE id = $3', status, result == null ? null : JSON.stringify(result), id);
}

export async function failJob(job, error, { maxAttempts = 3, maxBackoffSeconds = 3600 } = {}) {
  const retry = job.attempts < maxAttempts;
  const backoff = Math.min(60 * 2 ** job.attempts, maxBackoffSeconds); // 2, 4, 8 … minutes
  await run(
    'UPDATE jobs SET status = $1, last_error = $2, run_at = $3, updated_at = now() WHERE id = $4',
    retry ? 'queued' : 'failed',
    String(error?.message || error).slice(0, 2000),
    new Date(Date.now() + backoff * 1000).toISOString(),
    job.id,
  );
}

/** Jobs left "running" by a crashed process go back to the queue. */
export async function recoverStuckJobs() {
  await run(`UPDATE jobs SET status = 'queued' WHERE status = 'running' AND updated_at < now() - interval '15 minutes'`);
}

export const recentJobs = (limit = 100) => all('SELECT * FROM jobs ORDER BY id DESC LIMIT $1', limit);

export async function jobStats() {
  const rows = await all(`SELECT status, COUNT(*) AS n FROM jobs WHERE created_at > now() - interval '1 day' GROUP BY status`);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
