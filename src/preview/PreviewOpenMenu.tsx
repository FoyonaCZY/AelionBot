import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { previewMenuVisibility } from './PreviewPicker';
import { useI18n } from '../i18n';
import type { PreviewOpenAction } from '../../shared/preview/preview-open';
import './preview-open.css';
type Action = PreviewOpenAction | 'save';
export function PreviewOpenMenu({
  canOpen,
  canSave,
  disabled,
  onAction,
}: {
  canOpen: boolean;
  canSave: boolean;
  disabled: boolean;
  onAction: (action: Action) => void;
}) {
  const { t } = useI18n();
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null),
    generation = useRef(0);
  const [open, setOpen] = useState(false),
    [position, setPosition] = useState({ left: 0, top: 0 });
  const close = () => {
    generation.current++;
    setOpen(false);
    void previewMenuVisibility(false);
  };
  const show = async () => {
    if (open) {
      close();
      return;
    }
    const n = ++generation.current;
    await previewMenuVisibility(true);
    if (n !== generation.current || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(r.right - 224, innerWidth - 232)),
      top: Math.max(8, Math.min(r.bottom + 7, innerHeight - 198)),
    });
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (open) {
      menu.current?.showPopover();
      menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    }
  }, [open]);
  useEffect(
    () => () => {
      generation.current++;
      void previewMenuVisibility(false);
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [open]);
  const options: Array<{ action: Action; label: string }> = [
    ...(canOpen
      ? [
          { action: 'default' as const, label: t('默认应用') },
          { action: 'choose' as const, label: t('选择其他应用…') },
          { action: 'folder' as const, label: t('打开所在文件夹') },
        ]
      : []),
    ...(canSave ? [{ action: 'save' as const, label: t('另存为…') }] : []),
  ];
  const act = (action: Action) => {
    close();
    trigger.current?.focus();
    onAction(action);
  };
  return (
    <>
      <div className="fp-open-control">
        <button
          type="button"
          className="fp-open-default"
          disabled={disabled}
          aria-label={canOpen ? t('用默认应用打开') : t('另存为')}
          onClick={() => onAction(canOpen ? 'default' : 'save')}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 8V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v2M3 9h18l-3 11H3Z" />
          </svg>
          <span>{t('打开')}</span>
        </button>
        <button
          ref={trigger}
          type="button"
          className="fp-open-options"
          disabled={disabled}
          aria-label={t('选择打开方式')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => void show()}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              void show();
            }
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
      {open &&
        createPortal(
          <div
            ref={menu}
            popover="auto"
            role="menu"
            aria-label={t('打开方式')}
            className="fp-open-menu"
            style={position}
            onToggle={(event) => {
              if ((event.nativeEvent as ToggleEvent).newState === 'closed') close();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              const controls = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role=menuitem]')],
                at = controls.indexOf(document.activeElement as HTMLButtonElement);
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                controls[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? controls.length - 1
                      : (at + (event.key === 'ArrowDown' ? 1 : controls.length - 1)) % controls.length
                ]?.focus();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
                trigger.current?.focus();
              }
            }}
          >
            {options.map((option) => (
              <button
                type="button"
                role="menuitem"
                className={option.action === 'folder' ? 'fp-open-separated' : undefined}
                key={option.action}
                onClick={() => act(option.action)}
              >
                {option.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
