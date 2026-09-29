import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { MessageReasoning as Reasoning } from '../../shared/types/core';
import type { ReasoningDisplay } from '../../shared/preview/appearance';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import './message-reasoning.css';

const subscribe = (change: () => void) => {
  window.addEventListener('aelion-appearance-change', change);
  return () => window.removeEventListener('aelion-appearance-change', change);
};
const display = () => (document.documentElement.dataset.reasoning || 'collapsed') as ReasoningDisplay;
/** The appearance setting for reasoning: collapsed, expanded or hidden. */
export const useReasoningDisplay = () => useSyncExternalStore(subscribe, display);

function useElapsed(startedAt: string | undefined, running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const started = startedAt ? Date.parse(startedAt) : NaN;
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

/** Model reasoning above a reply: live while the model thinks, then a one-line disclosure. */
export function MessageReasoning({ reasoning, streaming = false }: { reasoning?: Reasoning; streaming?: boolean }) {
  const { t } = useI18n();
  const mode = useSyncExternalStore(subscribe, display);
  const bodyId = useId();
  const live = streaming && reasoning?.durationMs === undefined;
  const elapsed = useElapsed(reasoning?.startedAt, live);
  const [open, setOpen] = useState(mode === 'expanded');
  if (mode === 'hidden' || !reasoning?.text.trim()) return null;
  const seconds = Math.max(1, Math.round((live ? elapsed : reasoning.durationMs || 0) / 1000));
  const label = live
    ? t('正在思考')
    : reasoning.durationMs === undefined
      ? t('已思考')
      : seconds >= 60
        ? t('已思考 {minutes} 分 {seconds} 秒', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
        : t('已思考 {seconds} 秒', { seconds });
  const expanded = live || open;
  return (
    <div className={`message-reasoning ${live ? 'is-live' : ''} ${expanded ? 'is-open' : ''}`}>
      <button
        type="button"
        className="reasoning-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        aria-label={live ? label : t(open ? '收起思考过程' : '展开思考过程')}
        disabled={live}
        onClick={() => setOpen(!open)}
      >
        <Icon name="sparkle" size={14} />
        <span className="reasoning-label">{label}</span>
        {live && reasoning.startedAt && (
          <span className="reasoning-meta">{t('{seconds} 秒', { seconds: Math.floor(elapsed / 1000) })}</span>
        )}
        {!live && <Icon name="chevron" size={12} />}
      </button>
      {/* Streaming text is not a live region: announcing every delta would drown out the reply. */}
      {expanded && (
        <div className="reasoning-body" id={bodyId}>
          {live ? <div className="reasoning-tail">{reasoning.text.trim()}</div> : reasoning.text.trim()}
        </div>
      )}
    </div>
  );
}
