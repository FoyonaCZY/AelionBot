import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { boundedInteger, textPage, FileToolError } from './file-text';
import { abortable } from '../app/abortable';
import { AELION_USER_AGENT } from '../net/user-agent';

const LIMIT = 2 * 1024 * 1024;
function requestHeaders() {
  return {
    'User-Agent': AELION_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/rss+xml,application/xml,text/plain,application/json',
    'Accept-Language': 'en-US,en;q=0.8,zh-CN;q=0.6',
    'Accept-Encoding': 'identity',
  };
}
export function publicWebUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 4000) throw new FileToolError('INVALID_URL', '请输入有效的网页 URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FileToolError('INVALID_URL', '请输入包含 https:// 的完整 URL');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new FileToolError('INVALID_URL', '网页工具仅访问无嵌入凭据的 HTTP/HTTPS 地址');
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (isIP(host) && !publicAddress(host))
  )
    throw new FileToolError('PRIVATE_NETWORK', '网页工具不访问本机、内网或云元数据地址');
  url.hash = '';
  return url;
}
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(value) && !/^(?:2001:0{0,4}:|2001:0?db8:|2002:)/.test(value);
  }
  return false;
}
/**
 * Clash/Mihomo/sing-box answer proxied domains with an address in 198.18.0.0/15.
 * It is a local placeholder, not a real destination: the TUN proxy resolves the
 * original hostname. Accept it for DNS answers while literal private IP URLs stay blocked.
 */
export function fakeIpAddress(address: string) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}
export interface WebDocument {
  url: string;
  body: string;
  contentType: string;
}
export type WebLoader = (url: string, signal: AbortSignal) => Promise<WebDocument>;
export interface PublicRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
/**
 * One HTTP request to a public address. Every hop is resolved first and refused when any address is local or private,
 * and the connection goes to the address that was checked, so DNS cannot be switched to a local one in between.
 * GET and HEAD follow redirects; other methods return them.
 */
export async function requestPublic(value: string, init: PublicRequest, signal: AbortSignal) {
  let url = publicWebUrl(value);
  const method = (init.method || 'GET').toUpperCase(),
    follow = method === 'GET' || method === 'HEAD';
  const combined = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    combined.throwIfAborted();
    const addresses = await abortable(combined, () => lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }));
    combined.throwIfAborted();
    if (!addresses.length || addresses.some((item) => !publicAddress(item.address) && !fakeIpAddress(item.address)))
      throw new FileToolError('PRIVATE_NETWORK', '目标解析到本机或内网地址，已停止请求');
    const selected = addresses[0];
    const response = await new Promise<{ status: number; headers: Record<string, any>; bytes: Buffer }>(
      (resolve, reject) => {
        const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          {
            method,
            signal: combined,
            family: selected.family,
            headers: { ...requestHeaders(), ...init.headers },
            lookup: ((_host: any, _options: any, done: any) => done(null, selected.address, selected.family)) as any,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk) => {
              size += chunk.length;
              if (size > LIMIT) {
                req.destroy(new FileToolError('WEB_TOO_LARGE', '网页超过 2 MB，请缩小读取范围'));
                return;
              }
              chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () =>
              resolve({ status: res.statusCode || 0, headers: res.headers, bytes: Buffer.concat(chunks) }),
            );
          },
        );
        req.on('error', reject);
        req.end(init.body);
      },
    );
    if (follow && [301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      url = publicWebUrl(new URL(response.headers.location, url).href);
      continue;
    }
    let bytes = response.bytes;
    const encoding = response.headers['content-encoding'];
    if (encoding === 'gzip') bytes = gunzipSync(bytes, { maxOutputLength: LIMIT });
    else if (encoding === 'deflate') bytes = inflateSync(bytes, { maxOutputLength: LIMIT });
    else if (encoding === 'br') bytes = brotliDecompressSync(bytes, { maxOutputLength: LIMIT });
    const contentType = String(response.headers['content-type'] || '');
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] || 'utf-8';
    let body: string;
    try {
      body = new TextDecoder(charset).decode(bytes);
    } catch {
      body = bytes.toString('utf8');
    }
    return { url: url.href, status: response.status, contentType, body };
  }
  throw new FileToolError('WEB_REDIRECT_LIMIT', '网页重定向次数过多');
}
async function loadPublicPage(value: string, signal: AbortSignal): Promise<WebDocument> {
  const response = await requestPublic(value, {}, signal);
  if (response.status < 200 || response.status >= 300)
    throw new FileToolError('WEB_HTTP_ERROR', `网页返回 HTTP ${response.status}`);
  const contentType = response.contentType || 'text/html';
  if (!/text\/|json|xml/.test(contentType))
    throw new FileToolError('WEB_UNSUPPORTED_CONTENT', '该地址不是文本网页，请通过附件或下载工具处理');
  return { url: response.url, body: response.body, contentType };
}
export function extractWebPage(document: WebDocument) {
  if (!/html/i.test(document.contentType))
    return { title: document.url, text: document.body, links: [] as Array<{ text: string; url: string }> };
  const { document: dom } = parseHTML(document.body),
    title = dom.querySelector('title')?.textContent?.trim() || document.url;
  for (const node of dom.querySelectorAll('script,style,noscript,svg,iframe,object,template')) node.remove();
  const links = [...dom.querySelectorAll('a[href]')]
    .flatMap((node) => {
      try {
        const url = publicWebUrl(new URL(node.getAttribute('href')!, document.url).href);
        return [{ text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200), url: url.href }];
      } catch {
        return [];
      }
    })
    .slice(0, 100);
  const main = dom.querySelector('article') || dom.querySelector('main') || dom.body;
  for (const node of main.querySelectorAll('p,div,section,article,li,h1,h2,h3,h4,pre,br,tr'))
    node.appendChild(dom.createTextNode('\n'));
  const text = (main.textContent || '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text, links };
}
export class WebTools {
  private pages = new Map<
    string,
    {
      botId: string;
      url: string;
      title: string;
      text: string;
      links: Array<{ text: string; url: string }>;
      time: number;
    }
  >();
  constructor(private load: WebLoader = loadPublicPage) {}
  async read(botId: string, args: Record<string, unknown>, signal: AbortSignal) {
    const maxChars = boundedInteger(args.maxChars, 12000, 100, 32000, 'maxChars'),
      offset = boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    let page: ReturnType<WebTools['get']>, id: string;
    if (typeof args.id === 'string') {
      id = args.id;
      page = this.get(botId, id);
    } else {
      const url = publicWebUrl(args.url).href,
        doc = await this.load(url, signal);
      signal.throwIfAborted();
      const parsed = extractWebPage(doc);
      id = createHash('sha256')
        .update(botId + '\0' + doc.url + '\0' + doc.body)
        .digest('hex')
        .slice(0, 32);
      page = { botId, url: doc.url, ...parsed, time: Date.now() };
      this.pages.delete(id);
      this.pages.set(id, page);
      while (this.pages.size > 32) this.pages.delete(this.pages.keys().next().value!);
    }
    return {
      id,
      url: page.url,
      title: page.title,
      source: 'web',
      untrusted: true,
      ...textPage(page.text, { offset, maxChars }),
      links: page.links,
    };
  }
  private get(botId: string, id: string) {
    const page = this.pages.get(id);
    if (!page || page.botId !== botId || Date.now() - page.time > 30 * 60000)
      throw new FileToolError('WEB_PAGE_EXPIRED', '网页结果不存在或已过期，请重新打开 URL');
    return page;
  }
  clearBot(botId: string) {
    for (const [id, page] of this.pages) if (page.botId === botId) this.pages.delete(id);
  }
}
