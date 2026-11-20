import { EventEmitter } from 'node:events';

/** In-process signals, e.g. "a job is due now" so the worker starts it right away. */
export const bus = new EventEmitter();
