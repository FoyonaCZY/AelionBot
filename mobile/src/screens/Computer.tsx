// The work computer's screen, streamed from the computer over the encrypted channel. Watching does nothing to it;
// taking over pauses the Bot so the user can log in or solve a captcha, then hands it back.
import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import type { RemoteRequest } from '../../../shared/remote/protocol';
import { useI18n } from '../../../src/i18n';
import { connection, useConnection } from '../connection';
import { back } from '../router';
import { I } from '../icons';
import { Sheet, Spinner, toast } from '../ui';

/** A WebSocket-like object noVNC accepts in place of a socket: bytes go through the phone's connection. */
class RelayChannel {
  binaryType = 'arraybuffer';
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  protocol = '';
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private stream?: number;
  private readonly offs: Array<() => void> = [];
  constructor(private readonly botId: string) {}

  async start() {
    const { stream } = await connection.call('computer.open', { botId: this.botId });
    if (this.readyState === 'closed') return void connection.call('computer.close', { stream }).catch(() => {});
    this.stream = stream;
    this.offs.push(connection.onStream(stream, (data) => this.onmessage?.({ data: data.slice().buffer })));
    this.offs.push(
      connection.on('stream.close', (data) => (data as { stream: number }).stream === stream && this.finish()),
    );
    this.readyState = 'open';
    this.onopen?.({});
  }
  send(data: ArrayBuffer | Uint8Array) {
    if (this.stream === undefined || this.readyState !== 'open') return;
    // noVNC reuses its buffer after send returns: copy.
    connection.sendStream(this.stream, data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0)));
  }
  close() {
    if (this.stream !== undefined) void connection.call('computer.close', { stream: this.stream }).catch(() => {});
    this.finish();
  }
  private finish() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    for (const off of this.offs.splice(0)) off();
    this.onclose?.({ code: 1000, reason: '' });
  }
}

/** X11 keysyms: Latin-1 maps to itself, everything else to 0x01000000 + code point. */
const keysym = (char: string) => {
  const code = char.codePointAt(0)!;
  return code < 0x100 ? code : 0x01000000 + code;
};

export function Computer({ botId }: { botId: string }) {
  const { t } = useI18n();
  const { home, status } = useConnection();
  const host = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const desktop = home?.computer.desktops[botId];
  const control = Boolean(desktop?.manualControl);
  const owner = desktop?.ownerBotId ? home?.bots.find((bot) => bot.id === desktop.ownerBotId) : undefined;
  const takeover = home?.requests.find(
    (request): request is Extract<RemoteRequest, { kind: 'vm_takeover' }> =>
      request.botId === botId && request.kind === 'vm_takeover',
  );

  useEffect(() => {
    if (status !== 'ready' || !host.current) return;
    setConnected(false);
    setFailure(undefined);
    const channel = new RelayChannel(botId);
    const session = new RFB(host.current, channel as unknown as WebSocket, { shared: true });
    session.scaleViewport = true;
    session.resizeSession = false;
    session.viewOnly = true;
    session.background = '#000';
    session.addEventListener('connect', () => setConnected(true));
    session.addEventListener('disconnect', () => setConnected(false));
    rfb.current = session;
    channel.start().catch((error: Error) => setFailure(error.message));
    return () => {
      rfb.current = undefined;
      try {
        session.disconnect();
      } catch {
        channel.close();
      }
    };
  }, [botId, status]);
  useEffect(() => {
    if (rfb.current) rfb.current.viewOnly = !control;
  }, [control, connected]);

  const setControl = async (enabled: boolean) => {
    setBusy(true);
    try {
      if (enabled && takeover?.phase === 'waiting')
        await connection.call('request.respond', { id: takeover.id, action: 'takeover' });
      else if (!enabled && takeover?.phase === 'controlling')
        await connection.call('request.respond', { id: takeover.id, action: 'resume' });
      else await connection.call('computer.control', { botId, enabled });
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const type = () => {
    const session = rfb.current;
    if (!session) return;
    for (const char of text) session.sendKey(keysym(char), null);
    setText('');
  };

  return (
    <div className="pc-screen">
      <header className="c-nav is-dark">
        <button className="x-round" aria-label={t('关闭')} onClick={back}>
          <I name="close" size={24} stroke={2} />
        </button>
        <div className="c-title is-static">
          <b>{t('工作电脑')}</b>
          <small>
            {control
              ? t('你在操作 · Bot 已暂停')
              : owner
                ? t('{name} 正在操作', { name: owner.name })
                : t('现在没有 Bot 在操作')}
          </small>
        </div>
        {control ? (
          <button className="x-round" aria-label={t('输入文字')} onClick={() => setTyping(true)}>
            <I name="edit" size={21} />
          </button>
        ) : (
          <span className="x-round" />
        )}
      </header>
      <div className={'pc-view' + (control ? ' is-control' : '')}>
        <div ref={host} className="pc-surface" />
        {!connected && <div className="pc-overlay">{failure ? <p>{failure}</p> : <Spinner />}</div>}
      </div>
      <p className="pc-hint">
        {control
          ? t('点画面操作，双指缩放；需要打字时点右上角')
          : takeover
            ? takeover.reason
            : t('看 Bot 在工作电脑上做什么。需要登录或输入验证码时，可以接管。')}
      </p>
      <div className="pc-actions">
        {control ? (
          <button className="x-btn is-accent" disabled={busy} onClick={() => void setControl(false)}>
            {t('交还给 Bot')}
          </button>
        ) : (
          <button className="x-btn is-white" disabled={busy || !connected} onClick={() => void setControl(true)}>
            <I name="hand" size={20} />
            {t('接管')}
          </button>
        )}
      </div>
      {typing && (
        <Sheet onClose={() => setTyping(false)}>
          <div className="s-title">{t('输入到工作电脑')}</div>
          <textarea
            className="s-input"
            autoFocus
            rows={3}
            value={text}
            placeholder={t('文字会逐个按键输入到当前光标处')}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="x-pair">
            <button className="x-btn" onClick={() => rfb.current?.sendKey(0xff0d, 'Enter')}>
              {t('回车')}
            </button>
            <button className="x-btn is-primary" disabled={!text} onClick={type}>
              {t('输入')}
            </button>
          </div>
          <button className="x-link s-key" onClick={() => rfb.current?.sendKey(0xff08, 'Backspace')}>
            {t('删除一个字符')}
          </button>
        </Sheet>
      )}
    </div>
  );
}
