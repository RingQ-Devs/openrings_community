// Checks that everything is configured. Run from the community folder:
//   node scripts/doctor.js
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

const ok = (msg) => console.log(`  [OK]   ${msg}`);
const bad = (msg, fix) => {
  console.log(`  [FAIL] ${msg}${fix ? `\n         -> ${fix}` : ''}`);
  process.exitCode = 1;
};
const warn = (msg) => console.log(`  [WARN] ${msg}`);

console.log('\nOpenRings Community - setup check\n');

// 1. Node.js
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok(`Node.js ${process.versions.node}`);
else bad(`Node.js ${process.versions.node} is too old`, 'Install Node.js 22 LTS or newer from https://nodejs.org/');

// 2. .env
if (fs.existsSync(path.join(config.root, '.env'))) ok('.env file found');
else bad('.env file not found', 'Copy .env.example to .env and fill it in');

if (!fs.existsSync(path.join(config.root, 'node_modules', 'pg'))) {
  bad('Dependencies are not installed', 'Run: npm install');
  process.exit(1);
}

// 3. Database
const { pool, migrate, val, closeDb } = await import('../src/db.js');
const target = config.db.url ? 'DATABASE_URL' : `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`;
try {
  const version = await val('SHOW server_version');
  ok(`Connected to PostgreSQL ${version} (${target}, schema "${config.db.schema}")`);
  if (parseInt(version, 10) < 12) bad('PostgreSQL 12 or newer is required');
  await migrate();
  const tables = await val(
    `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = $1
     AND table_name IN ('users','sessions','categories','forums','threads','posts','post_likes','jobs','scheduled_posts','settings','reply_drafts')`,
    config.db.schema,
  );
  if (tables === 11) ok('All 11 forum tables exist');
  else bad(`Only ${tables} of 11 tables exist`, 'Check that the database user owns the database (see the setup guide)');
  const admins = await val("SELECT COUNT(*) FROM users WHERE role = 'admin'").catch(() => 0);
  if (admins > 0) ok(`${admins} admin account(s)`);
  else warn('No admin account yet. Create one: node scripts/init.js --admin <username> <email> <password>');
} catch (err) {
  const hints = {
    ECONNREFUSED:
      process.platform === 'win32'
        ? 'PostgreSQL is not running or DB_HOST/DB_PORT is wrong. Check Services (services.msc) for "postgresql-x64-NN".'
        : 'PostgreSQL is not running or DB_HOST/DB_PORT is wrong. Check: sudo systemctl status postgresql',
    '28P01': 'Wrong DB_USER or DB_PASSWORD.',
    '3D000': `Database "${config.db.database}" does not exist. Create it (step 3 of the setup guide).`,
    '42501': 'The database user lacks permission. Make it the owner of the database (step 3 of the setup guide).',
  };
  bad(`Database: ${err.message}`, hints[err.code] || hints[err.message.match(/ECONNREFUSED/)?.[0]] || 'Check the DB_* settings in .env');
}

// 4. AI (settings from Admin → AI provider, with .env as fallback)
try {
  const { getAiSettings, modelLabel } = await import('../src/services/ai-settings.js');
  const { checkAiConnection } = await import('../src/ai/check.js');
  const ai = await getAiSettings();
  const where = ai.providerSource === 'admin' ? 'admin panel' : ai.providerSource === 'env' ? '.env' : 'automatic';
  console.log(`  [..]   AI provider: ${modelLabel(ai)} (from ${where})`);
  for (const r of await checkAiConnection(ai, { testCall: !process.argv.includes('--skip-test-call') })) {
    if (r.ok === true) ok(r.message);
    else if (r.ok === false) bad(r.message, r.fix);
    else warn(r.message);
  }
} catch (err) {
  warn(`AI check skipped: ${err.message}`);
}

// 5. Site URL
console.log(`\n  Site will open at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}${config.basePath}/`);
console.log(`  Public URL (SITE_URL + BASE_PATH): ${config.siteUrl}${config.basePath}/`);
console.log(`  Time zone for daily posts: ${config.timezone}\n`);
console.log(process.exitCode ? 'Fix the [FAIL] items above, then run this check again.\n' : 'Everything looks good. Start the forum with: npm start\n');

await closeDb().catch(() => {});
void pool;
