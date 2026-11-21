// The Open Rings AI engine: the model server behind the "Open Rings AI" provider. It runs on your
// own machine (no API key, no per-use cost). The forum talks to it through the OpenAI-compatible
// API under /v1; setup uses the engine's management API under /api (version, models, download,
// create). scripts/setup-openrings-ai.js drives this module.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setSetting } from '../services/settings.js';
import { LOCAL_DEFAULTS } from '../services/ai-settings.js';
import { one, all } from '../db.js';
import { engineFetch } from '../lib/http.js';

export const ENGINE_MODEL = LOCAL_DEFAULTS.model; // "openrings-ai"
export const DEFAULT_BASE_MODEL = 'qwen2.5:7b';
export const CONTEXT_TOKENS = 16384; // room for the knowledge base, the whole thread and the answer

/** "http://127.0.0.1:11434/v1" → "http://127.0.0.1:11434" */
export const engineRoot = (url) => String(url || LOCAL_DEFAULTS.baseUrl).trim().replace(/\/+$/, '').replace(/\/v1$/, '');
export const ENGINE_DEFAULT_ROOT = engineRoot(LOCAL_DEFAULTS.baseUrl);

const JSON_HEADERS = { 'content-type': 'application/json' };

async function errorText(res) {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text).error || text || `HTTP ${res.status}`;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

/** The engine's version, or null when nothing answers at that address. */
export async function engineVersion(root) {
  try {
    const res = await engineFetch(`${engineRoot(root)}/api/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()).version || 'unknown';
  } catch {
    return null;
  }
}

/** Names of the models the engine has, e.g. ["openrings-ai:latest", "qwen2.5:7b"]. */
export async function engineModels(root) {
  const res = await engineFetch(`${engineRoot(root)}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Listing models failed: ${await errorText(res)}`);
  return ((await res.json()).models || []).map((m) => m.name || m.model).filter(Boolean);
}

export const hasModel = (names, name) => names.some((n) => n === name || n === `${name}:latest` || `${n}:latest` === name);

/**
 * Downloads a model. onProgress gets { done, total } in bytes (summed over all parts) and the
 * engine's status text. Large downloads take a while, so there is no timeout.
 */
export async function downloadModel(root, name, onProgress = () => {}) {
  const res = await engineFetch(`${engineRoot(root)}/api/pull`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ model: name, name, stream: true }),
  });
  if (!res.ok) throw new Error(`Downloading ${name} failed: ${await errorText(res)}`);
  const parts = new Map();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  const handle = (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.error) throw new Error(`Downloading ${name} failed: ${msg.error}`);
    if (msg.digest && msg.total) parts.set(msg.digest, { total: msg.total, done: msg.completed || 0 });
    if (msg.status === 'success') finished = true;
    let done = 0;
    let total = 0;
    for (const p of parts.values()) {
      done += p.done;
      total += p.total;
    }
    onProgress({ status: msg.status || '', done, total });
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
    }
  }
  handle(buffer + decoder.decode());
  if (!finished) throw new Error(`Downloading ${name} stopped before it finished. Run the setup again to resume.`);
}

/** Creates (or updates) "openrings-ai" from a downloaded base model. */
export async function createEngineModel(root, base = DEFAULT_BASE_MODEL) {
  const system = 'You are Open Rings AI, the answer writer of the OpenRings Community. Follow the instructions you are given exactly.';
  const parameters = { num_ctx: CONTEXT_TOKENS, temperature: 0.3 };
  // Newer engines read from/system/parameters; older ones read the modelfile text. Both say the same.
  const modelfile = `FROM ${base}\nPARAMETER num_ctx ${CONTEXT_TOKENS}\nPARAMETER temperature 0.3\nSYSTEM """${system}"""\n`;
  const res = await engineFetch(`${engineRoot(root)}/api/create`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ model: ENGINE_MODEL, name: ENGINE_MODEL, from: base, system, parameters, modelfile, stream: false }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`Creating ${ENGINE_MODEL} failed: ${await errorText(res)}`);
  const out = await res.json().catch(() => ({}));
  if (out.error) throw new Error(`Creating ${ENGINE_MODEL} failed: ${out.error}`);
}

/** One tiny request through the same API the forum uses. Returns the time taken in seconds. */
export async function testEngineModel(root, model = ENGINE_MODEL) {
  const started = Date.now();
  const res = await engineFetch(`${engineRoot(root)}/v1/chat/completions`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 }),
    signal: AbortSignal.timeout(10 * 60_000), // the first request loads the model into memory
  });
  if (!res.ok) throw new Error(`Test request failed: ${await errorText(res)}`);
  await res.json();
  return (Date.now() - started) / 1000;
}

/** Switches the forum to Open Rings AI at this address (takes effect within a few seconds). */
export async function useOpenRingsAi(root) {
  const r = engineRoot(root);
  await setSetting('ai_provider', 'local');
  await setSetting('local_base_url', r === ENGINE_DEFAULT_ROOT ? '' : `${r}/v1`);
  await setSetting('local_model', '');
}

export const isLocalAddress = (root) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(engineRoot(root));

/**
 * Starts the engine installed on this machine when it is not running. Windows: the engine app
 * (per-user install). Linux: its service, when run with administrator rights (the forum service
 * itself is not, but the engine service restarts by itself there). Returns true if it tried.
 */
export function startInstalledEngine({ log = () => {} } = {}) {
  if (process.platform === 'win32') {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama');
    for (const [exe, exeArgs] of [['ollama app.exe', []], ['ollama.exe', ['serve']]]) {
      const file = path.join(dir, exe);
      if (fs.existsSync(file)) {
        log('Starting the Open Rings AI engine...');
        spawn(file, exeArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return true;
      }
    }
    return false;
  }
  if (process.platform === 'linux' && process.getuid?.() === 0 && fs.existsSync('/etc/systemd/system/ollama.service')) {
    log('Starting the Open Rings AI engine service...');
    spawnSync('systemctl', ['enable', '--now', 'ollama'], { stdio: 'inherit' });
    return true;
  }
  return false;
}

let lastRecovery = 0;
/**
 * Called when the engine could not be reached: if it runs on this machine and is installed but
 * stopped, start it again (at most every 5 minutes, unless forced). Returns a short status text.
 */
export async function recoverEngine(baseUrl, { force = false } = {}) {
  if (await engineVersion(baseUrl)) return 'running';
  if (!isLocalAddress(baseUrl)) return 'remote';
  if (!force && Date.now() - lastRecovery < 5 * 60_000) return 'waiting';
  lastRecovery = Date.now();
  const tried = startInstalledEngine({ log: (m) => console.log(`[engine] ${m}`) });
  return tried ? 'starting' : 'not-installed';
}

/** Error text of answers that wait because the engine can't be reached (see EngineOfflineError). */
export const ENGINE_ERROR_PREFIX = 'The Open Rings AI engine';

/** Answers and follow-ups waiting for the engine: { waiting, since }. */
export async function engineOutage() {
  const row = await one(
    `SELECT COUNT(*) AS waiting, MIN(updated_at) AS since FROM jobs
     WHERE status = 'queued' AND last_error LIKE $1`,
    `${ENGINE_ERROR_PREFIX}%`,
  );
  return { waiting: row?.waiting || 0, since: row?.since || null };
}

/** The engine runs again: write the waiting answers now instead of at their next retry. */
export async function retryWaitingForEngine() {
  const rows = await all(
    `UPDATE jobs SET run_at = now(), updated_at = now() WHERE status = 'queued' AND last_error LIKE $1 RETURNING id`,
    `${ENGINE_ERROR_PREFIX}%`,
  );
  return rows.length;
}
