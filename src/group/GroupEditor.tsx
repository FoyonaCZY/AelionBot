import type { LayaFeatureState } from '../../shared/types/laya-types';
import { GroupDecisionSetting } from './GroupDecisionSetting';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Bot } from '../../shared/types/core';
import { soulSummary } from '../../shared/chat/bot-soul';
import {
  GROUP_HARD_CAP,
  GROUP_PACE_RANGES,
  groupPace,
  type GroupPace,
  type GroupSummary,
} from '../../shared/types/group-types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';

type Tab = 'basic' | 'pace' | 'decide';

/** A whole number within a range, with a 不限制 box when the limit can be turned off (value null). */
function LimitInput({
  label,
  value,
  range: [min, max],
  unit,
  unlimited,
  disabled,
  onChange,
}: {
  label: string;
  value: number | null;
  range: readonly [number, number];
  unit: string;
  unlimited?: boolean;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}) {
  const { t } = useI18n();
  const [last, setLast] = useState(value ?? min);
  const [draft, setDraft] = useState<string>();
  const off = value === null;
  const set = (next: number) => {
    const clamped = Math.min(max, Math.max(min, Math.round(next)));
    setLast(clamped);
    onChange(clamped);
  };
  // Typing is kept as text and applied on leaving the field, so 1 on the way to 12 is not raised to the minimum.
  const commit = () => {
    if (draft === undefined) return;
    const next = Number(draft);
    if (draft.trim() && Number.isFinite(next)) set(next);
    setDraft(undefined);
  };
  return (
    <div className="group-limit">
      <div className={`group-limit-number ${off ? 'is-off' : ''}`}>
        <button
          type="button"
          aria-label={t('减少{label}', { label })}
          disabled={disabled || off || (value ?? 0) <= min}
          onClick={() => set((value ?? min) - 1)}
        >
          −
        </button>
        <input
          aria-label={label}
          inputMode="numeric"
          disabled={disabled || off}
          value={off ? '' : (draft ?? String(value))}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, ''))}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
          }}
        />
        <button
          type="button"
          aria-label={t('增加{label}', { label })}
          disabled={disabled || off || (value ?? 0) >= max}
          onClick={() => set((value ?? min) + 1)}
        >
          +
        </button>
      </div>
      <span>{unit}</span>
      {unlimited && (
        <label className="group-limit-off">
          <input
            type="checkbox"
            checked={off}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked ? null : last)}
          />
          {t('不限制')}
        </label>
      )}
    </div>
  );
}

function SettingRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <div className="group-setting-row">
      <div className="group-setting-copy">
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      {children}
    </div>
  );
}

