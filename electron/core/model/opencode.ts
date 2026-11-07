/** Match the provider host, never a lookalike domain or an unrelated gateway's path. */
export function isOpenCodeEndpoint(baseUrl: string) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '');
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}
