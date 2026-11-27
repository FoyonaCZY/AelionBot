import type { AttachmentScope } from '../../shared/types/attachment-types';
import type { PreviewAnnotation } from '../../shared/types/preview-editor-types';
import { pinNumber, pinTitle, unsentPins } from '../../shared/preview/preview-annotations';
import { useI18n } from '../i18n';
import { usePreviewWorkbench } from './PreviewWorkbench';
import { formatPinTimecode } from './preview-utils';
import './preview-annotation-chips.css';

const sameScope = (a?: AttachmentScope, b?: AttachmentScope) => Boolean(a && b && a.kind === b.kind && a.id === b.id);

/** The comments waiting to go out with the next message, as chips: number, what it points at, and what it says. */
export function PinChips({
  marks,
  disabled,
  onSelect,
  onRemove,
}: {
  marks: PreviewAnnotation[];
  disabled?: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  const outgoing = unsentPins(marks);
  if (!outgoing.length) return null;
  return (
    <div className="composer-annotations" role="group" aria-label={t('待发送的评论')}>
      {outgoing.map((mark) => {
        const n = pinNumber(mark, marks.indexOf(mark)),
          label = t(pinTitle(mark)),
          note = mark.text?.trim() || '';
        return (
          <span className={`composer-annotation ${mark.author === 'bot' ? 'is-bot' : ''}`} key={mark.id}>
            <button
              type="button"
              className="composer-annotation-body"
              disabled={disabled}
              title={note || mark.elementText || label}
              onClick={() => onSelect(mark.id)}
            >
              <b aria-hidden="true">{n}</b>
              {mark.timestampSec !== undefined && (
                <code className="composer-annotation-time">{formatPinTimecode(mark.timestampSec)}</code>
              )}
              <span>
                {label}
                {note ? (
                  <em>{note.length > 24 ? note.slice(0, 24) + '…' : note}</em>
                ) : (
                  <em className="is-empty">{t('还没写')}</em>
                )}
              </span>
            </button>
            <button
              type="button"
              className="composer-annotation-remove"
              disabled={disabled}
              aria-label={t('删除评论 {index}', { index: n })}
              onClick={() => onRemove(mark.id)}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Comments made on the preview beside this composer. They go out with the next message (the preview adds the
 * screenshot), so they sit inside the composer like attachments instead of in a second input box.
 */
export function PreviewAnnotationChips({ scope }: { scope: AttachmentScope }) {
  const workbench = usePreviewWorkbench(),
    info = workbench?.info;
  if (!info || !info.docked || !sameScope(info.scope, scope)) return null;
  return (
    <PinChips
      marks={info.annotations}
      onSelect={(id) => workbench?.annotations?.select(id)}
      onRemove={(id) => workbench?.annotations?.remove(id)}
    />
  );
}