export function GroupEditor({
  bots,
  group,
  laya,
  workspace,
  onClose,
  onSaved,
  onDeleted,
}: {
  bots: Bot[];
  group?: GroupSummary;
  laya?: LayaFeatureState;
  /** The group's shared folder, and whether it only follows the default. */
  workspace?: { dir?: string; inherited: boolean };
  onClose: () => void;
  onSaved: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('basic');
  const current = groupPace(group?.pace);
  const [pace, setPace] = useState<Required<GroupPace>>({
    botStreak: group?.pace?.botStreak === null ? null : current.botStreak,
    pairRounds: group?.pace?.pairRounds === null ? null : current.pairStreak / 2,
    countProgress: current.countProgress,
    holdSeconds: current.holdSeconds,
  });
  const [folderPending, setFolderPending] = useState(false);
  const folder = async (reset: boolean) => {
    if (!group) return;
    setFolderPending(true);
    setError('');
    try {
      const scope = { kind: 'group' as const, id: group.id };
      if (reset) await window.aelion.resetConversationWorkspace(scope);
      else await window.aelion.pickConversationWorkspace(scope);
    } catch (error) {
      setError(t(ipcErrorText(error)));
    } finally {
      setFolderPending(false);
    }
  };
  const [name, setName] = useState(group?.name || ''),
    [ids, setIds] = useState(
      group?.members.filter((m) => !m.leftAt && bots.some((b) => b.id === m.id)).map((m) => m.id) || [],
    ),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [deleting, setDeleting] = useState(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector('input')?.focus();
    return () => {
      previous?.isConnected && previous.focus();
    };
  }, []);
  const save = async () => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      if (group) {
        await window.aelion.updateGroup({ id: group.id, name, botIds: ids, pace });
        onSaved(group.id);
      } else {
        const result = await window.aelion.createGroup({ name, botIds: ids });
        onSaved(result.id);
      }
    } catch (error) {
      setError(t(ipcErrorText(error)));
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className="peer-chat-layer group-editor-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        ref={root}
        className="group-editor"
        role="dialog"
        aria-modal="true"
        aria-label={group ? t('群聊设置') : t('创建群聊')}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Tab') {
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'),
            ];
            const index = items.indexOf(document.activeElement as HTMLElement);
            if (event.shiftKey && index <= 0) {
              event.preventDefault();
              items.at(-1)?.focus();
            } else if (!event.shiftKey && index === items.length - 1) {
              event.preventDefault();
              items[0]?.focus();
            }
          }
        }}
      >
        <header>
          <h2>{group ? t('群聊设置') : t('创建群聊')}</h2>
          <button className="icon-button" aria-label={t('关闭群聊设置')} disabled={pending} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className={group ? 'group-settings' : undefined}>
          {group && (
            <nav className="group-settings-nav" aria-label={t('群聊设置')}>
              {(
                [
                  ['basic', t('基本'), 'settings'],
                  ['pace', t('对话节奏'), 'message'],
                  ['decide', t('智能判断'), 'sparkle'],
                ] as const
              ).map(([id, label, icon]) => (
                <button
                  key={id}
                  type="button"
                  aria-current={tab === id ? 'page' : undefined}
                  className={tab === id ? 'is-on' : ''}
                  onClick={() => setTab(id)}
                >
                  <Icon name={icon} size={16} />
                  {label}
                </button>
              ))}
            </nav>
          )}
          <div className="group-settings-content">
            <div hidden={tab !== 'basic'}>
              <label className="group-name">
                {t('群名称')}
                <input
                  value={name}
                  maxLength={80}
                  placeholder={t('例如：项目协作')}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <div className="group-member-title">
                <span>{t('成员')}</span>
                <small>
                  {t('你')} + {ids.length} Bot
                </small>
              </div>
              <div className="group-member-picker">
                {bots.map((bot) => (
                  <label key={bot.id}>
                    <input
                      type="checkbox"
                      checked={ids.includes(bot.id)}
                      disabled={pending}
                      onChange={(event) =>
                        setIds((value) =>
                          event.target.checked ? [...value, bot.id] : value.filter((id) => id !== bot.id),
                        )
                      }
                    />
                    <Avatar bot={bot} size={32} />
                    <span>
                      <strong>{bot.name}</strong>
                      <small>{soulSummary(bot.soul) || 'Bot'}</small>
                    </span>
                  </label>
                ))}
                {bots.length < 2 && !group && <p className="subtle">{t('至少需要两位 Bot 才能建群。')}</p>}
              </div>
              {group && (
                <section className="group-settings-section">
                  <h3>{t('群工作区')}</h3>
                  <SettingRow
                    title={t('文件夹')}
                    detail={t('群里所有 Bot 共用这个文件夹，一个 Bot 写的文件其他 Bot 能直接读')}
                  >
                    <div className="group-setting-actions">
                      {!workspace?.inherited && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={pending || folderPending}
                          onClick={() => void folder(true)}
                        >
                          {t('恢复默认')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={pending || folderPending}
                        onClick={() => void folder(false)}
                      >
                        {t('更换')}
                      </button>
                    </div>
                  </SettingRow>
                  <code className="group-setting-path">
                    {workspace?.dir || t('未设置')}
                    {workspace?.inherited && workspace.dir ? ` · ${t('默认')}` : ''}
                  </code>
                </section>
              )}
            </div>
            {group && (
              <div hidden={tab !== 'pace'}>
                <section className="group-settings-section">
                  <h3>
                    {t('发言上限')}
                    <small>{t('你说话后重新计数')}</small>
                  </h3>
                  <SettingRow
                    title={t('Bot 连续发言')}
                    detail={t('你不说话时，所有 Bot 加起来最多发几条。到了会暂停，等你说话')}
                  >
                    <LimitInput
                      label={t('Bot 连续发言')}
                      value={pace.botStreak}
                      range={GROUP_PACE_RANGES.botStreak}
                      unit={t('条')}
                      unlimited
                      disabled={pending}
                      onChange={(botStreak) => setPace((value) => ({ ...value, botStreak }))}
                    />
                  </SettingRow>
                  <SettingRow
                    title={t('Bot 之间互相点名')}
                    detail={t('两个 Bot 互相 @ 或回复最多几个来回，之后彼此的消息不再叫醒对方')}
                  >
                    <LimitInput
                      label={t('Bot 之间互相点名')}
                      value={pace.pairRounds}
                      range={GROUP_PACE_RANGES.pairRounds}
                      unit={t('个来回')}
                      unlimited
                      disabled={pending}
                      onChange={(pairRounds) => setPace((value) => ({ ...value, pairRounds }))}
                    />
                  </SettingRow>
                  <SettingRow title={t('进度消息计入上限')} detail={t('关闭后，Bot 干活时汇报进度不占发言额度')}>
                    <button
                      type="button"
                      role="switch"
                      aria-label={t('进度消息计入上限')}
                      aria-checked={pace.countProgress}
                      className={pace.countProgress ? 'learning-switch enabled' : 'learning-switch'}
                      disabled={pending}
                      onClick={() => setPace((value) => ({ ...value, countProgress: !value.countProgress }))}
                    >
                      <i />
                    </button>
                  </SettingRow>
                </section>
                <section className="group-settings-section">
                  <h3>{t('等待')}</h3>
                  <SettingRow
                    title={t('先等被点名的人回答')}
                    detail={t('消息点名了某个 Bot 时，其他 Bot 最多等多久再补充')}
                  >
                    <LimitInput
                      label={t('先等被点名的人回答')}
                      value={pace.holdSeconds}
                      range={GROUP_PACE_RANGES.holdSeconds}
                      unit={t('秒')}
                      disabled={pending}
                      onChange={(holdSeconds) => setPace((value) => ({ ...value, holdSeconds: holdSeconds ?? 0 }))}
                    />
                  </SettingRow>
                </section>
                {(pace.botStreak === null || pace.pairRounds === null) && (
                  <p className="group-settings-note" role="note">
                    <Icon name="info" size={14} />
                    {t('不限制时，Bot 之间可能一直聊下去并持续消耗 token。为防失控，每轮最多 {count} 条。', {
                      count: GROUP_HARD_CAP,
                    })}
                  </p>
                )}
              </div>
            )}
            {group && (
              <div hidden={tab !== 'decide'}>
                <section className="group-settings-section">
                  <h3>
                    {t('谁来回应')}
                    <small>{t('适用于所有群聊')}</small>
                  </h3>
                  {laya ? (
                    <GroupDecisionSetting laya={laya} />
                  ) : (
                    <p className="subtle">{t('当前版本没有本地决策模型')}</p>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>
        {error && (
          <p className="group-error" role="alert">
            {error}
          </p>
        )}
        {deleting && (
          <div className="group-delete-confirm">
            <p>{t('删除「{name}」及群聊记录？群内正在处理的任务也会停止。', { name: group?.name || '' })}</p>
            <button className="secondary-button" disabled={pending} onClick={() => setDeleting(false)}>
              {t('取消')}
            </button>
            <button
              className="danger-button"
              disabled={pending}
              onClick={async () => {
                setPending(true);
                try {
                  await window.aelion.deleteGroup(group!.id);
                  onDeleted(group!.id);
                } catch (error) {
                  setError(t(ipcErrorText(error)));
                } finally {
                  setPending(false);
                }
              }}
            >
              {t('确认删除')}
            </button>
          </div>
        )}
        <footer>
          {group && (
            <button className="group-delete" disabled={pending} onClick={() => setDeleting(true)}>
              {t('删除群聊')}
            </button>
          )}
          <button className="secondary-button" disabled={pending} onClick={onClose}>
            {t('取消')}
          </button>
          <button
            className="primary-button"
            disabled={pending || !name.trim() || ids.length < (group ? 1 : 2)}
            onClick={() => void save()}
          >
            {pending ? t('保存中…') : group ? t('保存') : t('创建群聊')}
          </button>
        </footer>
      </section>
    </div>
  );
}
