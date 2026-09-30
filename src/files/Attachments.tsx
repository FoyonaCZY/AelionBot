import { sourceTextFile } from '../../shared/preview/source-language';
import { useEffect, useState } from 'react';
import { useFilePreview, usePreviewScope, type PreviewItem } from '../preview/FilePreviewContext';
import { FilePreview } from '../preview/FilePreview';
import type { Attachment } from '../../shared/types/attachment-types';
import type { ArtifactPreview } from '../../shared/types/core';
import { FileInfo, FilePreviewHint, FileTypeBadge } from './FileAppearance';
import { useI18n } from '../i18n';
import { Icon } from '../ui/Icon';
import { bytes } from '../ui/format';
import './attachments.css';

const cache = new Map<string, Promise<ArtifactPreview>>();
const preview = (id: string) => {
  let value = cache.get(id);
  if (!value) {
    value = window.aelion.previewAttachment(id).catch((error) => {
      cache.delete(id);
      throw error;
    });
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(id, value);
  }
  return value;
};
export function AttachmentIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8M7 13l6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function AttachmentCard({
  file,
  compact,
  onRemove,
  onOpen,
}: {
  file: Attachment;
  compact: boolean;
  onRemove?: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const [image, setImage] = useState('');
  useEffect(() => {
    let active = true;
    if (file.image)
      void preview(file.id)
        .then((value) => {
          if (active) setImage(value.dataUrl || '');
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [file.id, file.image?.id]);
  return (
    <article
      className={`attachment-card file-tile ${compact ? 'attachment-tag' : ''} ${image ? 'has-image' : ''}`}
      data-attachment-id={file.id}
    >
      <button
        type="button"
        className="attachment-open file-tile-open"
        onClick={onOpen}
        title={t('预览 {name}', { name: file.name })}
        aria-label={t('预览附件 {name}', { name: file.name })}
      >
        {image ? <img src={image} alt="" /> : <FileTypeBadge name={file.name} mime={file.mime} />}
        <FileInfo name={file.name} size={file.size} mime={file.mime} compact={compact} />
        {!compact && <FilePreviewHint />}
      </button>
      {onRemove && (
        <button
          type="button"
          className="attachment-remove"
          title={t('移除附件')}
          aria-label={t('移除附件 {name}', { name: file.name })}
          onClick={onRemove}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      )}
    </article>
  );
}
const isImage = (file: Attachment) => Boolean(file.image) || file.mime.startsWith('image/');
/** Largest box a single chat image may take; its own aspect ratio decides the actual size. */
const SINGLE = { width: 360, height: 280 };
/** Images shown before the last cell turns into "+N". */
const MOSAIC = 4;
function useImageUrl(file: Attachment) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    void preview(file.id)
      .then((value) => {
        if (active) setUrl(value.dataUrl || '');
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [file.id]);
  return url;
}
function GalleryImage({
  file,
  single,
  more = 0,
  onOpen,
}: {
  file: Attachment;
  single: boolean;
  more?: number;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const url = useImageUrl(file);
  // Reserve the final box from stored dimensions so the chat does not jump when the image arrives.
  const ratio = file.image?.width && file.image.height ? file.image.width / file.image.height : 4 / 3,
    width = Math.round(Math.min(SINGLE.width, SINGLE.height * ratio));
  return (
    <figure
      className={`chat-image ${single ? 'is-single' : ''}`}
      data-attachment-id={file.id}
      style={single ? { width, aspectRatio: String(ratio) } : undefined}
    >
      <button
        type="button"
        className="chat-image-open"
        onClick={onOpen}
        aria-label={
          more ? t('查看全部 {count} 张图片', { count: more + 1 }) : t('预览图片 {name}', { name: file.name })
        }
      >
        {url ? <img src={url} alt="" draggable={false} /> : <span className="chat-image-placeholder" />}
        {more > 0 && <span className="chat-image-more">+{more}</span>}
      </button>
      {!more && (
        <>
          <figcaption className="chat-image-caption">
            {file.name} · {bytes(file.size)}
          </figcaption>
          <button
            type="button"
            className="chat-image-save"
            title={t('保存图片')}
            aria-label={t('保存图片 {name}', { name: file.name })}
            onClick={() => void window.aelion.saveAttachment(file.id)}
          >
            <Icon name="download" size={13} />
          </button>
        </>
      )}
    </figure>
  );
}
function ComposerThumb({ file, onOpen, onRemove }: { file: Attachment; onOpen: () => void; onRemove?: () => void }) {
  const { t } = useI18n();
  const url = useImageUrl(file);
  return (
    <article className="composer-thumb" data-attachment-id={file.id} title={file.name}>
      <button
        type="button"
        className="composer-thumb-open"
        onClick={onOpen}
        aria-label={t('预览附件 {name}', { name: file.name })}
      >
        {url ? <img src={url} alt="" draggable={false} /> : <span className="chat-image-placeholder" />}
      </button>
      {onRemove && (
        <button
          type="button"
          className="composer-thumb-remove"
          title={t('移除附件')}
          aria-label={t('移除附件 {name}', { name: file.name })}
          onClick={onRemove}
        >
          <Icon name="close" size={10} />
        </button>
      )}
    </article>
  );
}
export function AttachmentList({
  files = [],
  compact = false,
  onRemove,
  only,
}: {
  files?: Attachment[];
  compact?: boolean;
  onRemove?: (id: string) => void;
  /** Render just the images (shown above a chat bubble) or just the other files (inside it). */
  only?: 'images' | 'files';
}) {
  const openPreview = useFilePreview(),
    feedbackScope = usePreviewScope(),
    [selected, setSelected] = useState<{ items: PreviewItem[]; index: number }>();
  const shown =
    only === 'images' ? files.filter(isImage) : only === 'files' ? files.filter((file) => !isImage(file)) : files;
  const images = shown.filter(isImage),
    others = shown.filter((file) => !isImage(file));
  // Previews page through the files of the same kind that are shown together.
  const open = (group: Attachment[], index: number) => {
    const items = group.map((file) => ({
      id: 'attachment:' + file.id,
      name: file.name,
      size: file.size,
      load: () => preview(file.id),
      save: () => window.aelion.saveAttachment(file.id),
      ...(sourceTextFile(file.name) ? { editor: { read: () => window.aelion.readEditableAttachment(file.id) } } : {}),
    }));
    if (openPreview) openPreview(items, index);
    else setSelected({ items, index });
  };
  if (!shown.length) return null;
  const visible = images.slice(0, MOSAIC),
    hidden = images.length - visible.length;
  return (
    <>
      {images.length > 0 &&
        (compact ? (
          <div className="composer-thumbs">
            {images.map((file, index) => (
              <ComposerThumb
                key={file.id}
                file={file}
                onOpen={() => open(images, index)}
                onRemove={onRemove ? () => onRemove(file.id) : undefined}
              />
            ))}
          </div>
        ) : (
          <div className={`chat-images ${images.length === 1 ? 'is-single' : 'is-mosaic'}`}>
            {visible.map((file, index) => (
              <GalleryImage
                key={file.id}
                file={file}
                single={images.length === 1}
                more={index === visible.length - 1 ? hidden : 0}
                onOpen={() => open(images, index)}
              />
            ))}
          </div>
        ))}
      {others.length > 0 && (
        <div className={`message-attachments ${compact ? 'composer-attachments' : ''}`}>
          {others.map((file, index) => (
            <AttachmentCard
              key={file.id}
              file={file}
              compact={compact}
              onOpen={() => open(others, index)}
              onRemove={onRemove ? () => onRemove(file.id) : undefined}
            />
          ))}
        </div>
      )}
      {selected && (
        <FilePreview
          key={selected.items[selected.index].id}
          items={selected.items}
          feedbackScope={feedbackScope}
          initialIndex={selected.index}
          onClose={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
