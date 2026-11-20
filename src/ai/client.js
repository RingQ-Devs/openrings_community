import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import OpenAI from 'openai';
import { zodTextFormat, zodResponseFormat } from 'openai/helpers/zod';
import { getAiSettings } from '../services/ai-settings.js';

// One client per key/server, so a change in the admin panel takes effect immediately.
const clients = new Map();
const clientFor = (Kind, apiKey, extra = {}) => {
  const id = `${Kind.name}:${apiKey}:${extra.baseURL || ''}`;
  if (!clients.has(id)) clients.set(id, new Kind({ apiKey, ...extra }));
  return clients.get(id);
};
// Self-hosted models on a CPU can take minutes per answer.
const LOCAL_TIMEOUT_MS = 15 * 60_000;

export class AiRefusalError extends Error {}
export class AiNotConfiguredError extends Error {}
/** The Open Rings AI engine is not running (or not reachable) at the configured address. */
export class EngineOfflineError extends Error {}

/**
 * One model call that returns JSON validated against a Zod schema.
 * The provider is chosen with AI_PROVIDER (see config.js).
 *
 * - system: stable instructions + knowledge base (cached by both providers)
 * - prompt: the per-request content
 * - mock:   function returning canned data when AI_PROVIDER=mock (local testing)
 */
export async function generateStructured({ system, prompt, schema, mock, maxTokens = 16000 }) {
  const s = await getAiSettings();
  if (s.provider === 'mock') return { data: schema.parse(mock()), usage: null, model: 'mock' };
  if (s.provider === 'anthropic' && s.anthropic.apiKey) return generateWithClaude(s.anthropic, { system, prompt, schema, maxTokens });
  if (s.provider === 'openai' && s.openai.apiKey) return generateWithOpenAI(s.openai, { system, prompt, schema, maxTokens });
  if (s.provider === 'local' && s.local.baseUrl && s.local.model) return generateWithLocal(s.local, { system, prompt, schema, maxTokens });
  throw new AiNotConfiguredError('AI is not configured. Choose a provider and enter its API key in Admin → AI provider.');
}

// ---- Claude (Anthropic) ---------------------------------------------------------------

async function generateWithClaude(opts, { system, prompt, schema, maxTokens }) {
  const params = {
    model: opts.model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: opts.effort, format: betaZodOutputFormat(schema) },
  };
  if (opts.fallbacks) {
    // If the model declines for policy reasons, retry server-side on Anthropic's recommended fallback.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  const response = await clientFor(Anthropic, opts.apiKey).beta.messages.parse(params);

  if (response.stop_reason === 'refusal') {
    throw new AiRefusalError(`Model declined the request (${response.stop_details?.category ?? 'no category'})`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('AI response was cut off (max_tokens reached).');
  if (!response.parsed_output) throw new Error('AI response did not match the expected format.');

  const usage = {
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
    cache_read_input_tokens: response.usage?.cache_read_input_tokens ?? 0,
  };
  return { data: response.parsed_output, usage, model: response.model };
}

// ---- OpenAI ------------------------------------------------------------------------------

async function generateWithOpenAI(opts, { system, prompt, schema, maxTokens }) {
  const params = {
    model: opts.model,
    instructions: system,
    input: prompt,
    text: { format: zodTextFormat(schema, 'answer') }, // strict JSON schema
    max_output_tokens: maxTokens,
    store: false, // don't keep the conversation on OpenAI's side
    prompt_cache_key: 'openrings-community', // same instructions every time: helps automatic prompt caching
  };
  if (opts.reasoningEffort) params.reasoning = { effort: opts.reasoningEffort };

  const response = await clientFor(OpenAI, opts.apiKey).responses.parse(params);

  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'refusal') throw new AiRefusalError(`Model declined the request: ${part.refusal}`);
    }
  }
  if (response.status === 'incomplete') {
    throw new Error(`AI response was cut off (${response.incomplete_details?.reason ?? 'incomplete'}).`);
  }
  if (!response.output_parsed) throw new Error('AI response did not match the expected format.');

  const usage = {
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
    cache_read_input_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
  };
  return { data: response.output_parsed, usage, model: response.model };
}

// ---- Open Rings AI (the self-hosted engine, or any OpenAI-compatible server) -------------

