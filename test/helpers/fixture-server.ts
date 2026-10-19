import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: unknown;
  form: URLSearchParams | null;
}

export interface FixtureResponse {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  body?: Buffer;
}

type Handler = (req: RecordedRequest) => FixtureResponse | Promise<FixtureResponse>;

/**
 * Minimal programmable HTTP server for provider contract tests. Routes match on method and a
 * path string or RegExp; unmatched requests return 599 so tests fail loudly.
 */
export class FixtureServer {
  readonly requests: RecordedRequest[] = [];
  private routes: { method: string; path: string | RegExp; handler: Handler }[] = [];
  private server: http.Server | null = null;
  baseUrl = '';

  on(method: string, path: string | RegExp, handler: Handler | FixtureResponse): this {
    this.routes.push({ method, path, handler: typeof handler === 'function' ? handler : () => handler });
    return this;
  }

  reset(): void {
    this.routes = [];
    this.requests.length = 0;
  }

  find(method: string, path: string | RegExp): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path)));
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const url = new URL(req.url ?? '/', 'http://fixture');
        const body = Buffer.concat(chunks).toString('utf8');
        const ct = req.headers['content-type'] ?? '';
        let json: unknown = null;
        if (ct.includes('json') && body) {
          try {
            json = JSON.parse(body);
          } catch {
            json = null;
          }
        }
        const rec: RecordedRequest = {
          method: req.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body,
          json,
          form: ct.includes('x-www-form-urlencoded') ? new URLSearchParams(body) : null,
        };
        this.requests.push(rec);
        const route = [...this.routes].reverse().find(
          (r) => r.method === rec.method && (typeof r.path === 'string' ? r.path === rec.path : r.path.test(rec.path)),
        );
        if (!route) {
          res.writeHead(599, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `no fixture for ${rec.method} ${rec.path}` }));
          return;
        }
        try {
          const out = await route.handler(rec);
          const headers = { ...(out.headers ?? {}) };
          let payload: Buffer | string = '';
          if (out.json !== undefined) {
            headers['content-type'] ??= 'application/json';
            payload = JSON.stringify(out.json);
          } else if (out.body) payload = out.body;
          else if (out.text !== undefined) payload = out.text;
          res.writeHead(out.status ?? 200, headers);
          res.end(payload);
        } catch (err) {
          res.writeHead(598, { 'content-type': 'text/plain' });
          res.end(String(err));
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
