import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../http.js';

/** Unauthenticated endpoints (unsubscribe, referral redirects, chat widget, SDK ingestion). */
export function registerPublicRoutes(_app: FastifyInstance, _ctx: ApiContext): void {}
