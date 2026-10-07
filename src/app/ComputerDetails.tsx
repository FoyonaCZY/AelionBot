import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Bot, Snapshot } from '../../shared/types/core';
import type { GroupSummary } from '../../shared/types/group-types';
import { ComputerPanel } from '../computer/ComputerPanel';
import { setComputerCardOnline, setComputerCardOpen, useComputerCard } from '../computer/computer-card';
import { ScheduledTasks } from '../settings/ScheduledTasks';
import { Icon } from '../ui/Icon';
import { Vnc } from '../ui/Vnc';
import { useI18n } from '../i18n';
import type { useComputerControl } from './use-computer-control';
import '../computer/computer-card.css';

/**
 * The work computer's live desktop and the conversation's scheduled tasks, in a card that floats over the top
 * right of the message list. It never covers the header or the composer: its top and height follow the message
 * list, which the composer, work items and permission prompts resize.
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
  useMessageBounds(card, open);
  useEffect(() => setComputerCardOnline(desktopAvailable), [desktopAvailable]);
  useEffect(() => () => setComputerCardOnline(false), []);
  return (
    <aside ref={card} className={`details computer-details ${open ? '' : 'is-closed'}`} aria-hidden={!open}>
      <button
        type="button"
        className={`computer-card-close ${desktopAvailable ? 'is-online' : ''}`}
        aria-label={t('隐藏工作电脑和定时任务')}
        title={t('隐藏工作电脑和定时任务')}
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
        target={group ? { kind: 'group', id: group.id } : bot ? { kind: 'bot', id: bot.id } : undefined}
        targetName={group?.name || bot?.name || ''}
        tasks={state.scheduledTasks || []}
        onError={onError}
        onModalChange={onTaskModalChange}
      />
    </aside>
  );
}
