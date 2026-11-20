import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (value, fallback) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);

function normalizeBase(base) {
  if (!base || base === '/') return '';
  return '/' + base.replace(/^\/+|\/+$/g, '');
}

const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  root,
  isProduction,
  port: Number(process.env.PORT || 3000),
  // 127.0.0.1 = only this computer can open the site (use 0.0.0.0 inside Docker or to test from other devices)
  host: process.env.HOST || '127.0.0.1',
  // Public origin only (no path), e.g. https://openrings.org
  siteUrl: (process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  // Mount path, e.g. "/community" when served at https://openrings.org/community/
  basePath: normalizeBase(process.env.BASE_PATH || ''),
  siteName: process.env.SITE_NAME || 'OpenRings Community',
  productName: process.env.PRODUCT_NAME || 'OpenRings',
  // The main website. The forum header repeats its menu, with "Community" added.
  mainSiteUrl: (process.env.MAIN_SITE_URL || 'https://openrings.org').replace(/\/+$/, ''),
  docsUrl: process.env.DOCS_URL || 'https://openrings.org/docs/',
  db: {
    // Either one connection string ...
    url: process.env.DATABASE_URL || '',
    // ... or separate settings (easier when the password has special characters)
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'openrings_community',
    user: process.env.DB_USER || 'openrings',
    password: process.env.DB_PASSWORD || '',
    // Postgres schema for the forum tables ("public" in a dedicated database)
    schema: process.env.DB_SCHEMA || 'public',
    ssl: bool(process.env.DB_SSL, false),
    poolSize: Number(process.env.DB_POOL_SIZE || 10),
  },
  cookieSecure: bool(process.env.COOKIE_SECURE, isProduction),
  // "loopback", a hop count like "1", or a comma-separated list of proxy IPs
  trustProxy: /^\d+$/.test(process.env.TRUST_PROXY || '') ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY || 'loopback',
  timezone: process.env.SITE_TIMEZONE || 'UTC',
  runWorkers: bool(process.env.RUN_WORKERS, true),
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS || 5000),
  // Defaults for the AI provider. Admin → AI provider overrides these; keys can live there instead of .env.
  ai: {
    model: process.env.AI_MODEL || 'claude-opus-5-5',
    effort: process.env.AI_EFFORT || 'medium',
    // Server-side fallback when the Claude model declines a request. Set AI_FALLBACKS=off to disable.
    fallbacks: bool(process.env.AI_FALLBACKS, true),
    openaiModel: process.env.OPENAI_MODEL || 'gpt-5.5',
    openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT || '',
  },
  admin: {
    username: process.env.ADMIN_USERNAME || '',
    email: process.env.ADMIN_EMAIL || '',
    password: process.env.ADMIN_PASSWORD || '',
  },
};
