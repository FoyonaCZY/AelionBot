// The local address automations are called on: POST http://127.0.0.1:<port>/hooks/<automation>/<secret>. It listens
// on the loopback interface only; other machines reach it through a tunnel the user sets up. The body, JSON or text,
// goes to the run as trigger details.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AutomationSignal } from '../../../shared/types/scheduled-types';

/** Tried in order; the first free one is used. */
const WEBHOOK_PORTS = Array.from({ length: 10 }, (_, index) => 47811 + index);
const BODY_BYTES = 64 * 1024;
/** Calls per automation per minute. */
const RATE = 30;

export interface WebhookTarget {
  /** The automation a call is for, when its secret matches and it is on. */
  find(id: string, token: string): { id: string; title: string } | undefined;
  fire(id: string, signal: AutomationSignal): boolean;
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_BYTES) return;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
/** The body as trigger details: JSON pretty-printed, anything else as text. */
function detail(body: string, contentType: string) {
  if (!body.trim()) return '（请求没有正文）';
  if (/json/i.test(contentType))
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {}
  return body;
}

export class AutomationWebhooks {
  private server?: Server;
  private port?: number;
  private calls = new Map<string, number[]>();
  constructor(private target: WebhookTarget) {}
  /** `http://127.0.0.1:<port>` while listening. */
  origin() {
    return this.port ? `http://127.0.0.1:${this.port}` : undefined;
  }
  async start(ports = WEBHOOK_PORTS) {
    for (const port of ports) {
      const server = createServer((request, response) => void this.handle(request, response));
      const listening = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (!listening) continue;
      server.on('error', () => {});
      this.server = server;
      this.port = (server.address() as { port: number }).port;
      return this.origin();
    }
  }
  async stop() {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  private allowed(id: string) {
    const now = Date.now(),
      recent = (this.calls.get(id) || []).filter((at) => now - at < 60_000);
    if (recent.length >= RATE) return false;
    recent.push(now);
    this.calls.set(id, recent);
    return true;
  }
  private async handle(request: IncomingMessage, response: import('node:http').ServerResponse) {
    const reply = (status: number, body: Record<string, unknown>) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    // A web page in a browser could reach this port; only loopback names in Host are accepted, against DNS rebinding.
    const host = String(request.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return reply(403, { error: 'forbidden host' });
    const match = /^\/hooks\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{16,128})\/?$/.exec(
      new URL(request.url || '/', 'http://127.0.0.1').pathname,
    );
    if (!match) return reply(404, { error: 'not found' });
    if (request.method !== 'POST') return reply(405, { error: 'use POST' });
    const automation = this.target.find(match[1], match[2]);
    if (!automation) return reply(404, { error: 'not found' });
    if (!this.allowed(automation.id)) return reply(429, { error: 'too many calls' });
    const body = await readBody(request);
    if (body === undefined) return reply(413, { error: 'body over 64 KB' });
    const accepted = this.target.fire(automation.id, {
      kind: 'webhook',
      detail: detail(body, String(request.headers['content-type'] || '')),
    });
    reply(accepted ? 202 : 409, { accepted, automation: automation.title });
  }
}
