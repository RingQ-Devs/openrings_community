// Vercel entry point: every request under /community/ is handled by the Express app.
// Background work (AI answers, daily posts) runs in /api/cron every minute, and right
// after a post through waitUntil, because Vercel keeps no process running between requests.
import { waitUntil } from '@vercel/functions';
import { createApp } from '../src/app.js';
import { bus } from '../src/lib/events.js';
import { tick } from '../src/worker.js';

let appPromise;
let hooked = false;

export default async function handler(req, res) {
  appPromise ??= createApp().catch((err) => {
    appPromise = undefined;
    throw err;
  });
  const app = await appPromise;
  if (!hooked) {
    hooked = true;
    // A job became due (for example a new question): write the answer after the response is sent.
    bus.on('job-due', () => waitUntil(tick()));
  }
  return app(req, res);
}
