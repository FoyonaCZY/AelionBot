// Small pieces every screen uses: bottom sheets, toasts, long press, times and the connection banner.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { currentLanguage, translate } from '../../shared/i18n';
import { useConnection } from './connection';

export function Sheet({ onClose, children, tall }: { onClose: () => void; children: ReactNode; tall?: boolean }) {
  const [drag, setDrag] = useState(0);
  const start = useRef<number | undefined>(undefined);
  return (
    <>
      <div className="x-scrim" onClick={onClose} />
      <div
        className={'x-sheet' + (tall ? ' is-tall' : '')}
        role="dialog"
        style={drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}
      >
        <div
          className="x-grabber-area"
          onTouchStart={(event) => (start.current = event.touches[0].clientY)}
          onTouchMove={(event) =>
            start.current !== undefined && setDrag(Math.max(0, event.touches[0].clientY - start.current))
          }
          onTouchEnd={() => {
            if (drag > 90) onClose();
            start.current = undefined;
            setDrag(0);
          }}
        >
          <div className="x-grabber" />
        </div>
        <div className="x-sheet-body">{children}</div>
      </div>
    </>
  );
}

export function toast(message: string) {
  window.dispatchEvent(new CustomEvent('aelion-toast', { detail: message }));
}
export function Toasts() {
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const show = (event: Event) => {
      setMessage((event as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setMessage(undefined), 3200);
    };
    window.addEventListener('aelion-toast', show);
    return () => window.removeEventListener('aelion-toast', show);
  }, []);
  return message ? (
    <div className="x-toast" role="status">
      {message}
    </div>
  ) : null;
}

/** Long press (and right click): what iOS and Android give a message a menu with. */
export function useLongPress(onLong: () => void, delay = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | undefined>(undefined);
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  return {
    onTouchStart: (event: React.TouchEvent) => {
      const touch = event.touches[0];
      origin.current = { x: touch.clientX, y: touch.clientY };
      cancel();
      timer.current = setTimeout(() => {
        timer.current = undefined;
        navigator.vibrate?.(10);
        onLong();
      }, delay);
    },
    onTouchMove: (event: React.TouchEvent) => {
      const touch = event.touches[0];
      if (origin.current && Math.hypot(touch.clientX - origin.current.x, touch.clientY - origin.current.y) > 10)
        cancel();
    },
    onTouchEnd: cancel,
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      onLong();
    },
  };
}

/** A time in a list: 09:24 today, 昨天, 11月12日, or a date in another year. */
export function timeLabel(iso?: string) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date(),
    today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const language = currentLanguage() === 'zh-CN' ? 'zh-CN' : currentLanguage() === 'zh-TW' ? 'zh-TW' : 'en';
  if (date.getTime() >= today)
    return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (date.getTime() >= today - 86_400_000) return translate('昨天');
  return date.toLocaleDateString(language, {
    month: 'numeric',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Above messages in a chat: 今天 09:24, 昨天 18:02, 11月12日 08:30. */
export function dayLabel(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date(),
    today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const language = currentLanguage() === 'zh-CN' ? 'zh-CN' : currentLanguage() === 'zh-TW' ? 'zh-TW' : 'en';
  const time = date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (date.getTime() >= today) return translate('今天') + ' ' + time;
  if (date.getTime() >= today - 86_400_000) return translate('昨天') + ' ' + time;
  return (
    date.toLocaleDateString(language, {
      month: 'numeric',
      day: 'numeric',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    }) +
    ' ' +
    time
  );
}

/** How long a run has been going: 0:42, 12:05, 1:03:20. */
export function elapsedLabel(since: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

/** The current time, every second while `active`: for running timers. */
export function useNow(active = true) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** What the connection is doing, when it is not simply connected. */
export function ConnectionBanner() {
  const { status, since, computer } = useConnection();
  if (!computer || status === 'ready' || status === 'pending' || status === 'locked') return null;
  const text =
    status === 'offline'
      ? since
        ? translate('电脑离线 · 最后在线 {time}', { time: timeLabel(since) })
        : translate('电脑离线')
      : status === 'rejected'
        ? translate('这台电脑已不再允许这部手机连接')
        : status === 'error'
          ? translate('连不上中继，正在重试…')
          : translate('正在连接…');
  return <div className={'x-banner is-' + status}>{text}</div>;
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={'x-spinner' + (small ? ' is-small' : '')} aria-hidden="true" />;
}
