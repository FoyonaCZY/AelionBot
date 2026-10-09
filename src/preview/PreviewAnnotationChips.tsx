import type { AttachmentScope } from '../../shared/types/attachment-types';
import { useI18n } from '../i18n';
import { usePreviewWorkbench } from './PreviewWorkbench';
import './preview-annotation-chips.css';

const sameScope = (a?: AttachmentScope, b?: AttachmentScope) => Boolean(a && b && a.kind === b.kind && a.id === b.id);

/**
 * Marks made on the preview beside this composer. They are sent with the next message (the preview adds the
 * screenshot), so they sit inside the composer like attachments instead of in a second input box.
 */
export function PreviewAnnotationChips({ scope }: { scope: AttachmentScope }) {
  const { t } = useI18n(),
    workbench = usePreviewWorkbench(),
    info = workbench?.info;
  if (!info || !info.docked || !sameScope(info.scope, scope) || !info.annotations.length) return null;
  const kind = { rect: '区域', element: '元素', arrow: '箭头', pen: '画笔', text: '文字' } as const;
  return (
    <div className="composer-annotations" role="group" aria-label={t('已标注的位置')}>
      {info.annotations.map((mark, index) => {
        const label = mark.elementLabel || t(kind[mark.type]),
          note = mark.text && mark.text !== '标注' && mark.text !== 'Annotation' ? mark.text : '';
        return (
          <span className="composer-annotation" key={mark.id}>
            <button
              type="button"
              className="composer-annotation-body"
              title={mark.elementText || note || label}
              onClick={() => workbench?.annotations?.select(mark.id)}
            >
              <b aria-hidden="true">{index + 1}</b>
              <span>
                {label}
                {note && <em>「{note.length > 24 ? note.slice(0, 24) + '…' : note}」</em>}
              </span>
            </button>
            <button
              type="button"
              className="composer-annotation-remove"
              aria-label={t('删除标注 {index}', { index: index + 1 })}
              onClick={() => workbench?.annotations?.remove(mark.id)}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}
