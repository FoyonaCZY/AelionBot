import { useState } from 'react';
import type { Bot, WorkSession } from '../../shared/types/core';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
import './work-sessions.css';

const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path;

/**
 * Creates a work session of `bot` (or of one of `bots`, picked here), or edits `session`: its name, folder, archiving
 * and deletion. A session is another chat with the Bot, so this asks only for what tells it apart.
 */
export function WorkSessionEditor({
  bot,
  bots,
  session,
  workspaceDir,
  onClose,
  onCreated,
  onDeleted,
}: {
  bot: Bot;
  /** The Bots a new session can belong to, `bot` chosen first; absent when it is `bot`'s. */
  bots?: Bot[];
  session?: WorkSession;
  /** The session's own folder, when it has one. */
  workspaceDir?: string;
  onClose: () => void;
  onCreated: (session: WorkSession) => void;
  onDeleted: (session: WorkSession) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(session?.name || ''),
    [folder, setFolder] = useState(session ? workspaceDir : undefined),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [confirmDelete, setConfirmDelete] = useState(false),
    [ownerId, setOwnerId] = useState(bot.id);
  const choices = !session && bots && bots.length > 1 ? bots : undefined;
  const scope = session ? { kind: 'bot' as const, id: bot.id, sessionId: session.id } : undefined;
  const title = confirmDelete ? t('删除工作会话') : session ? t('工作会话设置') : t('新建工作会话');
  const run = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(t(ipcErrorText(failure)));
    } finally {
      setPending(false);
    }
  };
  const chooseFolder = () =>
    run(async () => {
      // An existing session takes the folder at once, as the composer's folder button does.
      const picked = scope ? await window.aelion.pickConversationWorkspace(scope) : await window.aelion.chooseFolder();
      if (picked) setFolder(picked);
    });
  const clearFolder = () =>
    run(async () => {
      if (scope) await window.aelion.resetConversationWorkspace(scope);
      setFolder(undefined);
    });
  const submit = () =>
    run(async () => {
      const value = name.trim() || (folder ? folderName(folder) : '');
      if (!value) throw Error(t('请填写名称'));
      if (session) {
        if (value !== session.name) await window.aelion.updateWorkSession({ id: session.id, name: value });
        onClose();
        return;
      }
      onCreated(
        await window.aelion.createWorkSession({
          botId: choices?.some((item) => item.id === ownerId) ? ownerId : bot.id,
          name: value,
          ...(folder ? { workspaceDir: folder } : {}),
        }),
      );
    });
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        className="modal work-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault();
            event.stopPropagation();
            if (confirmDelete) setConfirmDelete(false);
            else onClose();
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <div className="modal-header-actions">
            <button className="icon-button" aria-label={t('关闭对话框')} disabled={pending} onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        {confirmDelete && session ? (
          <div className="delete-bot-confirmation">
            <p>{t('删除「{name}」及会话记录？会话里正在处理的任务也会停止。', { name: session.name })}</p>
            {error && (
              <p className="group-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button className="secondary-button" autoFocus disabled={pending} onClick={() => setConfirmDelete(false)}>
                {t('取消')}
              </button>
              <button
                className="danger-button"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    await window.aelion.deleteWorkSession(session.id);
                    onDeleted(session);
                  })
                }
              >
                {t('删除工作会话')}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="work-session-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!pending) void submit();
            }}
          >
            {choices && (
              <div className="work-session-field">
                <span>Bot</span>
                <div className="work-session-bots" role="radiogroup" aria-label="Bot">
                  {choices.map((item) => {
                    const chosen = item.id === ownerId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="radio"
                        aria-checked={chosen}
                        className={`work-session-bot ${chosen ? 'is-chosen' : ''}`}
                        disabled={pending}
                        onClick={() => setOwnerId(item.id)}
                      >
                        <Avatar bot={item} size={28} />
                        <strong>{item.name}</strong>
                        {chosen && (
                          <span className="work-session-bot-check" aria-hidden="true">
                            <Icon name="check" size={13} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <label>
              {t('名称')}
              <input
                autoFocus
                value={name}
                maxLength={80}
                placeholder={folder ? folderName(folder) : t('例如：v2 发布、周报整理')}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="work-session-field">
              <span>{t('工作目录')}</span>
              <div className="work-session-folder">
                <span className={`work-session-folder-path ${folder ? '' : 'is-empty'}`} title={folder}>
                  {folder || t('默认工作目录')}
                </span>
                {folder && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t('使用默认工作目录')}
                    disabled={pending}
                    onClick={() => void clearFolder()}
                  >
                    <Icon name="close" size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={pending}
                  onClick={() => void chooseFolder()}
                >
                  {t('选择文件夹')}
                </button>
              </div>
            </div>
            {error && (
              <p className="group-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions work-session-actions">
              {session && (
                <>
                  <button
                    type="button"
                    className="secondary-button danger-text"
                    disabled={pending}
                    onClick={() => setConfirmDelete(true)}
                  >
                    {t('删除')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        await window.aelion.updateWorkSession({ id: session.id, archived: !session.archivedAt });
                        onClose();
                      })
                    }
                  >
                    {session.archivedAt ? t('取消归档') : t('归档')}
                  </button>
                </>
              )}
              <span className="spacer" />
              <button type="button" className="secondary-button" disabled={pending} onClick={onClose}>
                {t('取消')}
              </button>
              <button type="submit" className="primary-button" disabled={pending}>
                {session ? t('保存') : t('创建工作会话')}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
