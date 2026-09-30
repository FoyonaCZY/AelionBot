import type { Attachment } from '../../shared/types/attachment-types';
import type { DesignFileChange } from '../../shared/designer/design-changes';
import { FileTypeBadge, fileSize } from '../files/FileAppearance';
import { useI18n } from '../i18n';
import { designRoundFiles } from './designer-round';

export function DesignerRoundCard({
  round,
  attachments,
  changes,
  onOpen,
}: {
  round: number;
  attachments: Attachment[];
  changes?: Record<string, DesignFileChange>;
  onOpen: (file: Attachment, all: Attachment[]) => void;
}) {
  const { t } = useI18n();
  const rows = designRoundFiles(attachments, changes);
  if (!rows.length) return null;
  const files = rows.map((row) => row.attachment);
  return (
    <section className="designer-round" aria-label={t('第 {round} 轮产出', { round })}>
      <header>
        <b>{t('第 {round} 轮产出', { round })}</b>
        <span className="designer-round-count">{t('{count} 个文件', { count: rows.length })}</span>
        {rows.length > 1 && (
          <button type="button" onClick={() => onOpen(files[0], files)}>
            {t('全部在画布打开')}
          </button>
        )}
      </header>
      <ul>
        {rows.map(({ attachment, change }) => (
          <li key={attachment.id}>
            <button type="button" className="designer-round-file" onClick={() => onOpen(attachment, files)}>
              <FileTypeBadge name={attachment.name} mime={attachment.mime} />
              <span className="designer-round-name">
                <strong>{attachment.name}</strong>
                <small>
                  {fileSize(attachment.size)}
                  {change && change.writes > 1 && ' · ' + t('本轮改了 {count} 次', { count: change.writes })}
                </small>
              </span>
              {change?.added !== undefined && (
                <span
                  className="designer-round-diff"
                  aria-label={t('新增 {added} 行，删除 {removed} 行', {
                    added: change.added,
                    removed: change.removed ?? 0,
                  })}
                >
                  <ins>+{change.added}</ins> <del>−{change.removed}</del>
                </span>
              )}
              <span className="designer-round-open">{t('打开')}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
