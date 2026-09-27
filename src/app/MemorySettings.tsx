import type { Bot, Snapshot } from '../../shared/types/core';
import { SettingsSection, SettingsEmpty } from '../settings/SettingsWindow';
import { Select } from '../ui/Select';
import { useI18n } from '../i18n';

/** The Memory settings tab: background learning and the memories of the bot chosen in the scope picker. */
export function MemorySettings({
  state,
  bot,
  scope,
  onScope,
  busy,
  act,
}: {
  state: Snapshot;
  bot?: Bot;
  scope: string;
  onScope: (id: string) => void;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const { t, language } = useI18n();
  const scopeBot = state.bots.find((item) => item.id === scope) || bot;
  const scopePicker = (
    <label className="scope-picker">
      <span>Bot</span>
      <Select
        aria-label={t('选择 Bot')}
        disabled={!state.bots.length}
        value={scopeBot?.id || ''}
        onChange={(event) => onScope(event.target.value)}
      >
        {state.bots.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </Select>
    </label>
  );
  return (
    <>
      {scopePicker}
      {state.cognition && (
        <SettingsSection title={t('后台学习')}>
          <div className="learning-setting">
            <div>
              <strong>{t('后台整理经验')}</strong>
              {(state.cognition.learning.runningBotId || state.cognition.learning.queued > 0) && (
                <span>
                  {state.cognition.learning.runningBotId
                    ? t('正在整理经验')
                    : t('{count} 项等待整理', { count: state.cognition.learning.queued })}
                </span>
              )}
            </div>
            <button
              role="switch"
              aria-label={t('后台整理经验')}
              aria-checked={state.cognition.learning.enabled}
              className={state.cognition.learning.enabled ? 'learning-switch enabled' : 'learning-switch'}
              disabled={busy}
              onClick={() => act(() => window.aelion.setBackgroundLearning(!state.cognition!.learning.enabled))}
            >
              <i />
            </button>
          </div>
        </SettingsSection>
      )}
      <SettingsSection title={t('已有记忆')}>
        {scopeBot?.memories.length ? (
          <div className="settings-card">
            {scopeBot.memories.map((value, i) => (
              <div className="memory-card" key={i}>
                {value}
              </div>
            ))}
          </div>
        ) : (
          <SettingsEmpty icon="memory" title={t('还没有记忆')} />
        )}
        {state.cognition?.bots.find((item) => item.botId === scopeBot?.id)?.lastLearning && (
          <p className="settings-note">
            {t('最近一次知识更新')}
            {new Date(
              state.cognition.bots.find((item) => item.botId === scopeBot?.id)!.lastLearning!.time,
            ).toLocaleString(language)}
          </p>
        )}
      </SettingsSection>
    </>
  );
}