/**
 * Uses /v1/chat/completions, which every OpenAI-compatible server supports. Asks for a strict
 * JSON schema first; if the server rejects that, falls back to plain JSON mode, then to no
 * format option. The schema is also spelled out in the instructions, and every answer is
 * validated, so small local models that drift are caught.
 */
async function generateWithLocal(opts, { system, prompt, schema, maxTokens }) {
  const client = clientFor(OpenAI, opts.apiKey || 'not-needed', { baseURL: opts.baseUrl, timeout: LOCAL_TIMEOUT_MS, maxRetries: 1 });
  const strict = zodResponseFormat(schema, 'answer');
  const messages = [
    { role: 'system', content: `${system}\n\nReply with one JSON object only, with no other text, matching this JSON schema:\n${JSON.stringify(strict.json_schema.schema)}` },
    { role: 'user', content: prompt },
  ];
  let lastError = null;
  for (const format of [strict, { type: 'json_object' }, null]) {
    let completion;
    try {
      completion = await client.chat.completions.create({
        model: opts.model,
        messages,
        max_tokens: Math.min(maxTokens, 4096),
        ...(format ? { response_format: format } : {}),
      });
    } catch (err) {
      if (err instanceof OpenAI.APIConnectionError && !(err instanceof OpenAI.APIConnectionTimeoutError)) {
        throw new EngineOfflineError(
          `The Open Rings AI engine is not running at ${opts.baseUrl}. Start it, or set it up with "npm run ai:setup" (see Admin → AI provider).`,
        );
      }
      // The server doesn't understand this response_format: try a simpler one.
      if (format && err instanceof OpenAI.BadRequestError && !/model/i.test(String(err.message))) {
        lastError = err;
        continue;
      }
      throw err;
    }
    const choice = completion.choices?.[0];
    const data = parseJsonLoosely(choice?.message?.content ?? '', schema);
    if (data) {
      const usage = { input_tokens: completion.usage?.prompt_tokens ?? 0, output_tokens: completion.usage?.completion_tokens ?? 0, cache_read_input_tokens: 0 };
      return { data, usage, model: completion.model || opts.model };
    }
    lastError = new Error(
      choice?.finish_reason === 'length'
        ? 'AI response was cut off. Give the model a larger context window (see the Open Rings AI setup guide).'
        : 'AI response did not match the expected format.',
    );
  }
  throw lastError;
}

function parseJsonLoosely(text, schema) {
  const trimmed = String(text).trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
    trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1),
  ];
  for (const c of candidates) {
    try {
      const result = schema.safeParse(JSON.parse(c));
      if (result.success) return result.data;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ---- error handling (all providers) ------------------------------------------------------

/** The account has no credit / quota left. Retry once topped up. */
export function isCreditError(err) {
  if (err instanceof Anthropic.APIError && /credit balance/i.test(String(err.message))) return true;
  if (err instanceof OpenAI.APIError && (err.code === 'insufficient_quota' || /exceeded your current quota/i.test(String(err.message)))) return true;
  return false;
}

/** Errors that will fail the same way on retry (bad request, auth, refusal, not configured). */
export function isPermanentAiError(err) {
  if (isCreditError(err)) return false;
  return (
    err instanceof AiRefusalError ||
    err instanceof AiNotConfiguredError ||
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof OpenAI.BadRequestError ||
    err instanceof OpenAI.AuthenticationError ||
    err instanceof OpenAI.PermissionDeniedError ||
    err instanceof OpenAI.NotFoundError
  );
}

/** How a failed AI job is retried: { maxAttempts, maxBackoffSeconds }. */
export function retryPolicy(err) {
  // Out of credit: keep retrying every hour for a day, so jobs resume after a top-up.
  if (isCreditError(err)) return { maxAttempts: 26, maxBackoffSeconds: 3600 };
  // Engine not running: same, so answers are written once it is started.
  if (err instanceof EngineOfflineError) return { maxAttempts: 26, maxBackoffSeconds: 3600 };
  if (isPermanentAiError(err)) return { maxAttempts: 1, maxBackoffSeconds: 0 };
  return { maxAttempts: 3, maxBackoffSeconds: 3600 };
}
