// Generate a batch of daily questions right now (instead of waiting for the scheduler).
//   node scripts/seed-today.js [count] [--publish]
// --publish publishes them immediately. The AI answers follow after the configured delay,
// processed by the running server's worker.
import { bootstrap } from '../src/bootstrap.js';
import { runSeedGenerate, publishScheduledPost } from '../src/ai/seeder.js';
import { localDate } from '../src/lib/format.js';
import { all, val, closeDb } from '../src/db.js';
import { aiConfigured } from '../src/services/ai-settings.js';

async function main() {
  await bootstrap();
  if (!(await aiConfigured())) throw new Error('AI is not configured. Choose a provider and enter its key in Admin → AI provider.');
  const count = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a))) || 3;
  const before = await val('SELECT COALESCE(MAX(id), 0) FROM scheduled_posts');
  const { status, result } = await runSeedGenerate({ payload: { date: localDate(), count } });
  console.log(status, result);
  for (const sp of await all('SELECT * FROM scheduled_posts WHERE id > $1 ORDER BY publish_at', before)) {
    if (process.argv.includes('--publish') && sp.status === 'approved') {
      const threadId = await publishScheduledPost(sp);
      console.log(`published thread ${threadId}: ${sp.title}`);
    } else {
      console.log(`[${sp.status}] ${sp.publish_at}  ${sp.title}`);
    }
  }
}

main()
  .catch((err) => {
    console.error('Error: ' + err.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
