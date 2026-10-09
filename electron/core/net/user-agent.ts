import { version } from '../../../package.json';

/** Outbound Node fetch identity. Search engines keep a browser UA in web-tools. */
export const AELION_USER_AGENT = `AelionBot/${version} (+https://aelion.chat)`;

const INSTALLED = Symbol.for('aelion.fetch-user-agent');

function asRequest(input: RequestInfo | URL) {
  if (typeof input !== 'object' || input === null || input instanceof URL) return;
  const headers = (input as Request).headers;
  if (typeof headers?.get !== 'function' || typeof headers?.set !== 'function') return;
  return input as Request;
}

export function withAelionUserAgent(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  if (init?.headers !== undefined) {
    const headers = new Headers(init.headers);
    if (!headers.get('user-agent')?.trim()) headers.set('user-agent', AELION_USER_AGENT);
    return { ...init, headers };
  }
  const request = asRequest(input);
  if (request) {
    if (!request.headers.get('user-agent')?.trim()) request.headers.set('user-agent', AELION_USER_AGENT);
    return init;
  }
  return { ...init, headers: { 'user-agent': AELION_USER_AGENT } };
}

export function installAelionUserAgent() {
  const current = globalThis.fetch as typeof fetch & { [INSTALLED]?: true };
  if (current[INSTALLED]) return;
  const original = globalThis.fetch.bind(globalThis);
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) =>
    original(input, withAelionUserAgent(input, init))) as typeof fetch & { [INSTALLED]?: true };
  wrapped[INSTALLED] = true;
  globalThis.fetch = wrapped;
}
