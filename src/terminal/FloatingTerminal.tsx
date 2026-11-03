import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import '@xterm/xterm/css/xterm.css';
import './floating-terminal.css';
import type { AttachmentScope } from '../../shared/types/attachment-types';
import { workspaceKey } from '../../shared/types/work-types';
import { useI18n } from '../i18n';
import { Icon } from '../ui/Icon';
import { attachTerminal, endTerminal, fitTerminal, showTerminal, useTerminalState } from './terminal-sessions';

const EDGE = 8,
  /** Below the window's drag strip and native caption buttons, which would cover the panel's own buttons. */
  TOP = 44;
interface Layout {
  left: number;
  top: number;
  width: number;
  height: number;
}
/** Where the user left the panel; every conversation's terminal opens there. */
let saved: Layout | undefined;
function clamped(layout: Layout, parent: HTMLElement): Layout {
  const width = Math.min(layout.width, parent.clientWidth - EDGE * 2),
    height = Math.min(layout.height, parent.clientHeight - TOP - EDGE);
  return {
    width,
    height,
    left: Math.max(EDGE, Math.min(layout.left, parent.clientWidth - width - EDGE)),
    top: Math.max(TOP, Math.min(layout.top, parent.clientHeight - height - EDGE)),
  };
}
/** Just above the composer and level with its right edge, the first time. */
function initialLayout(parent: HTMLElement): Layout {
  const composer = parent.querySelector('.conversation .composer')?.getBoundingClientRect(),
    area = parent.querySelector('.conversation')?.getBoundingClientRect(),
    frame = parent.getBoundingClientRect(),
    right = composer?.right ?? area?.right ?? frame.right,
    bottom = composer?.top ?? frame.bottom - 120,
    width = Math.min(680, area ? area.width - EDGE * 2 : 680),
    height = 380;
  return { width, height, left: right - frame.left - width, top: bottom - frame.top - height - 12 };
}
export function FloatingTerminal({ scope }: { scope: AttachmentScope }) {
  const id = workspaceKey(scope),
    { shown } = useTerminalState(id);
  // On the shell rather than in the conversation, whose stacking context sits under the floating computer card.
  const shell = document.querySelector('.app-shell');
  return shown && shell ? createPortal(<TerminalPanel key={id} id={id} scope={scope} />, shell) : null;
}
function TerminalPanel({ id, scope }: { id: string; scope: AttachmentScope }) {
  const { t } = useI18n(),
    { cwd } = useTerminalState(id),
    panel = useRef<HTMLElement>(null),
    screen = useRef<HTMLDivElement>(null),
    [layout, setLayout] = useState<Layout>();
  const place = (next: Layout) => {
    saved = clamped(next, panel.current!.parentElement!);
    setLayout(saved);
  };
  // Measured before paint, so the panel never flashes at the wrong place.
  useLayoutEffect(() => {
    const parent = panel.current!.parentElement!;
    place(saved || initialLayout(parent));
    const observer = new ResizeObserver(() => saved && place(saved));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  // The scope stays the same for a given panel: the panel is keyed by its id.
  useEffect(() => {
    void attachTerminal(scope, screen.current!);
    let frame = 0;
    // The panel's own resize handle changes its size without going through React.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const node = panel.current;
        if (!node) return;
        if (saved) saved = { ...saved, width: node.offsetWidth, height: node.offsetHeight };
        fitTerminal(id);
      });
    });
    observer.observe(panel.current!);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button') || !saved) return;
    const bar = event.currentTarget,
      { pointerId, clientX, clientY } = event,
      origin = saved;
    bar.setPointerCapture(pointerId);
    const move = (next: PointerEvent) =>
      place({ ...origin, left: origin.left + next.clientX - clientX, top: origin.top + next.clientY - clientY });
    const stop = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', stop);
      bar.removeEventListener('pointercancel', stop);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
  };
  return (
    <section
      ref={panel}
      className="floating-terminal no-drag"
      aria-label={t('终端')}
      style={layout}
      // The shell owns the keyboard here: the chat's shortcuts, such as Ctrl+F, must not fire while typing in it.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="floating-terminal-bar" onPointerDown={startDrag}>
        <Icon name="terminal" size={14} />
        <span title={cwd}>{cwd || t('终端')}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={t('隐藏终端')}
          title={t('隐藏终端')}
          onClick={() => showTerminal(id, false)}
        >
          <Icon name="minus" size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('结束终端')}
          title={t('结束终端')}
          onClick={() => endTerminal(id)}
        >
          <Icon name="close" size={14} />
        </button>
      </header>
      <div ref={screen} className="floating-terminal-body" />
    </section>
  );
}
