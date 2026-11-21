import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { LOCAL_DEFAULTS } from '../services/ai-settings.js';
import { ENGINE_TIMEOUT_MS, engineClientOptions } from '../lib/http.js';

/**
 * Checks the chosen provider: the key, the model and (with testCall) the credit/quota.
 * Returns [{ ok: true|false|null, message, fix? }]. ok=null means a warning.
 */
export async function checkAiConnection(s, { testCall = true } = {}) {
  const out = [];
  if (s.provider === 'mock') return [{ ok: null, message: 'Demo mode: drafts are clearly marked demo text, no AI is called.' }];
  if (s.provider === 'none') return [{ ok: null, message: 'AI is off. The forum works, but there are no drafts or daily posts.' }];

  if (s.provider === 'anthropic') {
    if (!s.anthropic.apiKey) return [{ ok: false, message: 'Claude is selected but no API key is set.', fix: 'Paste a key from https://platform.claude.com/settings/keys' }];
    const client = new Anthropic({ apiKey: s.anthropic.apiKey });
    try {
      const model = await client.models.retrieve(s.anthropic.model);
      out.push({ ok: true, message: `Claude API key works, model ${model.id} is available.` });
      if (testCall) {
        await client.messages.create({ model: s.anthropic.model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with OK.' }] });
        out.push({ ok: true, message: 'Test call succeeded: the account has API credit.' });
      }
    } catch (err) {
      const status = err?.status;
      out.push({
        ok: false,
        message: `Claude API: ${err.message}`,
        fix: /credit balance/i.test(String(err?.message))
          ? 'The key is fine but the account has no credit. In the Claude Console open "Plans & Billing" and buy credits.'
          : status === 401 ? 'The API key is invalid or was disabled. Create a new key at https://platform.claude.com/settings/keys'
          : status === 404 ? `Model "${s.anthropic.model}" is not available to this key. Clear the model field to use the default.`
          : 'Check the server can reach api.anthropic.com, and the key.',
      });
    }
    return out;
  }

  if (s.provider === 'openai') {
    if (!s.openai.apiKey) return [{ ok: false, message: 'OpenAI is selected but no API key is set.', fix: 'Paste a key from https://platform.openai.com/api-keys' }];
    const client = new OpenAI({ apiKey: s.openai.apiKey });
    try {
      const model = await client.models.retrieve(s.openai.model);
      out.push({ ok: true, message: `OpenAI API key works, model ${model.id} is available.` });
      if (testCall) {
        await client.responses.create({ model: s.openai.model, input: 'Reply with OK.', max_output_tokens: 64, store: false });
        out.push({ ok: true, message: 'Test call succeeded: the account has API quota.' });
      }
    } catch (err) {
      const status = err?.status;
      out.push({
        ok: false,
        message: `OpenAI API: ${err.message}`,
        fix: err?.code === 'insufficient_quota' || /exceeded your current quota/i.test(String(err?.message))
          ? 'The key is fine but the account has no quota. Add credits or a payment method in your OpenAI billing settings.'
          : status === 401 ? 'The API key is invalid or was revoked. Create a new key at https://platform.openai.com/api-keys'
          : status === 404 ? `Model "${s.openai.model}" is not available to this key. Enter a model your account can use.`
          : 'Check the server can reach api.openai.com, and the key.',
      });
    }
    return out;
  }
  if (s.provider === 'local') {
    const { baseUrl, model } = s.local;
    if (!baseUrl || !model) return [{ ok: false, message: 'Open Rings AI needs a server address and a model name.' }];
    if (model !== LOCAL_DEFAULTS.model && /^open[\s_-]*rings?[\s_-]*ai(:latest)?$/i.test(model) && model.replace(/:latest$/, '') !== LOCAL_DEFAULTS.model) {
      out.push({ ok: false, message: `Model name is "${model}". The setup creates "${LOCAL_DEFAULTS.model}".`, fix: `Clear the Model name field (it then uses "${LOCAL_DEFAULTS.model}") and save.` });
    }
    const client = new OpenAI({ apiKey: s.local.apiKey || 'not-needed', baseURL: baseUrl, timeout: ENGINE_TIMEOUT_MS, maxRetries: 0, ...engineClientOptions() });
    try {
      let listed = null;
      try {
        listed = (await client.models.list()).data.map((m) => m.id);
      } catch (err) {
        if (!(err instanceof OpenAI.NotFoundError)) throw err; // some servers have no model list
      }
      if (listed) {
        const has = (name) => listed.some((id) => id === name || id === `${name}:latest` || `${id}:latest` === name);
        if (!has(model)) {
          out.push({
            ok: false,
            message: `The Open Rings AI engine at ${baseUrl} is running, but it has no model called "${model}". Models on it: ${listed.join(', ') || 'none'}.`,
            fix: has(LOCAL_DEFAULTS.model)
              ? `Did you mean "${LOCAL_DEFAULTS.model}"? Clear the Model name field (it then uses "${LOCAL_DEFAULTS.model}") and save.`
              : `Run "npm run ai:setup" in the forum folder to create "${LOCAL_DEFAULTS.model}", or type one of the names listed.`,
          });
          return out;
        }
        out.push({ ok: true, message: `The Open Rings AI engine at ${baseUrl} is running and has the model "${model}".` });
      } else {
        out.push({ ok: null, message: `The server at ${baseUrl} answered, but it does not list its models.` });
      }
      if (testCall) {
        const started = Date.now();
        await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 });
        out.push({ ok: true, message: `Test call succeeded in ${((Date.now() - started) / 1000).toFixed(1)} s. A full answer is a few hundred words, so expect it to take longer.` });
      }
    } catch (err) {
      out.push({
        ok: false,
        message: err instanceof OpenAI.APIConnectionError && !(err instanceof OpenAI.APIConnectionTimeoutError)
          ? `The Open Rings AI engine is not running at ${baseUrl}.`
          : `Open Rings AI: ${err.message}`,
        fix: err instanceof OpenAI.APIConnectionError && !(err instanceof OpenAI.APIConnectionTimeoutError)
          ? 'Set it up once on this machine: open a terminal in the forum folder and run "npm run ai:setup" (Linux: sudo node scripts/setup-openrings-ai.js). If it is already set up, start it. If it runs on another machine, enter that machine\'s address.'
          : err?.status === 404 ? `The engine does not have the model "${model}". Run "npm run ai:setup" in the forum folder to create it.`
          : 'Check the engine address and the model name.',
      });
    }
    return out;
  }
  return [{ ok: false, message: `Unknown provider "${s.provider}".` }];
}
