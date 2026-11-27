import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Icon } from '../ui/Icon';
import './video-controls.css';

/**
 * A slim slider on a native range input, so the keyboard and ARIA come with it. `onChange` follows the drag;
 * `onCommit` fires once the value settles (pointer released, or a key step). Defaults: 0 to 1 in steps of 0.01.
 */
export function VideoRange({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  onCommit,
  'aria-label': ariaLabel,
  disabled,
  className,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  'aria-label': string;
  disabled?: boolean;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  // React's onChange is the input event; the native change event is the one that waits for the release.
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const settle = () => commit.current?.(Number(element.value));
    element.addEventListener('change', settle);
    return () => element.removeEventListener('change', settle);
  }, []);
  const fill = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  return (
    <input
      ref={input}
      type="range"
      className={className ? `vc-range ${className}` : 'vc-range'}
      style={{ '--fill': fill } as CSSProperties}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
    />
  );
}

/**
 * A floating status capsule: a spinner while working, a green tick when done, a red mark on failure. Wrap it in
 * Presence so it also animates out; the caller places it.
 */
export function VideoToast({
  tone,
  children,
  detail,
  progress,
  action,
  onClose,
  closeLabel,
}: {
  /** info: work under way (a spinner); hint: a tip about what to do; ok and error: how something ended. */
  tone: 'info' | 'hint' | 'ok' | 'error';
  children: ReactNode;
  detail?: string;
  /** 0..1 */
  progress?: number;
  action?: { label: string; onClick: () => void };
  onClose?: () => void;
  closeLabel?: string;
}) {
  const { t } = useI18n();
  const ratio = progress === undefined ? undefined : Math.min(1, Math.max(0, progress));
  const close = closeLabel ?? t('关闭提示');
  return (
    <div className={`vc-toast is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'info' ? (
        <i className="vc-spinner" aria-hidden="true" />
      ) : (
        <i className="vc-toast-dot" aria-hidden="true">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path
              d={tone === 'ok' ? 'M5 12.5 9.5 17 19 7.5' : tone === 'hint' ? 'M12 10.5V18M12 6v.2' : 'M12 6v8M12 18v.2'}
            />
          </svg>
        </i>
      )}
      <span className="vc-toast-text">{children}</span>
      {detail ? (
        <small className="vc-toast-detail" title={detail}>
          {detail}
        </small>
      ) : null}
      {ratio !== undefined && (
        <span
          className="vc-toast-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
        >
          <b style={{ '--fill': ratio } as CSSProperties} />
        </span>
      )}
      {action && (
        <button type="button" className="vc-btn is-quiet is-sm" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onClose && (
        <button type="button" className="vc-icon-btn is-sm" aria-label={close} title={close} onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
