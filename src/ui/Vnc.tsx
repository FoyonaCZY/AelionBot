import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { startVncConnection, canvasHasFrame } from '../computer/vnc-connection';
import { Icon } from './Icon';
import { useI18n } from '../i18n';

export function Vnc({ url, control = false }: { url?: string; control?: boolean }) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null),
    connection = useRef<ReturnType<typeof startVncConnection> | null>(null);
  const [connected, setConnected] = useState(false),
    [retry, setRetry] = useState(0),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    setConnected(false);
    setFailed(false);
    if (!host.current || !url) return;
    const session = startVncConnection({
      create: () => new RFB(host.current!, url, { shared: true }),
      hasFrame: () => canvasHasFrame(host.current?.querySelector('canvas')),
      onState: (state) => {
        setConnected(state === 'connected');
        setFailed(state === 'failed');
      },
      control,
    });
    connection.current = session;
    return () => {
      session.dispose();
      if (connection.current === session) connection.current = null;
    };
  }, [url, retry]);
  useEffect(() => {
    connection.current?.setControl(control);
  }, [control]);
  return (
    <div className="vnc-shell">
      <div ref={host} className="vnc-surface" />
      {!connected && (
        <div className="vnc-overlay">
          <Icon name="computer" size={34} />
          <span>{!url ? t('正在等待工作电脑桌面') : failed ? t('画面尚未恢复') : t('正在连接电脑画面')}</span>
          {url && failed && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                setRetry((value) => value + 1);
              }}
            >
              {t('重新连接')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
