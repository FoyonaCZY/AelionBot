import { useEffect, useRef, useState } from 'react';
import { pickDesignPreviewFiles } from '../../shared/preview/designer-canvas';
import { useDesignThumbnail } from './use-design-thumbnail';
import type { DesignSession, DesignTaskKind } from '../../shared/types/designer-types';
import { PreviewIcon } from '../preview/PreviewIcon';
import { useI18n } from '../i18n';
import './design-styles';

export const statusLabel = (session: DesignSession, en: boolean) =>
  ({
    draft: en ? 'Ready to start' : '待开始',
    running: en ? 'Designing' : '正在设计',
    'awaiting-input': en ? 'Needs your input' : '等待补充',
    review: en ? 'Ready for review' : '待确认',
    completed: en ? 'Accepted' : '已确认',
    paused: en ? 'Paused' : '已暂停',
    failed: en ? 'Needs attention' : '需要处理',
  })[session.status];
export const kindCardLabel = (kind: DesignTaskKind, en: boolean) =>
  ({
    prototype: en ? 'Prototype' : '原型',
    ppt: 'PPT',
    clone: en ? 'Clone' : '网站复刻',
    mobile: en ? 'Mobile' : '移动端',
    document: en ? 'Doc' : '文档',
  })[kind];
/** Opening a card shows that task on the canvas of the conversation it belongs to. */
export function DesignerTaskCard({ session, onOpen }: { session: DesignSession; onOpen?: (id: string) => void }) {
  const { language } = useI18n(),
    en = language === 'en';
  const card = useRef<HTMLButtonElement>(null),
    [near, setNear] = useState(false);
  const changes = Object.values(session.changes || {}).flatMap((run) => Object.entries(run));
  const files = changes.map(([path, change]) => ({
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    size: change.writes,
  }));
  const page =
    session.location === 'host' ? pickDesignPreviewFiles(session.kind, files, session.artifacts)[0] : undefined;
  const path = page?.path;
  const revision = path
    ? [
        session.artifacts.find((a) => a.path === path)?.revision,
        ...changes.filter(([p]) => p === path).map(([, v]) => v.writes),
      ].join(':')
    : '';
  useEffect(() => {
    const node = card.current;
    if (!path || !node) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '160px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [path]);
  const thumbnail = useDesignThumbnail(session.id, near ? path : undefined, revision);
  return (
    <button
      ref={card}
      type="button"
      className="designer-task-card"
      onClick={() =>
        onOpen
          ? onOpen(session.id)
          : window.dispatchEvent(new CustomEvent('aelion-design-task', { detail: { id: session.id } }))
      }
    >
      {thumbnail ? (
        <img src={thumbnail} className="designer-task-thumbnail" alt="" draggable={false} />
      ) : (
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
      )}
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
