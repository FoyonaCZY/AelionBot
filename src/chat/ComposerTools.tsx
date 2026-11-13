import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AttachmentIcon } from '../files/Attachments';
import { Icon } from '../ui/Icon';
import { Presence } from '../ui/Presence';
import { CompanionGlyph } from '../bots/CompanionCard';
import { useI18n } from '../i18n';
import type { WorkMode } from '../../shared/types/work-types';
import './work-items.css';

export function ComposerTools({
  contextControl,
  onAttach,
  onCommand,
}: {
  contextControl?: ReactNode;
  onAttach: () => void;
  onCommand: (mode: WorkMode) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div
      ref={root}
      className="composer-tools"
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const items = [...root.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')],
            at = items.indexOf(document.activeElement as HTMLElement);
          items[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (at + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
          ]?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="icon-button composer-plus"
        aria-label={t('添加附件或命令')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="plus" size={23} />
      </button>
      {contextControl}
      <Presence>
        {open && (
          <div className="composer-add-menu" role="menu" aria-label={t('添加到会话')}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                onAttach();
              }}
            >
              <span className="composer-menu-icon">
                <AttachmentIcon />
              </span>
              <span>{t('上传附件')}</span>
            </button>
            <div className="composer-menu-divider" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                onCommand('plan');
              }}
            >
              <span className="composer-menu-icon composer-menu-plan">
                <CompanionGlyph kind="plan" />
              </span>
              <span>{t('制定计划')}</span>
              <kbd>/plan</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                onCommand('goal');
              }}
            >
              <span className="composer-menu-icon composer-menu-goal">
                <CompanionGlyph kind="goal" />
              </span>
              <span>{t('执行目标')}</span>
              <kbd>/goal</kbd>
            </button>
          </div>
        )}
      </Presence>
    </div>
  );
}
