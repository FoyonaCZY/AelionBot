import type { Bot, WorkSession } from '../../shared/types/core';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import './work-sessions.css';

/**
 * A Bot's archived work sessions, which the conversation list leaves out: open one as it is, or bring it back into
 * the list.
 */
export function ArchivedSessions({
  bot,
  sessions,
  busy,
  onOpen,
  onRestore,
  onClose,
}: {
  bot: Bot;
  sessions: WorkSession[];
  busy: boolean;
  onOpen: (session: WorkSession) => void;
  onRestore: (session: WorkSession) => void;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const title = t('{name} 的已归档会话', { name: bot.name });
  const listed = [...sessions].sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''));
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal work-session-dialog archived-sessions"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <div className="modal-header-actions">
            <button className="icon-button" aria-label={t('关闭对话框')} autoFocus onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        {listed.length ? (
          <ul className="archived-session-list">
            {listed.map((session) => (
              <li key={session.id}>
                <button className="archived-session-open" title={t('打开')} onClick={() => onOpen(session)}>
                  <Icon name={session.connector ? 'message' : 'folder'} size={15} />
                  <span className="session-name">{session.name}</span>
                  {session.archivedAt && (
                    <small>
                      {t('归档于 {date}', {
                        date: new Date(session.archivedAt).toLocaleDateString(language),
                      })}
                    </small>
                  )}
                </button>
                <button className="secondary-button" disabled={busy} onClick={() => onRestore(session)}>
                  {t('取消归档')}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="archived-session-empty">{t('没有已归档的会话')}</p>
        )}
      </section>
    </div>
  );
}
