import { FileInfo, FileTypeBadge } from '../files/FileAppearance';
import { Icon } from './Icon';
import { useI18n } from '../i18n';

export interface FileItem {
  name: string;
  path: string;
  size: number;
}
export function FileCard({
  file,
  onOpen,
  onSave,
  disabled = false,
}: {
  file: FileItem;
  onOpen: () => void;
  onSave: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <article className="artifact-card file-tile">
      <button
        type="button"
        className="artifact-open file-tile-open"
        onClick={onOpen}
        disabled={disabled}
        title={t('预览 {name}', { name: file.name })}
        aria-label={t('打开 {name}', { name: file.name })}
      >
        <FileTypeBadge name={file.name} />
        <FileInfo name={file.name} size={file.size} />
      </button>
      <button
        type="button"
        className="artifact-save"
        title={t('保存到本地')}
        aria-label={t('保存 {name}', { name: file.name })}
        disabled={disabled}
        onClick={onSave}
      >
        <Icon name="download" size={16} />
      </button>
    </article>
  );
}
