import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// API keys saved in the admin panel are stored encrypted (AES-256-GCM).
// The encryption key comes from SECRET_KEY in .env if set, otherwise from data/secret.key,
// which is created automatically the first time a key is saved. A database backup alone
// therefore never reveals the API keys. Keep data/secret.key with your backups, or re-enter
// the keys in Admin → AI provider after restoring on a new server.

export const SECRET_FILE = path.join(config.root, 'data', 'secret.key');
let cached = null;

function encryptionKey({ create }) {
  if (cached) return cached;
  if (process.env.SECRET_KEY) {
    cached = crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
    return cached;
  }
  try {
    const raw = Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8').trim(), 'base64');
    if (raw.length === 32) return (cached = raw);
  } catch {
    // not created yet
  }
  if (!create) return null;
  const raw = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  fs.writeFileSync(SECRET_FILE, raw.toString('base64') + '\n', { mode: 0o600 });
  return (cached = raw);
}

export function encryptSecret(plain) {
  if (!plain) return '';
  const key = encryptionKey({ create: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/** Returns the plain text, '' when nothing is stored, or null when it can't be decrypted. */
export function decryptSecret(stored) {
  if (!stored) return '';
  try {
    const key = encryptionKey({ create: false });
    if (!key || !stored.startsWith('v1:')) return null;
    const buf = Buffer.from(stored.slice(3), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const maskKey = (k) => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : '');
