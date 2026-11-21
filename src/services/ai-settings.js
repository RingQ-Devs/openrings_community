import { config } from '../config.js';
import { getSetting, setSetting } from './settings.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';

export const PROVIDERS = ['anthropic', 'openai', 'local', 'mock', 'none'];
export const LOCAL_DEFAULTS = { baseUrl: 'http://127.0.0.1:11434/v1', model: 'openrings-ai' };
export const CLAUDE_EFFORTS = ['low', 'medium', 'high'];
// 'default' = let the model decide (sends no reasoning setting)
export const OPENAI_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high'];

/**
 * The active AI settings. Values saved in Admin → AI provider win; .env values are the fallback,
 * so existing installs keep working.
 */
export async function getAiSettings() {
  const savedProvider = await getSetting('ai_provider');
  const claudeSaved = decryptSecret(await getSetting('anthropic_api_key_enc'));
  const openaiSaved = decryptSecret(await getSetting('openai_api_key_enc'));
  const localKey = decryptSecret(await getSetting('local_api_key_enc'));
  const claudeKey = claudeSaved || process.env.ANTHROPIC_API_KEY || '';
  const openaiKey = openaiSaved || process.env.OPENAI_API_KEY || '';
  const envProvider = (process.env.AI_PROVIDER || '').toLowerCase();
  const provider = savedProvider || envProvider || (claudeKey ? 'anthropic' : openaiKey ? 'openai' : 'none');
  const source = (saved, env) => (saved ? 'admin' : env ? 'env' : '');
  return {
    provider,
    providerSource: savedProvider ? 'admin' : envProvider ? 'env' : 'auto',
    anthropic: {
      apiKey: claudeKey,
      keySource: source(claudeSaved, process.env.ANTHROPIC_API_KEY),
      keyUnreadable: claudeSaved === null,
      model: (await getSetting('anthropic_model')) || config.ai.model,
      effort: (await getSetting('anthropic_effort')) || config.ai.effort,
      fallbacks: config.ai.fallbacks,
    },
    openai: {
      apiKey: openaiKey,
      keySource: source(openaiSaved, process.env.OPENAI_API_KEY),
      keyUnreadable: openaiSaved === null,
      model: (await getSetting('openai_model')) || config.ai.openaiModel,
      reasoningEffort: await (async () => {
        const saved = await getSetting('openai_reasoning_effort');
        return saved === 'default' ? '' : saved || config.ai.openaiReasoningEffort;
      })(),
    },
    // "Open Rings AI": the engine running on your own machine (any OpenAI-compatible server works). No API key needed.
    local: {
      baseUrl: (await getSetting('local_base_url')) || LOCAL_DEFAULTS.baseUrl,
      model: (await getSetting('local_model')) || LOCAL_DEFAULTS.model,
      apiKey: localKey || '',
      keySource: localKey ? 'admin' : '',
      keyUnreadable: localKey === null,
    },
  };
}

export function isConfigured(s) {
  return (
    s.provider === 'mock' ||
    (s.provider === 'anthropic' && !!s.anthropic.apiKey) ||
    (s.provider === 'openai' && !!s.openai.apiKey) ||
    (s.provider === 'local' && !!s.local.baseUrl && !!s.local.model)
  );
}

export async function aiConfigured() {
  return isConfigured(await getAiSettings());
}

export function modelLabel(s) {
  if (s.provider === 'anthropic') return `Claude · ${s.anthropic.model}`;
  if (s.provider === 'openai') return `OpenAI · ${s.openai.model}`;
  if (s.provider === 'local') return `Open Rings AI (self-hosted) · ${s.local.model}`;
  if (s.provider === 'mock') return 'Demo text (no AI)';
  return 'Off';
}

/** Save from the admin form. Empty key fields keep the saved key. */
export async function saveAiSettings(form) {
  const provider = PROVIDERS.includes(form.provider) ? form.provider : 'none';
  await setSetting('ai_provider', provider);
  for (const [name, setting] of [['anthropic', 'anthropic_api_key_enc'], ['openai', 'openai_api_key_enc'], ['local', 'local_api_key_enc']]) {
    const typed = String(form[`${name}_api_key`] || '').trim();
    if (form[`${name}_remove_key`]) await setSetting(setting, '');
    else if (typed) await setSetting(setting, encryptSecret(typed));
  }
  await setSetting('anthropic_model', String(form.anthropic_model || '').trim().slice(0, 100));
  await setSetting('anthropic_effort', CLAUDE_EFFORTS.includes(form.anthropic_effort) ? form.anthropic_effort : '');
  await setSetting('openai_model', String(form.openai_model || '').trim().slice(0, 100));
  await setSetting('openai_reasoning_effort', OPENAI_EFFORTS.includes(form.openai_reasoning_effort) ? form.openai_reasoning_effort : 'default');
  const url = String(form.local_base_url || '').trim();
  await setSetting('local_base_url', /^https?:\/\/[^\s]+$/i.test(url) ? url.replace(/\/+$/, '') : '');
  await setSetting('local_model', String(form.local_model || '').trim().slice(0, 100));
}
