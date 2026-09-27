import type { DesignSession, DesignTaskKind } from '../../shared/types/designer-types';
import { PreviewIcon } from '../preview/PreviewIcon';
import { useI18n } from '../i18n';

const statusLabel = (session: DesignSession, en: boolean) =>
  ({
    draft: en ? 'Ready to start' : '待开始',
    running: en ? 'Designing' : '正在设计',
    'awaiting-input': en ? 'Needs your input' : '等待补充',
    review: en ? 'Ready for review' : '待确认',
    completed: en ? 'Accepted' : '已确认',
    paused: en ? 'Paused' : '已暂停',
    failed: en ? 'Needs attention' : '需要处理',
  })[session.status];
const kindCardLabel = (kind: DesignTaskKind, en: boolean) =>
  ({
    prototype: en ? 'Prototype' : '原型',
    ppt: 'PPT',
    clone: en ? 'Clone' : '网站复刻',
    mobile: en ? 'Mobile' : '移动端',
    document: en ? 'Doc' : '文档',
  })[kind];
export function DesignerTaskCard({ session, onOpen }: { session: DesignSession; onOpen?: (id: string) => void }) {
  const { language } = useI18n(),
    en = language === 'en';
  return (
    <button
      type="button"
      className="designer-task-card"
      onClick={() =>
        onOpen
          ? onOpen(session.id)
          : window.dispatchEvent(new CustomEvent('aelion-design-task', { detail: { id: session.id } }))
      }
    >
      <span className="designer-task-symbol">
        <PreviewIcon
          name={
            session.kind === 'ppt'
              ? 'pages'
              : session.kind === 'mobile'
                ? 'phone'
                : session.kind === 'document'
                  ? 'pages'
                  : session.kind === 'clone'
                    ? 'desktop'
                    : 'code'
          }
        />
      </span>
      <span>
        <strong>{session.title}</strong>
        <small>
          {kindCardLabel(session.kind, en)} · {statusLabel(session, en)}
        </small>
      </span>
      <PreviewIcon name="right" />
    </button>
  );
}
/**
 * Deliverables, checks and the accept action, kept out of the conversation scroll so they stay
 * reachable however long the thread grows. Compact by default; the detail list is opt-in.
 */
