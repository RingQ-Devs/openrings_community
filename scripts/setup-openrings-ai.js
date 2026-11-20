// Sets up Open Rings AI on this machine, then switches the forum to it:
//   1. installs the Open Rings AI engine (first time only) and starts it,
//   2. downloads the language model (about 5 GB, first time only),
//   3. creates the "openrings-ai" model, 4. tests it, 5. selects it in Admin → AI provider.
// Run it from the community folder:
//   Windows:  npm run ai:setup
//   Linux:    sudo node scripts/setup-openrings-ai.js   (administrator rights are needed to install the engine)
// Options:
//   --base <model>   language model to build on (default qwen2.5:7b)
//   --url <address>  engine on another machine, e.g. http://10.0.0.5:11434 (nothing is installed then)
//   --no-install     never install anything; only use an engine that is already running
//   --no-activate    don't change the forum's AI provider setting
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as engine from '../src/ai/engine.js';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);
const base = option('--base') || engine.DEFAULT_BASE_MODEL;
const root = engine.engineRoot(option('--url') || engine.ENGINE_DEFAULT_ROOT);
const isLocalAddress = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(root);

const step = (n, text) => console.log(`\n[${n}/5] ${text}`);
const ok = (text) => console.log(`      OK: ${text}`);
const fail = (text, fix) => {
  console.log(`\n      FAILED: ${text}${fix ? `\n      -> ${fix}` : ''}\n`);
  process.exit(1);
};
const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);

console.log('\nOpenRings Community - Open Rings AI setup');
console.log(`Engine address: ${root}`);

const totalGb = os.totalmem() / 1024 ** 3;
if (isLocalAddress && totalGb < 7.5) {
  console.log(
    `\nNote: this machine has ${totalGb.toFixed(1)} GB of memory. The default model needs about 8 GB free.` +
      '\n      For a smaller model add, for example: --base llama3.2:3b (check the model licence first).',
  );
}

// ---- 1. engine --------------------------------------------------------------------------------
step(1, 'Open Rings AI engine');
let version = await engine.engineVersion(root);
if (!version && isLocalAddress) {
  if (startInstalledEngine()) version = await waitForEngine(60);
  if (!version && !flag('--no-install')) {
    installEngine();
    startInstalledEngine();
    version = await waitForEngine(120);
  }
}
if (!version) {
  fail(
    `Nothing answered at ${root}.`,
    isLocalAddress
      ? process.platform === 'win32'
        ? 'Restart the PC (the engine starts when you log in), then run "npm run ai:setup" again.'
        : 'Start the engine service (sudo systemctl start ollama), then run this again.'
      : 'Check that the engine is running on that machine and that its port is reachable from here.',
  );
}
ok(`engine ${version} is running`);

// ---- 2. language model ------------------------------------------------------------------------
step(2, `Language model ${base}`);
let models = await engine.engineModels(root);
if (engine.hasModel(models, base)) {
  ok('already downloaded');
} else {
  console.log('      Downloading (about 5 GB for the default model; this takes a while the first time)...');
  let lastShown = -1;
  await engine
    .downloadModel(root, base, ({ done, total }) => {
      if (!total) return;
      const pct = Math.floor((done / total) * 100);
      if (process.stdout.isTTY) process.stdout.write(`\r      ${pct}%  (${gb(done)} of ${gb(total)} GB)   `);
      else if (pct >= lastShown + 10) console.log(`      ${pct}%  (${gb(done)} of ${gb(total)} GB)`);
      if (pct > lastShown) lastShown = pct;
    })
    .catch((err) => fail(err.message, 'Check the internet connection and free disk space, then run this again. The download resumes where it stopped.'));
  if (process.stdout.isTTY) process.stdout.write('\n');
  ok('downloaded');
}

// ---- 3. openrings-ai --------------------------------------------------------------------------
step(3, `Model "${engine.ENGINE_MODEL}"`);
await engine.createEngineModel(root, base).catch((err) => fail(err.message));
models = await engine.engineModels(root);
if (!engine.hasModel(models, engine.ENGINE_MODEL)) fail(`"${engine.ENGINE_MODEL}" was not created. Models on the engine: ${models.join(', ') || 'none'}.`);
ok(`"${engine.ENGINE_MODEL}" is ready (built on ${base})`);

// ---- 4. test ------------------------------------------------------------------------------------
step(4, 'Test answer (the first one loads the model into memory, so it can take a minute)');
const seconds = await engine.testEngineModel(root).catch((err) => fail(err.message, 'Check free memory. Close other large programs and run this again.'));
ok(`answered in ${seconds.toFixed(1)} s`);

// ---- 5. forum setting ---------------------------------------------------------------------------
step(5, 'Forum setting');
if (flag('--no-activate')) {
  console.log('      Skipped (--no-activate). In Admin → AI provider choose "Open Rings AI" and click "Save and test connection".');
} else {
  try {
    const { closeDb, migrate } = await import('../src/db.js');
    await migrate();
    await engine.useOpenRingsAi(root);
    await closeDb();
    ok('Admin → AI provider is now set to Open Rings AI. The running forum picks it up within a few seconds; no restart needed.');
  } catch (err) {
    console.log(`      Could not update the forum database (${err.message}).`);
    console.log('      In Admin → AI provider choose "Open Rings AI" and click "Save and test connection".');
  }
}
console.log('\nDone. Answers from Open Rings AI take from a few seconds (with a graphics card) to a few minutes (processor only).\n');

// ---- helpers ------------------------------------------------------------------------------------

/** Starts an engine that is installed but not running. Returns true if it tried. */
function startInstalledEngine() {
  if (process.platform === 'win32') {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama');
    for (const [exe, exeArgs] of [['ollama app.exe', []], ['ollama.exe', ['serve']]]) {
      const file = path.join(dir, exe);
      if (fs.existsSync(file)) {
        console.log('      Starting the engine...');
        spawn(file, exeArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return true;
      }
    }
    return false;
  }
  if (process.platform === 'linux' && process.getuid?.() === 0 && fs.existsSync('/etc/systemd/system/ollama.service')) {
    console.log('      Starting the engine service...');
    spawnSync('systemctl', ['enable', '--now', 'ollama'], { stdio: 'inherit' });
    return true;
  }
  return false;
}

function installEngine() {
  if (process.platform === 'win32') {
    console.log('      Installing the engine with the Windows Package Manager (winget)...');
    const r = spawnSync('winget', ['install', '--exact', '--id', 'Ollama.Ollama', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { stdio: 'inherit' });
    if (r.error) {
      fail(
        'winget is not available on this PC.',
        'Download and run the engine installer from https://ollama.com/download/OllamaSetup.exe, then run "npm run ai:setup" again.',
      );
    }
    return;
  }
  if (process.platform === 'linux') {
    if (process.getuid?.() !== 0) fail('Installing the engine needs administrator rights.', 'Run: sudo node scripts/setup-openrings-ai.js');
    console.log('      Installing the engine (it runs as its own service, listening on 127.0.0.1:11434 only)...');
    const r = spawnSync('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { stdio: 'inherit' });
    if (r.status !== 0) fail('The engine install did not finish.', 'Check the messages above (internet access, curl installed), then run this again.');
    return;
  }
  fail('Automatic install works on Windows and Linux.', 'Install the engine from https://ollama.com/download, start it, then run this again.');
}

async function waitForEngine(seconds) {
  for (let i = 0; i < seconds; i++) {
    const v = await engine.engineVersion(root);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
