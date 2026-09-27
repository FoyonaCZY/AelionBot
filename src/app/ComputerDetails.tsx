import type { Bot, Snapshot } from '../../shared/types/core';
import type { GroupSummary } from '../../shared/types/group-types';
import { ComputerPanel } from '../computer/ComputerPanel';
import { ScheduledTasks } from '../settings/ScheduledTasks';
import { Vnc } from '../ui/Vnc';
import { useI18n } from '../i18n';
import type { useComputerControl } from './use-computer-control';

/** The right-hand column: the work computer's live desktop and the conversation's scheduled tasks. */
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
  return (
    <aside className="details computer-details">
      <ComputerPanel
        vm={state.vm}
        ready={desktopAvailable}
        bot={desktopBot}
        onOpen={onOpen}
        onSetup={onSetup}
        onSettings={onSettings}
      >
        {desktopAvailable && !expanded && <Vnc key={desktopBot?.id} url={desktop?.vncUrl} />}
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
