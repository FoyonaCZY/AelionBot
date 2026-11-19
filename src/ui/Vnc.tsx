import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { startVncConnection, canvasHasFrame } from '../computer/vnc-connection';
import { formatKeyChord, mapCanvasPoint } from '../../shared/teaching/teaching-events';
import type { TeachingClientEvent, TeachingClientKeyframe } from '../../shared/types/teaching-types';
import { Icon } from './Icon';
import { useI18n } from '../i18n';

export interface VncTeachingBridge {
  active: boolean;
  startedAt: number;
  windowTitle: () => string | undefined;
  refreshWindowTitle: () => void;
  onEvent: (event: TeachingClientEvent) => void;
  onKeyframe: (frame: TeachingClientKeyframe) => void;
}

const DRAG_THRESHOLD_PX = 24;
const DOUBLE_CLICK_MS = 420;
const DOUBLE_CLICK_PX = 14;
const KEYFRAME_DEBOUNCE_MS = 700;

export function Vnc({
  url,
  control = false,
  teaching,
}: {
  url?: string;
  control?: boolean;
  teaching?: VncTeachingBridge;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null),
    connection = useRef<ReturnType<typeof startVncConnection> | null>(null);
  const [connected, setConnected] = useState(false),
    [retry, setRetry] = useState(0),
    [failed, setFailed] = useState(false);
  const teachingRef = useRef(teaching);
  teachingRef.current = teaching;

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

  useEffect(() => {
    const root = host.current;
    if (!root || !connected || !control || !teaching?.active) return;

    let frameSeq = 1;
    let lastFrameAt = -Infinity;
    let down: { atMs: number; x: number; y: number; button: number } | undefined;
    let lastLeftClick: { atMs: number; x: number; y: number } | undefined;

    const elapsed = () => Math.max(0, Date.now() - (teachingRef.current?.startedAt || Date.now()));
    const captureFrame = (label: string, force = false): string | undefined => {
      const bridge = teachingRef.current;
      if (!bridge?.active) return undefined;
      const atMs = elapsed();
      if (!force && atMs - lastFrameAt < KEYFRAME_DEBOUNCE_MS) return undefined;
      const canvas = root.querySelector('canvas');
      if (!canvas || canvas.width < 2 || canvas.height < 2) return undefined;
      try {
        const dataUrl = canvas.toDataURL('image/png');
        const prefix = 'data:image/png;base64,';
        if (!dataUrl.startsWith(prefix)) return undefined;
        const id = `vm-kf-${frameSeq++}`;
        lastFrameAt = atMs;
        bridge.onKeyframe({ id, atMs, label, pngBase64: dataUrl.slice(prefix.length) });
        return id;
      } catch {
        return undefined;
      }
    };

    // Capture the starting state of the VM desktop and query its active X11 window.
    teachingRef.current?.refreshWindowTitle();
    captureFrame('开始演示', true);

    const pointerPoint = (event: MouseEvent) => {
      const canvas = root.querySelector('canvas');
      if (!canvas) return undefined;
      return mapCanvasPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!teachingRef.current?.active) return;
      const point = pointerPoint(event);
      if (!point) return;
      down = { atMs: elapsed(), x: point.x, y: point.y, button: event.button };
      teachingRef.current.refreshWindowTitle();
    };

    const onPointerUp = (event: PointerEvent) => {
      const bridge = teachingRef.current;
      if (!bridge?.active || !down) return;
      const start = down;
      down = undefined;
      const point = pointerPoint(event) || { x: start.x, y: start.y };
      const dist = Math.hypot(point.x - start.x, point.y - start.y);
      const windowTitle = bridge.windowTitle();

      if (dist >= DRAG_THRESHOLD_PX) {
        const keyframeId = captureFrame(`拖拽 (${start.x}, ${start.y}) → (${point.x}, ${point.y})`);
        bridge.onEvent({
          atMs: start.atMs,
          kind: 'drag',
          x: start.x,
          y: start.y,
          toX: point.x,
          toY: point.y,
          ...(windowTitle ? { windowTitle } : {}),
          ...(keyframeId ? { keyframeId } : {}),
        });
        lastLeftClick = undefined;
        return;
      }

      let kind: TeachingClientEvent['kind'] = 'click';
      if (start.button === 2) kind = 'right_click';
      else if (start.button === 1) kind = 'middle_click';
      else if (
        lastLeftClick &&
        start.atMs - lastLeftClick.atMs <= DOUBLE_CLICK_MS &&
        Math.hypot(start.x - lastLeftClick.x, start.y - lastLeftClick.y) <= DOUBLE_CLICK_PX
      ) {
        kind = 'double_click';
        lastLeftClick = undefined;
      } else {
        lastLeftClick = { atMs: start.atMs, x: start.x, y: start.y };
      }

      const keyframeId = captureFrame(
        `${kind === 'right_click' ? '右键点击' : kind === 'double_click' ? '双击' : '点击'} (${start.x}, ${start.y})`,
      );
      bridge.onEvent({
        atMs: start.atMs,
        kind,
        x: start.x,
        y: start.y,
        ...(windowTitle ? { windowTitle } : {}),
        ...(keyframeId ? { keyframeId } : {}),
      });
    };

    const onWheel = (event: WheelEvent) => {
      const bridge = teachingRef.current;
      if (!bridge?.active) return;
      const point = pointerPoint(event);
      if (!point) return;
      const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
      const direction: 'up' | 'down' | 'left' | 'right' = vertical
        ? event.deltaY < 0
          ? 'up'
          : 'down'
        : event.deltaX < 0
          ? 'left'
          : 'right';
      const windowTitle = bridge.windowTitle();
      bridge.onEvent({
        atMs: elapsed(),
        kind: 'scroll',
        x: point.x,
        y: point.y,
        direction,
        amount: 1,
        ...(windowTitle ? { windowTitle } : {}),
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const bridge = teachingRef.current;
      if (!bridge?.active || event.isComposing) return;
      if (!root.contains(document.activeElement) && document.activeElement?.tagName !== 'CANVAS') return;
      const printable =
        event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey ? event.key : undefined;
      const chord = formatKeyChord({
        key: event.key,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
      });
      if (!printable && !chord) return;
      const keyframeId = event.key === 'Enter' ? captureFrame('按下 Enter') : undefined;
      const windowTitle = bridge.windowTitle();
      bridge.onEvent({
        atMs: elapsed(),
        kind: 'key',
        key: event.key,
        ...(printable ? { printable } : {}),
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
        ...(windowTitle ? { windowTitle } : {}),
        ...(keyframeId ? { keyframeId } : {}),
      });
    };

    root.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    root.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
    root.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('keydown', onKeyDown, { capture: true, passive: true });

    return () => {
      root.removeEventListener('pointerdown', onPointerDown, { capture: true });
      root.removeEventListener('pointerup', onPointerUp, { capture: true });
      root.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [connected, control, teaching?.active]);

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
