// Connecting a computer: scan its QR code in the app (or paste the link), wait for the user to allow it on the
// computer. Also the screens for a phone the computer turned away and for unlocking with Face ID.
import { useEffect, useRef, useState } from 'react';
import type { PairingLink } from '../../../shared/remote/protocol';
import { Avatar } from '../../../src/ui/Avatar';
import { useI18n } from '../../../src/i18n';
import { connection, useConnection } from '../connection';
import { isIos, isStandalone, pairingFrom, scanPairing, unlock } from '../device';
import { back, go } from '../router';
import { I } from '../icons';
import { Sheet, Spinner, toast } from '../ui';

const mascots = [
  { name: 'a', color: '#5482b8', avatarStyle: { kind: 'split', secondary: '#8b6bea', pattern: 'vertical' } as const },
  { name: 'b', color: '#8b6bea' },
  { name: 'c', color: '#c77391', avatarStyle: { kind: 'split', secondary: '#8b6bea', pattern: 'vertical' } as const },
];

/** A pairing link the app was opened with (the phone's camera opened it), kept out of the address bar. */
const PENDING_LINK = 'aelion-pairing-link';
export function takeLinkFromAddress() {
  const link = pairingFrom(location.hash);
  if (!link) return;
  sessionStorage.setItem(PENDING_LINK, JSON.stringify(link));
  history.replaceState(null, '', location.pathname + '#/pair');
}

function Scanner({ onFound, onClose }: { onFound: (link: PairingLink) => void; onClose: () => void }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!video.current) return;
    const scan = scanPairing(video.current, onFound);
    scan.started.catch(() => setFailed(true));
    return scan.stop;
  }, []);
  return (
    <div className="w-scanner">
      <video ref={video} playsInline muted />
      <div className="w-frame" />
      <p>{failed ? t('无法打开相机，请在系统设置里允许，或改用粘贴链接') : t('对准电脑上“手机访问”里的二维码')}</p>
      <button className="x-btn is-white" onClick={onClose}>
        {t('取消')}
      </button>
    </div>
  );
}

export function Welcome() {
  const { t } = useI18n();
  const { computer, status, computers } = useConnection();
  const [scanning, setScanning] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [link, setLink] = useState<PairingLink | undefined>(() => {
    try {
      const saved = sessionStorage.getItem(PENDING_LINK);
      return saved ? (JSON.parse(saved) as PairingLink) : undefined;
    } catch {
      return;
    }
  });
  const connect = async (next: PairingLink) => {
    sessionStorage.removeItem(PENDING_LINK);
    setLink(undefined);
    setScanning(false);
    setPasting(false);
    await connection.addComputer(next);
  };
  const waiting =
    computer?.pairing &&
    (status === 'pending' || status === 'handshake' || status === 'connecting' || status === 'offline');
  const refused = computer?.pairing && status === 'rejected';
  const installTip = isIos() && !isStandalone();

  if (waiting)
    return (
      <div className="w-screen">
        <div className="w-hero">
          <Spinner />
          <h1>{status === 'pending' ? t('在电脑上点“允许”') : t('正在连接“{name}”', { name: computer.name })}</h1>
          <p>
            {status === 'pending'
              ? t('电脑上的“手机访问”页面会出现这部手机，确认后就能使用了。')
              : status === 'offline'
                ? t('电脑现在不在线。打开电脑上的 AelionBot 后会自动继续。')
                : t('请稍候…')}
          </p>
        </div>
        <div className="w-actions">
          <button className="x-link" onClick={() => void connection.removeComputer(computer.room)}>
            {t('取消')}
          </button>
        </div>
      </div>
    );

  return (
    <div className="w-screen">
      {computers.length > 0 && !refused && (
        <button
          className="x-round w-close"
          aria-label={t('返回')}
          onClick={() => (location.hash === '#/pair' ? back() : go('#/', true))}
        >
          <I name="close" size={24} stroke={2} />
        </button>
      )}
      <div className="w-hero">
        <div className="w-bots">
          {mascots.map((bot, index) => (
            <Avatar
              key={bot.name}
              bot={bot}
              size={index === 1 ? 76 : 56}
              activity={index === 1 ? 'thinking' : 'idle'}
            />
          ))}
        </div>
        <h1>{refused ? t('电脑没有允许这部手机') : link ? t('连接“{name}”', { name: link.n }) : t('连接你的电脑')}</h1>
        <p>
          {refused
            ? t('可能在电脑上点了“拒绝”，或这部手机已被移除。请在电脑上重新添加手机。')
            : t('Bot 在你的电脑上工作，手机随时查看进度、发消息和批准操作。')}
        </p>
      </div>
      {installTip && (
        <div className="w-tip">
          <I name="bell" size={20} />
          <span>
            {t('先点 Safari 底部的分享按钮，选“添加到主屏幕”，再从主屏幕打开 AelionBot 扫码。这样才能收到通知。')}
          </span>
        </div>
      )}
      {!link && (
        <ol className="w-steps">
          <li>
            <b>1</b>
            <span>{t('在电脑上打开 AelionBot，进入“设置 → 手机访问”')}</span>
          </li>
          <li>
            <b>2</b>
            <span>{t('点“添加手机”，用下面的按钮扫描二维码')}</span>
          </li>
          <li>
            <b>3</b>
            <span>{t('在电脑上点“允许”')}</span>
          </li>
        </ol>
      )}
      <div className="w-actions">
        {link ? (
          <button className="x-btn is-primary is-wide" onClick={() => void connect(link)}>
            {t('连接')}
          </button>
        ) : (
          <button className="x-btn is-primary is-wide" onClick={() => setScanning(true)}>
            <I name="qr" size={20} />
            {t('扫描二维码')}
          </button>
        )}
        <p className="w-secure">
          <I name="lock" size={14} />
          {t('端到端加密，中继服务器看不到你的内容')}
        </p>
        {!link && (
          <button className="x-link" onClick={() => setPasting(true)}>
            {t('粘贴配对链接')}
          </button>
        )}
      </div>
      {scanning && <Scanner onFound={(found) => void connect(found)} onClose={() => setScanning(false)} />}
      {pasting && (
        <Sheet onClose={() => setPasting(false)}>
          <div className="s-title">{t('粘贴配对链接')}</div>
          <textarea
            className="s-input"
            rows={4}
            value={pasted}
            placeholder="https://…/#pair=…"
            onChange={(event) => setPasted(event.target.value)}
          />
          <button
            className="x-btn is-primary is-wide"
            onClick={() => {
              const found = pairingFrom(pasted.trim());
              if (found) void connect(found);
              else toast(t('这不是有效的配对链接'));
            }}
          >
            {t('连接')}
          </button>
        </Sheet>
      )}
    </div>
  );
}

export function Lock() {
  const { t } = useI18n();
  const { computer } = useConnection();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await unlock();
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run();
  }, []);
  return (
    <div className="w-screen">
      <div className="w-hero">
        <I name="lock" size={44} />
        <h1>{t('验证身份')}</h1>
        <p>{t('“{name}”要求先用 Face ID、指纹或手机密码验证。', { name: computer?.name || '' })}</p>
      </div>
      <div className="w-actions">
        <button className="x-btn is-primary is-wide" disabled={busy} onClick={() => void run()}>
          {t('验证')}
        </button>
      </div>
    </div>
  );
}
