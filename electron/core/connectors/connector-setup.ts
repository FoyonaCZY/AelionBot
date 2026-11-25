// QR flows that create a connector: Feishu's app registration (OAuth device authorization, which also makes the
// person who scanned the owner) and WeChat's ClawBot login.
import { randomUUID } from 'node:crypto';
import { renderSVG } from 'uqr';
import type { ConnectorSetupView } from '../../../shared/types/connector-types';
import { AppError } from '../../../shared/errors';
import type { LarkSdk } from './adapters/feishu';
import { weixinLoginStatus, weixinQrCode, type WeixinCredentials } from './adapters/weixin';

export type SetupResult =
  | { platform: 'feishu'; credentials: { appId: string; appSecret: string }; ownerId?: string }
  | { platform: 'weixin'; credentials: WeixinCredentials };

/** What a Feishu app needs: private messages, files, sending as the bot, streaming cards and card buttons. */
const FEISHU_ADDONS = {
  scopes: {
    tenant: [
      'im:message',
      'im:message.p2p_msg:readonly',
      'im:message:send_as_bot',
      'im:resource',
      'cardkit:card:write',
    ],
  },
  events: { items: { tenant: ['im.message.receive_v1'] } },
  callbacks: { items: ['card.action.trigger'] },
};
const KEPT_MS = 10 * 60_000;
const QR_REFRESHES = 3;

interface Setup {
  view: ConnectorSetupView;
  abort: AbortController;
  verify?: (code: string) => void;
  endedAt?: number;
}

export class ConnectorSetups {
  private setups = new Map<string, Setup>();
  constructor(
    private deps: {
      lark: () => LarkSdk;
      changed: () => void;
      fetch?: typeof fetch;
    },
  ) {}
  views() {
    const now = Date.now();
    for (const [id, setup] of this.setups) if (setup.endedAt && now - setup.endedAt > KEPT_MS) this.setups.delete(id);
    return [...this.setups.values()].map((setup) => structuredClone(setup.view));
  }
  /** Starts a flow; `complete` creates the connector and returns its ID. */
  start(platform: 'feishu' | 'weixin', botName: string, complete: (result: SetupResult) => string) {
    if ([...this.setups.values()].some((setup) => !setup.endedAt))
      throw new AppError('connector.setup_busy', '请先完成或取消正在进行的扫码');
    const setup: Setup = {
      view: { id: randomUUID(), platform, phase: 'starting' },
      abort: new AbortController(),
    };
    this.setups.set(setup.view.id, setup);
    const flow = platform === 'feishu' ? this.feishu(setup, botName) : this.weixin(setup);
    void flow
      .then((result) => {
        if (setup.abort.signal.aborted) return;
        if (!result) return;
        setup.view = { id: setup.view.id, platform, phase: 'done', connectorId: complete(result) };
      })
      .catch((error) => {
        if (setup.abort.signal.aborted) return;
        setup.view = { id: setup.view.id, platform, phase: 'failed', message: setupError(error) };
      })
      .finally(() => {
        setup.endedAt = Date.now();
        this.deps.changed();
      });
    this.deps.changed();
    return setup.view.id;
  }
  private show(setup: Setup, url: string, expiresInSeconds?: number, message?: string) {
    setup.view = {
      ...setup.view,
      phase: 'waiting',
      url,
      qrSvg: renderSVG(url, { border: 2 }),
      ...(expiresInSeconds ? { expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() } : {}),
      ...(message ? { message } : {}),
    };
    if (!message) delete setup.view.message;
    this.deps.changed();
  }
  private async feishu(setup: Setup, botName: string): Promise<SetupResult> {
    const result = await this.deps.lark().registerApp({
      source: 'aelionbot',
      signal: setup.abort.signal,
      createOnly: true,
      appPreset: { name: botName.slice(0, 30), desc: `${botName} · AelionBot` },
      addons: FEISHU_ADDONS,
      onQRCodeReady: ({ url, expireIn }) => this.show(setup, url, expireIn),
    });
    if (result.user_info?.tenant_brand === 'lark')
      throw new AppError('connector.lark_unsupported', '暂不支持 Lark 国际版');
    return {
      platform: 'feishu',
      credentials: { appId: result.client_id, appSecret: result.client_secret },
      ownerId: result.user_info?.open_id,
    };
  }
  private async weixin(setup: Setup): Promise<SetupResult | undefined> {
    const fetcher = this.deps.fetch || fetch;
    let qr = await weixinQrCode(fetcher),
      refreshes = 0,
      baseUrl: string | undefined,
      verifyCode: string | undefined;
    this.show(setup, qr.url);
    while (!setup.abort.signal.aborted) {
      const state = await weixinLoginStatus(qr.key, {
        baseUrl,
        verifyCode,
        signal: setup.abort.signal,
        fetch: fetcher,
      });
      verifyCode = undefined;
      if (state.status === 'confirmed') return { platform: 'weixin', credentials: state.credentials };
      if (state.status === 'redirect') baseUrl = state.baseUrl;
      else if (state.status === 'scaned') {
        if (setup.view.phase !== 'scanned') {
          setup.view = { ...setup.view, phase: 'scanned' };
          this.deps.changed();
        }
      } else if (state.status === 'need_verifycode') {
        // The phone shows a number that the person types here before the login completes.
        setup.view = { ...setup.view, phase: 'verify-code' };
        this.deps.changed();
        verifyCode = await new Promise<string>((resolve, reject) => {
          setup.verify = resolve;
          setup.abort.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
        setup.verify = undefined;
        setup.view = { ...setup.view, phase: 'scanned' };
        this.deps.changed();
      } else if (state.status === 'expired' || state.status === 'verify_code_blocked') {
        if (++refreshes > QR_REFRESHES) throw new AppError('connector.qr_expired', '二维码多次过期，请重新开始');
        qr = await weixinQrCode(fetcher);
        baseUrl = undefined;
        this.show(
          setup,
          qr.url,
          undefined,
          state.status === 'verify_code_blocked' ? '验证数字多次输入错误，请重新扫码' : undefined,
        );
      } else if (state.status === 'binded_redirect')
        throw new AppError('connector.already_bound', '这个微信已经连接过，请先在已有连接器里断开');
    }
  }
  answer(id: string, code: string) {
    const setup = this.setups.get(id);
    if (!setup?.verify) throw new AppError('connector.setup_closed', '扫码流程已结束');
    if (!/^\d{1,12}$/.test(code.trim())) throw new AppError('connector.verify_code_invalid', '请输入手机上显示的数字');
    setup.verify(code.trim());
  }
  cancel(id: string) {
    const setup = this.setups.get(id);
    if (!setup) return;
    setup.abort.abort();
    this.setups.delete(id);
    this.deps.changed();
  }
  dispose() {
    for (const setup of this.setups.values()) setup.abort.abort();
    this.setups.clear();
  }
}

function setupError(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === 'access_denied') return '已在手机上取消授权';
  if (code === 'expired_token') return '二维码已过期，请重新开始';
  return String((error as Error)?.message || error).slice(0, 300);
}
