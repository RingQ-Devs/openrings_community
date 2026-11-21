import { config } from './config.js';
import { bus } from './lib/events.js';
import { claimDueJobs, finishJob, failJob, recoverStuckJobs } from './services/jobs.js';
import { runAiReply, runDraftFallback } from './ai/responder.js';
import { runSeedGenerate, runSeedFollowup, schedulerTick } from './ai/seeder.js';
import { retryPolicy, EngineOfflineError } from './ai/client.js';
import { recoverEngine, engineOutage, engineVersion, retryWaitingForEngine } from './ai/engine.js';
import { getAiSettings } from './services/ai-settings.js';

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
      // The Open Rings AI engine on this machine stopped: start it again if it is installed.
      if (err instanceof EngineOfflineError) recoverEngine((await getAiSettings()).local.baseUrl).catch(() => {});
    }
  }
  return jobs.length;
}

/**
 * While answers wait for the Open Rings AI engine, check every 30 seconds whether it runs again.
 * As soon as it does, they are all written right away instead of waiting for their next retry.
 */
let lastEngineProbe = 0;
export async function probeEngine({ force = false } = {}) {
  if (!force && Date.now() - lastEngineProbe < 30_000) return 0;
  lastEngineProbe = Date.now();
  if (!(await engineOutage()).waiting) return 0;
  const ai = await getAiSettings();
  if (ai.provider !== 'local') return 0;
  if (!(await engineVersion(ai.local.baseUrl))) {
    await recoverEngine(ai.local.baseUrl);
    return 0;
  }
  const n = await retryWaitingForEngine();
  if (n) console.log(`[engine] The Open Rings AI engine is running again; writing ${n} waiting answer(s) now.`);
  return n;
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
      await probeEngine();
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
  // Open Rings AI on this machine: make sure its engine runs before the first answer is due.
  const ai = await getAiSettings();
  if (ai.provider === 'local') {
    recoverEngine(ai.local.baseUrl, { force: true })
      .then((state) => {
        if (state === 'starting') console.log('[engine] Open Rings AI engine was not running; it is starting.');
        if (state === 'not-installed') console.log('[engine] Open Rings AI engine is not running and not installed here. Run "npm run ai:setup".');
      })
      .catch(() => {});
  }
  const timer = setInterval(tick, config.workerIntervalMs);
  bus.on('job-due', () => tick());
  timer.unref();
  setTimeout(tick, 1000).unref();
  return () => clearInterval(timer);
}
