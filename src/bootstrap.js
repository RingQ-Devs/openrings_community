import fs from 'node:fs';
import path from 'node:path';
import { one, migrate } from './db.js';
import { config } from './config.js';
import { ensureAiUser, createUser, getUserByUsername } from './services/users.js';
import { createCategory, createForum } from './services/forum.js';
import { createPersona } from './ai/seeder.js';
import { applySeedTextUpdates } from './seed-text-updates.js';
import { upgradeOldKnowledgeBase } from './migrations/knowledge-upgrade.js';

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(config.root, file), 'utf8'));

let done = null;

/** Idempotent first-run setup: tables, AI user, default forums, starter personas, admin from env. */
export function bootstrap() {
  done ??= (async () => {
    await migrate();
    await ensureAiUser();

    if (!(await one('SELECT 1 FROM categories LIMIT 1'))) {
      for (const [ci, cat] of readJson('seed/forums.json').entries()) {
        const categoryId = await createCategory({ title: cat.title, description: cat.description, sort_order: ci });
        for (const [fi, f] of cat.forums.entries()) await createForum({ ...f, category_id: categoryId, sort_order: fi });
      }
    }

    await applySeedTextUpdates();
    await upgradeOldKnowledgeBase();

    if (!(await one("SELECT 1 FROM users WHERE role = 'persona' LIMIT 1"))) {
      for (const p of readJson('seed/personas.json')) {
        if (!(await getUserByUsername(p.username))) await createPersona(p);
      }
    }

    const { username, email, password } = config.admin;
    if (username && email && password && !(await one("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1"))) {
      if (!(await getUserByUsername(username))) {
        await createUser({ username, email, password, role: 'admin', title: 'Community Admin' });
        console.log(`[bootstrap] Created admin account "${username}"`);
      }
    }
  })();
  return done;
}
