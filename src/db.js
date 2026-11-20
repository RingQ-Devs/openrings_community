import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from './config.js';

// Return BIGINT (COUNT/SUM) as numbers and timestamps as ISO-8601 strings.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const toIso = (v) => new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString();
pg.types.setTypeParser(1184, toIso); // timestamptz
pg.types.setTypeParser(1114, (v) => toIso(v + '+00')); // timestamp

const { db: c } = config;
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.schema)) throw new Error(`Invalid DB_SCHEMA "${c.schema}"`);

export const pool = new pg.Pool({
  ...(c.url ? { connectionString: c.url } : { host: c.host, port: c.port, database: c.database, user: c.user, password: c.password }),
  ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
  max: c.poolSize,
  options: `-c search_path=${c.schema} -c TimeZone=UTC`,
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

const txStore = new AsyncLocalStorage();
const executor = () => txStore.getStore() || pool;

export const query = (text, params = []) => executor().query(text, params);
/** First row or undefined. */
export const one = async (text, ...params) => (await query(text, params)).rows[0];
/** All rows. */
export const all = async (text, ...params) => (await query(text, params)).rows;
/** Value of the first column of the first row. */
export const val = async (text, ...params) => {
  const row = (await query(text, params)).rows[0];
  return row ? Object.values(row)[0] : undefined;
};
/** Run a statement; returns { rowCount, rows }. */
export const run = (text, ...params) => query(text, params);

/** Run fn in a transaction. Queries made inside fn (even in other modules) join it. */
export async function tx(fn) {
  if (txStore.getStore()) return fn();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await txStore.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const nowIso = () => new Date().toISOString();

let migrated = null;
/** Create the schema and tables if they don't exist yet. */
export function migrate() {
  migrated ??= (async () => {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('openrings_community_schema'))");
      if (c.schema !== 'public') await client.query(`CREATE SCHEMA IF NOT EXISTS ${c.schema}`);
      await client.query(fs.readFileSync(path.join(config.root, 'src', 'schema.sql'), 'utf8'));
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('openrings_community_schema'))").catch(() => {});
      client.release();
    }
  })();
  return migrated;
}

export const closeDb = () => pool.end();
