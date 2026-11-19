import { useState, type ReactNode } from 'react';
import type { BotFilePreview } from '../../shared/types/backup-types';
import type { Bot } from '../../shared/types/core';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
import '../app/work-sessions.css';
import './bot-transfer.css';

/** What the Bot file dialogs are open for: writing `bot` to a file, or making a Bot from the file in `preview`. */
export type BotTransferRequest = { kind: 'export'; bot: Bot } | { kind: 'import'; preview: BotFilePreview };

function TransferDialog({
  title,
  pending,
  error,
  submit,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  pending: boolean;
  error: string;
  submit: string;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
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
            onClose();
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
        <form
          className="work-session-form bot-transfer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending) onSubmit();
          }}
        >
          {children}
          {error && (
            <p className="group-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions work-session-actions">
            <span className="spacer" />
            <button type="button" className="secondary-button" disabled={pending} onClick={onClose}>
              {t('取消')}
            </button>
            <button type="submit" className="primary-button" autoFocus disabled={pending}>
              {submit}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

/** Writes a Bot to a file, or makes one from a file the person picked. */
export function BotTransfer({
  request,
  onClose,
  onImported,
  onNotify,
}: {
  request: BotTransferRequest;
  onClose: () => void;
  onImported: (bot: Bot) => void;
  onNotify: (message: string) => void;
}) {
  const { t } = useI18n();
  const [memories, setMemories] = useState(request.kind === 'import'),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const run = async (operation: () => Promise<void>) => {
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
  if (request.kind === 'export') {
    const { bot } = request;
    return (
      <TransferDialog
        title={t('导出 Bot')}
        pending={pending}
        error={error}
        submit={t('导出')}
        onClose={onClose}
        onSubmit={() =>
          void run(async () => {
            const path = await window.aelion.exportBot({ botId: bot.id, memories });
            if (!path) return;
            onNotify(t('已导出到 {path}', { path }));
            onClose();
          })
        }
      >
        <div className="bot-transfer-who">
          <Avatar bot={bot} size={36} />
          <strong>{bot.name}</strong>
        </div>
        <label className="bot-transfer-check">
          <input
            type="checkbox"
            checked={memories}
            disabled={pending}
            onChange={(event) => setMemories(event.target.checked)}
          />
          {t('包含它的记忆')}
        </label>
      </TransferDialog>
    );
  }
  const { preview } = request;
  return (
    <TransferDialog
      title={t('导入 Bot')}
      pending={pending}
      error={error}
      submit={t('导入')}
      onClose={onClose}
      onSubmit={() =>
        void run(async () => {
          const bot = await window.aelion.importBot({ id: preview.id, memories: memories && preview.memories > 0 });
          onNotify(t('已导入 {name}', { name: bot.name }));
          onImported(bot);
        })
      }
    >
      <div className="bot-transfer-who">
        <Avatar bot={{ name: preview.name, ...preview.palette }} size={36} />
        <strong>{preview.name}</strong>
      </div>
      {preview.soul && <pre className="bot-transfer-soul">{preview.soul.split('\n').slice(0, 8).join('\n')}</pre>}
      <ul className="bot-transfer-list">
        {preview.skills.length > 0 && (
          <li>
            {t('技能 {count} 个：{names}', {
              count: preview.skills.length,
              names:
                preview.skills
                  .slice(0, 5)
                  .map((skill) => skill.name)
                  .join('、') + (preview.skills.length > 5 ? '…' : ''),
            })}
          </li>
        )}
        {preview.persona && <li>{t('人格档案')}</li>}
        {preview.model && (
          <li>
            {preview.model.available
              ? t('模型：{provider} / {model}', { provider: preview.model.provider, model: preview.model.model })
              : t('这台电脑没有 {provider} / {model}，先用默认模型', {
                  provider: preview.model.provider,
                  model: preview.model.model,
                })}
          </li>
        )}
      </ul>
      {preview.memories > 0 && (
        <label className="bot-transfer-check">
          <input
            type="checkbox"
            checked={memories}
            disabled={pending}
            onChange={(event) => setMemories(event.target.checked)}
          />
          {t('导入 {count} 条记忆，确认后才会使用', { count: preview.memories })}
        </label>
      )}
    </TransferDialog>
  );
}
