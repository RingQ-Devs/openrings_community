// HTTP for the Open Rings AI engine. Node's built-in fetch gives up when a response takes more than
// 5 minutes to start, and a long answer from an engine without a graphics card can take longer.
// This client waits as long as the answer timeout instead.
import { Agent, fetch as undiciFetch } from 'undici';

export const ENGINE_TIMEOUT_MS = 15 * 60_000;

export const engineAgent = new Agent({
  headersTimeout: ENGINE_TIMEOUT_MS,
  bodyTimeout: ENGINE_TIMEOUT_MS,
  keepAliveTimeout: 10_000,
});

/** fetch() for engine requests (same API as the built-in fetch). */
export const engineFetch = (url, init = {}) => undiciFetch(url, { dispatcher: engineAgent, ...init });

/** Options for an OpenAI SDK client that talks to the engine. */
export const engineClientOptions = () => ({ fetch: undiciFetch, fetchOptions: { dispatcher: engineAgent } });
