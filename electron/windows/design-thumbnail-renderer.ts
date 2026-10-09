import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { DESIGN_PDF_READY_SCRIPT } from '../core/designer/design-pdf';
import { mime, webFileResponse, webResourceLimit, webResourcePath } from '../core/preview/web-preview-resources';
import type { DesignThumbnailJob } from '../core/designer/design-thumbnails';

const SCHEME = 'aelion-thumb',
  PARTITION = 'aelion-design-thumbnail',
  WIDTH = 640;

/** The page's first screen as a person would see it on the canvas: desktop, slide or phone. */
const viewport = (kind: DesignThumbnailJob['kind']) =>
  kind === 'mobile'
    ? { width: 390, height: 844 }
    : kind === 'ppt'
      ? { width: 1280, height: 720 }
      : { width: 1280, height: 800 };

/**
 * Renders one page of a design task in a hidden, sandboxed window and returns its first screen as JPEG. The page and
 * its local assets come from the task folder through a private scheme; every other request (network included) is
 * cancelled, so a thumbnail never reaches the internet. The caller runs one render at a time.
 */
export async function renderDesignThumbnail(job: DesignThumbnailJob): Promise<Buffer> {
  const token = randomUUID(),
    origin = SCHEME + '://' + token,
    size = viewport(job.kind),
    ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.removeAllListeners('will-download');
  ses.on('will-download', (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel: !(
        details.url.startsWith(origin + '/') ||
        details.url.startsWith('data:') ||
        details.url.startsWith('blob:') ||
        details.url === 'about:blank'
      ),
    }),
  );
  if (ses.protocol.isProtocolHandled(SCHEME)) ses.protocol.unhandle(SCHEME);
  ses.protocol.handle(SCHEME, async (request) => {
    try {
      const target = new URL(request.url);
      if (target.hostname !== token || request.method !== 'GET') return new Response(null, { status: 403 });
      const path = webResourcePath(target.pathname);
      const bytes = await job.read(path, webResourceLimit(path));
      return webFileResponse(bytes, mime[path.split('.').at(-1)!.toLowerCase()], request.headers.get('range'));
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  const window = new BrowserWindow({
    show: false,
    ...size,
    useContentSize: true,
    webPreferences: {
      session: ses,
      sandbox: true,
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setAudioMuted(true);
  const evaluate = (code: string) => window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await window.loadURL(origin + '/' + job.page.split('/').map(encodeURIComponent).join('/'));
        // Fonts and images first; a page that never settles still gets its picture taken.
        await Promise.race([evaluate(DESIGN_PDF_READY_SCRIPT), new Promise((done) => setTimeout(done, 4000))]).catch(
          () => {},
        );
        // Entrance animations end where the designer meant them to; looping ones stop where they are.
        await evaluate(
          'for(const a of document.getAnimations()){try{a.finish()}catch{a.pause()}}document.querySelectorAll("video").forEach(v=>v.pause());new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
        );
        window.webContents.debugger.attach('1.3');
        const result = await window.webContents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 82,
          fromSurface: true,
          clip: { x: 0, y: 0, ...size, scale: Math.min(1, WIDTH / size.width) },
        });
        return Buffer.from(result.data, 'base64');
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('缩略图渲染超时')), 15000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
    if (ses.protocol.isProtocolHandled(SCHEME)) ses.protocol.unhandle(SCHEME);
    void ses.clearStorageData().catch(() => {});
  }
}
