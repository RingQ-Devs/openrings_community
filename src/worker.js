import { config } from './config.js';
import { bus } from './lib/events.js';
import { claimDueJobs, finishJob, failJob, recoverStuckJobs } from './services/jobs.js';
import { runAiReply, runDraftFallback } from './ai/responder.js';
import { runSeedGenerate, runSeedFollowup, schedulerTick } from './ai/seeder.js';
import { retryPolicy } from './ai/client.js';

const HANDLERS = {
  ai_reply: runAiReply,
  draft_fallback: runDraftFallback,
  seed_generate: runSeedGenerate,
  seed_followup: runSeedFollowup,
};

/** Run every job that is due. Returns the number of jobs processed. */
export async function runDueJobs(limit = 5) {
  const jobs = await claimDueJobs(limit);
  for (const job of jobs) {
    const handler = HANDLERS[job.type];
    try {
      if (!handler) throw new Error(`Unknown job type ${job.type}`);
      const { status, result } = await handler(job);
      await finishJob(job.id, status, result);
    } catch (err) {
      console.error(`[worker] job ${job.id} (${job.type}) failed:`, err.message);
      await failJob(job, err, retryPolicy(err));
    }
  }
  return jobs.length;
}

let busy = false;
let again = false;
export async function tick() {
  if (busy) {
    again = true; // something became due while we were working: run once more afterwards
    return;
  }
  busy = true;
  try {
    do {
      again = false;
      await schedulerTick();
      await runDueJobs();
    } while (again);
  } catch (err) {
    console.error('[worker] tick error:', err.message);
  } finally {
    busy = false;
  }
}

export async function startWorkers() {
  await recoverStuckJobs();
  const timer = setInterval(tick, config.workerIntervalMs);
  bus.on('job-due', () => tick());
  timer.unref();
  setTimeout(tick, 1000).unref();
  return () => clearInterval(timer);
}
