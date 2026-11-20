import { config } from './config.js';
import { getAiSettings, isConfigured, modelLabel } from './services/ai-settings.js';
import { createApp } from './app.js';
import { startWorkers } from './worker.js';
import { one, closeDb } from './db.js';

let app;
try {
  app = await createApp();
} catch (err) {
  console.error('\nCould not start: ' + err.message);
  if (/ECONNREFUSED|password authentication|does not exist|ENOTFOUND|no pg_hba/i.test(err.message)) {
    console.error('Check the DB_* settings in .env and that PostgreSQL is running. Run "node scripts/doctor.js" for a full check.');
  }
  process.exit(1);
}

const server = app.listen(config.port, config.host, async () => {
  console.log(`${config.siteName} ${config.version} is running.`);
  console.log(`  Open:   http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}${config.basePath}/`);
  console.log(`  Public URL setting (SITE_URL): ${config.siteUrl}${config.basePath}/`);
  const ai = await getAiSettings();
  console.log(`  AI: ${isConfigured(ai) ? modelLabel(ai) : 'OFF (choose a provider and key in Admin → AI provider)'}`);
  if (!(await one("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1"))) {
    console.log('  No admin account yet. Create one with:  node scripts/init.js --admin <username> <email> <password>');
  }
  console.log('Press Ctrl+C to stop.');
});

let stopWorkers = () => {};
if (config.runWorkers) stopWorkers = await startWorkers();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopWorkers();
    server.close(async () => {
      await closeDb().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
