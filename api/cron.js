// Vercel Cron (every minute): plan the daily posts and run every background job that is due.
import { bootstrap } from '../src/bootstrap.js';
import { tick } from '../src/worker.js';
import { recoverStuckJobs } from '../src/services/jobs.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401;
    return res.end('Unauthorized');
  }
  await bootstrap();
  await recoverStuckJobs();
  await tick();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}
