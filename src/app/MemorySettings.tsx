import { useRef } from 'react';
import type { Bot, Snapshot } from '../../shared/types/core';
import { SettingsSection, SettingsEmpty } from '../settings/SettingsWindow';
import { Avatar } from '../ui/Avatar';
import { useSwitchMotion } from '../ui/motion';
import { useI18n } from '../i18n';

/** The Memory settings tab: background learning, then the memories of the Bot picked from the row of avatars. */
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
  const scopeBot = state.bots.find((item) => item.id === scope) || bot || state.bots[0];
  const list = useRef<HTMLUListElement>(null);
  useSwitchMotion(list, scopeBot?.id);
  const learning = state.cognition?.learning,
    lastLearning = state.cognition?.bots.find((item) => item.botId === scopeBot?.id)?.lastLearning;
  return (
    <>
      {learning && (
        <SettingsSection title={t('后台学习')}>
          <div className="settings-card">
            <div className="settings-switch-row">
              <div className="settings-row-copy">
                <span>{t('后台整理经验')}</span>
                {(learning.runningBotId || learning.queued > 0) && (
                  <small>
                    {learning.runningBotId ? t('正在整理经验') : t('{count} 项等待整理', { count: learning.queued })}
                  </small>
                )}
              </div>
              <button
                role="switch"
                aria-label={t('后台整理经验')}
                aria-checked={learning.enabled}
                className={learning.enabled ? 'learning-switch enabled' : 'learning-switch'}
                disabled={busy}
                onClick={() => act(() => window.aelion.setBackgroundLearning(!learning.enabled))}
              >
                <i />
              </button>
            </div>
          </div>
        </SettingsSection>
      )}
      <SettingsSection
        title={t('已有记忆')}
        aside={scopeBot?.memories.length ? <small>{scopeBot.memories.length}</small> : undefined}
      >
        {state.bots.length > 1 && (
          <div className="memory-bots" role="radiogroup" aria-label={t('选择 Bot')}>
            {state.bots.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                className="memory-bot"
                aria-checked={item.id === scopeBot?.id}
                onClick={() => onScope(item.id)}
              >
                <Avatar bot={item} size={28} />
                <span>{item.name}</span>
                {item.memories.length > 0 && <small>{item.memories.length}</small>}
              </button>
            ))}
          </div>
        )}
        {scopeBot?.memories.length ? (
          <ul ref={list} className="settings-card memory-list">
            {scopeBot.memories.map((value, i) => (
              <li key={i}>{value}</li>
            ))}
          </ul>
        ) : (
          <SettingsEmpty icon="memory" title={t('还没有记忆')} />
        )}
        {lastLearning && (
          <p className="settings-note">
            {t('最近一次知识更新')}
            {new Date(lastLearning.time).toLocaleString(language)}
          </p>
        )}
      </SettingsSection>
    </>
  );
}
