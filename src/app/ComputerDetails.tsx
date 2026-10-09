import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import type { Bot, Snapshot, WorkSession } from '../../shared/types/core';
import type { GroupSummary } from '../../shared/types/group-types';
import { ComputerPanel } from '../computer/ComputerPanel';
import { setComputerCardOnline, setComputerCardOpen, useComputerCard } from '../computer/computer-card';
import { DesignCanvasCard } from '../designer/DesignCanvasCard';
import { openDesignCanvas } from '../designer/design-canvas-preview';
import { useFilePreview } from '../preview/FilePreviewContext';
import {
  sessionInScope,
  setActiveDesign,
  useActiveDesignId,
  useFollowDesignRuns,
  type CanvasScope,
} from '../designer/design-canvas-state';
import { ScheduledTasks } from '../settings/ScheduledTasks';
import { Icon } from '../ui/Icon';
import { Vnc } from '../ui/Vnc';
import { useI18n } from '../i18n';
import type { useComputerControl } from './use-computer-control';
import '../computer/computer-card.css';

/**
 * Cards that float over the top right of the message list: the work computer's live desktop with the conversation's
 * scheduled tasks, and below it the design canvas while the conversation has an active design task. They never cover
 * the header or the composer: their top and combined height follow the message list, which the composer, work items
 * and permission prompts resize.
 */
function useMessageBounds(card: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const node = card.current,
      shell = node?.parentElement,
      conversation = shell?.querySelector<HTMLElement>(':scope > .conversation');
    if (!node || !shell || !conversation || !active) return;
    let watched: Element | null = null;
    const sizes = new ResizeObserver(() => measure());
    const measure = () => {
      const list = conversation.querySelector<HTMLElement>(':scope > .messages');
      if (list !== watched) {
        if (watched) sizes.unobserve(watched);
        if (list) sizes.observe(list);
        watched = list;
      }
      if (!list) return;
      const box = list.getBoundingClientRect(),
        frame = shell.getBoundingClientRect();
      node.style.setProperty('--computer-card-top', `${Math.round(box.top - frame.top)}px`);
      node.style.setProperty('--computer-card-space', `${Math.round(box.height)}px`);
    };
    // Switching conversations replaces the message list (a direct child); re-attach to the new one. Streaming
    // text changes deeper nodes and is ignored here; size changes arrive through the ResizeObserver.
    const swaps = new MutationObserver(measure);
    swaps.observe(conversation, { childList: true });
    sizes.observe(shell);
    measure();
    return () => {
      sizes.disconnect();
      swaps.disconnect();
    };
  }, [active]);
}

export function ComputerDetails({
  state,
  bot,
  session,
  group,
  computer,
  expanded,
  act,
  onOpen,
  onSetup,
  onSettings,
  onError,
  onTaskModalChange,
}: {
  state: Snapshot;
  bot?: Bot;
  /** The open work session of `bot`: the tasks shown are that session's. */
  session?: WorkSession;
  group?: GroupSummary;
  computer: ReturnType<typeof useComputerControl>;
  expanded: boolean;
  act: (operation: () => Promise<unknown>) => Promise<void>;
  onOpen: () => void;
  onSetup: () => void;
  onSettings: () => void;
  onError: (message: string) => void;
  onTaskModalChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { desktopAvailable, desktopBot, desktop } = computer;
  const { open } = useComputerCard();
  const card = useRef<HTMLElement>(null);
  useEffect(() => setComputerCardOnline(desktopAvailable), [desktopAvailable]);
  useEffect(() => () => setComputerCardOnline(false), []);
  const scope = useMemo<CanvasScope | undefined>(
    () =>
      group
        ? { kind: 'group', id: group.id }
        : bot
          ? { kind: 'bot', id: bot.id, ...(session ? { sessionId: session.id } : {}) }
          : undefined,
    [group?.id, bot?.id, session?.id],
  );
  const designs = useMemo(
    () =>
      scope
        ? (state.designer?.sessions || [])
            .filter((s) => sessionInScope(s, scope))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        : [],
    [state.designer?.sessions, scope],
  );
  const activeDesign = useActiveDesignId(scope);
  const design = designs.find((s) => s.id === activeDesign);
  // The canvas card stands on its own: it shows with the computer card hidden, and closing either leaves the other.
  const shown = open || Boolean(design && scope);
  useMessageBounds(card, shown);
  // A run that binds a design task brings its canvas card back.
  useFollowDesignRuns(scope, state.runs, state.designer?.sessions);
  // A task card in a message: a task of this conversation becomes the active one; any task opens on the canvas,
  // including another conversation's (a delegated design in a private chat window).
  const openPreview = useFilePreview();
  const sessionsRef = useRef(state.designer?.sessions);
  sessionsRef.current = state.designer?.sessions;
  useEffect(() => {
    const show = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id,
        task = sessionsRef.current?.find((s) => s.id === id);
      if (!task) return;
      if (scope && sessionInScope(task, scope)) setActiveDesign(scope, task.id);
      void openDesignCanvas(task, openPreview);
    };
    window.addEventListener('aelion-design-task', show);
    return () => window.removeEventListener('aelion-design-task', show);
  }, [scope, openPreview]);
  return (
    <aside ref={card} className={`details computer-details ${shown ? '' : 'is-closed'}`} aria-hidden={!shown}>
      {/* Hidden rather than unmounted: the scheduled-task editor and its state stay while the card is away. */}
      <section className="computer-card" hidden={!open} aria-label={t('工作电脑')}>
        <button
          type="button"
          className={`computer-card-close ${desktopAvailable ? 'is-online' : ''}`}
          aria-label={t('隐藏浮窗卡片')}
          title={t('隐藏浮窗卡片')}
          onClick={() => setComputerCardOpen(false)}
        >
          <Icon name="close" size={15} />
        </button>
        <ComputerPanel
          vm={state.vm}
          ready={desktopAvailable}
          bot={desktopBot}
          showOwner={Boolean(group)}
          onOpen={onOpen}
          onSetup={onSetup}
          onSettings={onSettings}
        >
          {/* A closed card keeps no live connection; reopening reconnects, as returning from full screen does. */}
          {desktopAvailable && !expanded && open && <Vnc key={desktopBot?.id} url={desktop?.vncUrl} />}
        </ComputerPanel>
        {desktop?.status === 'error' && (
          <div className="desktop-status" role="status">
            <span title={desktop.error}>{t('独立桌面暂未就绪')}</span>
            <button onClick={() => desktopBot && void act(() => window.aelion.ensureComputerDesktop(desktopBot.id))}>
              {t('重试')}
            </button>
          </div>
        )}
        <ScheduledTasks
          target={
            group
              ? { kind: 'group', id: group.id }
              : bot
                ? { kind: 'bot', id: bot.id, ...(session ? { sessionId: session.id } : {}) }
                : undefined
          }
          targetName={group?.name || (bot && session ? `${bot.name} / ${session.name}` : bot?.name || '')}
          tasks={state.scheduledTasks || []}
          onError={onError}
          onModalChange={onTaskModalChange}
        />
      </section>
      {design && scope && <DesignCanvasCard key={design.id} scope={scope} task={design} runs={state.runs} />}
    </aside>
  );
}
