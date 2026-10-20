import { type Env, proxy } from '../../src/server/proxy.js';

export const onRequest = (context: { request: Request; env: Env }): Promise<Response> => proxy(context.request, context.env);
