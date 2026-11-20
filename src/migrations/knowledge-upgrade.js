import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { one } from '../db.js';
import { setSetting } from '../services/settings.js';

// A sentence that only the first starter template contains.
const OLD_SIGNATURE = 'built on RingQ Switch, the telephony platform developed by the RingQ team';

const read = (file) => fs.readFileSync(path.join(config.root, file), 'utf8');

/**
 * One-time upgrade: if the stored knowledge base is still the first starter template,
 * replace it with the current one (filled from openrings.org) and keep every line the
 * admin added or changed, in a section at the end. The previous text is kept as a backup.
 */
export async function upgradeOldKnowledgeBase() {
  const row = await one("SELECT value FROM settings WHERE key = 'knowledge_base'");
  if (!row || !row.value.includes(OLD_SIGNATURE)) return false;

  const oldTemplate = new Set(read('src/migrations/knowledge-template-v1.md').split('\n').map((l) => l.trim()));
  const added = row.value.split('\n').filter((l) => l.trim() && !oldTemplate.has(l.trim()));

  let next = read('knowledge/openrings.md').trimEnd() + '\n';
  if (added.length) next += `\n## Added in the admin panel\n${added.join('\n')}\n`;

  await setSetting('knowledge_base_backup', row.value);
  await setSetting('knowledge_base_backup_at', new Date().toISOString());
  await setSetting('knowledge_base', next);
  console.log(`[upgrade] Knowledge base updated to the openrings.org version; kept ${added.length} line(s) added in the admin panel.`);
  return true;
}
