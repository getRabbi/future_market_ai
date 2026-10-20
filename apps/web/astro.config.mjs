import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

/**
 * Static build for Cloudflare Pages (D-013). The control plane is a client-rendered React
 * island per page; all data comes from the FUTUREGROW API. `PUBLIC_API_BASE` is empty when the
 * Pages Functions proxy serves /v1 and /api/auth on the same origin, or the API origin when a
 * custom same-site domain is used (app.<domain> → api.<domain>).
 */
export default defineConfig({
  output: 'static',
  integrations: [react()],
  build: { format: 'directory' },
  server: { port: 4321 },
});
