import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../http.js';

/** Public channel endpoints: unsubscribe, referral redirects, chat widget, app install referrer. */
export function registerPublicChannelRoutes(_app: FastifyInstance, _ctx: ApiContext): void {}
