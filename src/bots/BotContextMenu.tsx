import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';

/** Where a sidebar menu opens: a Bot's row, or with `sessionId` one of its work sessions. */
export interface BotMenuAnchor {
  id: string;
  sessionId?: string;
  x: number;
  y: number;
  trigger: HTMLButtonElement;
}

/** A menu at the pointer: it stays on screen, closes on any outside click, and moves with the arrow keys. */
function ContextMenu({
  anchor,
  label,
  onClose,
  children,
}: {
  anchor: BotMenuAnchor;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    // Layout size, not the rendered box: the menu opens scaled down while it animates in.
    const width = element.offsetWidth,
      height = element.offsetHeight;
    element.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - height - 8))}px`;
    element.querySelector<HTMLButtonElement>('button')?.focus();
  }, [anchor]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close.current();
    };
    const hide = () => close.current();
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);
  return (
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      className="bot-context-menu"
      style={{ left: anchor.x, top: anchor.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          if (anchor.trigger.isConnected) anchor.trigger.focus();
          return;
        }
        if (event.key === 'Tab') {
          onClose();
          return;
        }
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if ((event.key === 'Enter' || event.key === ' ') && current >= 0) {
          event.preventDefault();
          buttons[current].click();
          return;
        }
        const next =
          event.key === 'ArrowDown'
            ? (current + 1) % buttons.length
            : event.key === 'ArrowUp'
              ? (current - 1 + buttons.length) % buttons.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          buttons[next]?.focus();
        }
      }}
    >
      {children}
    </div>
  );
}

/** Forks the chat into a new work session; shared by both menus. */
function ForkItem({ onFork }: { onFork: () => void }) {
  const { t } = useI18n();
  return (
    <button role="menuitem" title={t('把最后一次完成的任务及之前的记录和设置复制到新的工作会话')} onClick={onFork}>
      <Icon name="fork" size={16} />
      {t('Fork 到新工作会话')}
    </button>
  );
}

export function BotContextMenu({
  anchor,
  name,
  canDelete,
  onEdit,
  onDelete,
  onClose,
  onPrivateChats,
  onNewSession,
  onFork,
  onArchived,
}: {
  anchor: BotMenuAnchor;
  name: string;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
  onPrivateChats?: () => void;
  onNewSession?: () => void;
  /** Forks the Bot's main chat. */
  onFork?: () => void;
  /** Lists the Bot's archived work sessions; given only when it has some. */
  onArchived?: () => void;
}) {
  const { t } = useI18n();
  return (
    <ContextMenu anchor={anchor} label={t('{name} 的菜单', { name })} onClose={onClose}>
      <button role="menuitem" onClick={onEdit}>
        <Icon name="edit" size={16} />
        {t('编辑')}
      </button>
      {onNewSession && (
        <button role="menuitem" onClick={onNewSession}>
          <Icon name="folder" size={16} />
          {t('新建工作会话')}
        </button>
      )}
      {onFork && <ForkItem onFork={onFork} />}
      {onArchived && (
        <button role="menuitem" onClick={onArchived}>
          <Icon name="archive" size={16} />
          {t('已归档的会话')}
        </button>
      )}
      {onPrivateChats && (
        <button role="menuitem" onClick={onPrivateChats}>
          <Icon name="message" size={16} />
          {t('私聊记录')}
        </button>
      )}
      <div className="bot-menu-separator" role="separator" />
      <button
        role="menuitem"
        className="destructive"
        disabled={!canDelete}
        title={canDelete ? undefined : t('请先停止这个 Bot 的任务')}
        onClick={onDelete}
      >
        <Icon name="trash" size={16} />
        {t('删除')}
      </button>
    </ContextMenu>
  );
}

/** A work session's menu: its settings, a fork, archiving and deletion. */
export function SessionContextMenu({
  anchor,
  name,
  archived,
  onEdit,
  onFork,
  onArchive,
  onDelete,
  onClose,
}: {
  anchor: BotMenuAnchor;
  name: string;
  archived: boolean;
  onEdit: () => void;
  onFork: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <ContextMenu anchor={anchor} label={t('{name} 的菜单', { name })} onClose={onClose}>
      <button role="menuitem" onClick={onEdit}>
        <Icon name="edit" size={16} />
        {t('编辑')}
      </button>
      <ForkItem onFork={onFork} />
      <button role="menuitem" onClick={onArchive}>
        <Icon name="archive" size={16} />
        {archived ? t('取消归档') : t('归档')}
      </button>
      <div className="bot-menu-separator" role="separator" />
      <button role="menuitem" className="destructive" onClick={onDelete}>
        <Icon name="trash" size={16} />
        {t('删除')}
      </button>
    </ContextMenu>
  );
}
