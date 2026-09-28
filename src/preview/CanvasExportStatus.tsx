import { useI18n } from '../i18n';
import type { CanvasExportFormat } from '../../shared/preview/canvas-export';
import './canvas-export-status.css';
export interface CanvasExportState {
  phase: 'running' | 'success' | 'error' | 'cancelled';
  format: CanvasExportFormat | 'original';
  name: string;
  itemId: string;
  detail?: string;
}
export function CanvasExportStatus({
  state,
  onDismiss,
  onRetry,
}: {
  state: CanvasExportState;
  onDismiss: () => void;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const format =
    state.format === 'original' ? t('文件') : state.format === 'sketch' ? 'Sketch' : state.format.toUpperCase();
  const title =
    state.phase === 'running'
      ? t('正在导出 {format}…', { format })
      : state.phase === 'success'
        ? t('{format} 已导出', { format })
        : state.phase === 'error'
          ? t('导出失败')
          : t('已取消导出');
  return (
    <div
      className={'fp-export-status is-' + state.phase}
      role={state.phase === 'error' ? 'alert' : 'status'}
      aria-live={state.phase === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      {state.phase === 'running' ? (
        <span className="fp-export-spinner" aria-hidden="true" />
      ) : (
        <span className="fp-export-status-symbol" aria-hidden="true">
          {state.phase === 'success' ? '✓' : state.phase === 'error' ? '!' : '−'}
        </span>
      )}
      <div className="fp-export-status-copy">
        <strong>{title}</strong>
        <span title={state.detail || state.name}>{state.detail || state.name}</span>
      </div>
      {state.phase === 'error' && onRetry && (
        <button type="button" onClick={onRetry}>
          {t('重试')}
        </button>
      )}
      {state.phase !== 'running' && (
        <button type="button" className="fp-export-dismiss" onClick={onDismiss} aria-label={t('关闭导出提示')}>
          ×
        </button>
      )}
    </div>
  );
}
