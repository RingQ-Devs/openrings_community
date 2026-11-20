import crypto from 'node:crypto';

/**
 * Configure env for an isolated test schema and mock AI, then load the app.
 * Needs TEST_DATABASE_URL, e.g. postgres://openrings:password@localhost:5432/openrings_community
 * Tests create a throwaway schema (test_xxxx) and drop it afterwards; real data is not touched.
 */
export async function setup({ env = {} } = {}) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to run the tests (see README).');
  const schema = `test_${crypto.randomBytes(4).toString('hex')}`;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DB_SCHEMA = schema;
  process.env.AI_PROVIDER = 'mock';
  process.env.SECRET_KEY = 'test-secret-key';
  Object.assign(process.env, env);
  process.env.RUN_WORKERS = 'false';
  process.env.SITE_URL = 'http://localhost';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_EMAIL = 'admin@example.com';
  process.env.ADMIN_PASSWORD = 'admin-password-1';
  const { createApp } = await import('../src/app.js');
  const app = await createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = await import('../src/db.js');
  const worker = await import('../src/worker.js');
  const seeder = await import('../src/ai/seeder.js');
  const settings = await import('../src/services/settings.js');
  const security = await import('../src/lib/security.js');
  return {
    base, db, worker, seeder, settings,
    resetRateLimits: security.resetRateLimits,
    async close() {
      await new Promise((r) => server.close(r));
      await db.run(`DROP SCHEMA ${schema} CASCADE`);
      await db.closeDb();
    },
    client: () => new Client(base),
    /** Make every queued job due now and run them. */
    async runJobsNow() {
      for (let i = 0; i < 10; i++) {
        await db.run(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'queued'`);
        if ((await worker.runDueJobs(20)) === 0) break;
      }
    },
  };
}

export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }
  get csrf() {
    return this.cookies.get('csrf');
  }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = decodeURIComponent(pair.slice(i + 1));
      if (/Expires=Thu, 01 Jan 1970/.test(c) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  headers(extra = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    return { ...(cookie ? { cookie } : {}), ...extra };
  }
  async get(path) {
    const res = await fetch(this.base + path, { headers: this.headers(), redirect: 'manual' });
    this.store(res);
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  async post(path, form = {}, { csrf = true, json = false } = {}) {
    if (!this.csrf) await this.get('/');
    const body = new URLSearchParams({ ...(csrf ? { _csrf: this.csrf } : {}), ...form });
    const res = await fetch(this.base + path, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded', ...(json ? { accept: 'application/json' } : {}) }),
      body,
      redirect: 'manual',
    });
    this.store(res);
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, json: json ? JSON.parse(text) : undefined };
  }
  async register(username, password = 'password-123') {
    const r = await this.post('/register', { username, email: `${username}@example.com`, password, agree: '1' });
    if (r.status !== 302) throw new Error(`register failed: ${r.status} ${r.text.slice(0, 300)}`);
    return r;
  }
  async login(login, password) {
    return this.post('/login', { login, password });
  }
}
