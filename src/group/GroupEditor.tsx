import { useEffect, useRef, useState } from 'react';
import type { Bot } from '../../shared/types/core';
import { soulSummary } from '../../shared/chat/bot-soul';
import { GROUP_LIMITS, type GroupSummary } from '../../shared/types/group-types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';

export function GroupEditor({
  bots,
  group,
  onClose,
  onSaved,
  onDeleted,
}: {
  bots: Bot[];
  group?: GroupSummary;
  onClose: () => void;
  onSaved: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useI18n();
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
        await window.aelion.updateGroup({ id: group.id, name, botIds: ids });
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
                disabled={pending || (!ids.includes(bot.id) && ids.length >= GROUP_LIMITS.bots)}
                onChange={(event) =>
                  setIds((value) => (event.target.checked ? [...value, bot.id] : value.filter((id) => id !== bot.id)))
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
