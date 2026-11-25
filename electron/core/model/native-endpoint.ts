import { modelEndpoint, validateModelEndpoint } from './model';
export const geminiBaseUrl = (url: string) => modelEndpoint(url.replace(/\/v1beta\/openai\/?$/, '/v1beta'), 'gemini');
/** Append the native route once. Only consume the version belonging to this protocol, keeping gateway mount paths. */
export function nativeEndpoint(value: string, route: string) {
  const url = new URL(validateModelEndpoint(value));
  let path = url.pathname.replace(/\/+$/, '');
  const version = ['/dream-machine/v1', '/api/v3', '/api/v1', '/ent/v2', '/sdapi/v1', '/v1beta', '/v2', '/v1'].find(
    (s) => route === s || route.startsWith(s + '/'),
  );
  if (version && path.endsWith(version)) path = path.slice(0, -version.length);
  else if (version === '/api/v1' && path.endsWith('/compatible-mode/v1'))
    path = path.slice(0, -'/compatible-mode/v1'.length);
  else if (version === '/v1beta' && path.endsWith('/v1beta/openai')) path = path.slice(0, -'/v1beta/openai'.length);
  return url.origin + path + route;
}
