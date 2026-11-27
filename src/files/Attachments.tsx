import { sourceTextFile } from '../../shared/preview/source-language';
import { useEffect, useState } from 'react';
import { useFilePreview, usePreviewScope, type PreviewItem } from '../preview/FilePreviewContext';
import { FilePreview } from '../preview/FilePreview';
import type { Attachment } from '../../shared/types/attachment-types';
import type { ArtifactPreview } from '../../shared/types/core';
import type { VideoMediaPosterResult } from '../../shared/types/video-studio-types';
import { formatShortDuration } from '../preview/preview-utils';
import { FileGlyph, FileInfo, fileKind, FileTypeBadge } from './FileAppearance';
import { useI18n } from '../i18n';
import { Icon } from '../ui/Icon';
import { bytes } from '../ui/format';
import '../preview/video-controls.css';
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
/** A pending file in the composer: a small tag with its type and name. */
function AttachmentCard({ file, onRemove, onOpen }: { file: Attachment; onRemove?: () => void; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <article className="attachment-card file-tile attachment-tag" data-attachment-id={file.id}>
      <button
        type="button"
        className="attachment-open file-tile-open"
        onClick={onOpen}
        title={t('预览 {name}', { name: file.name })}
        aria-label={t('预览附件 {name}', { name: file.name })}
      >
        <FileTypeBadge name={file.name} mime={file.mime} />
        <FileInfo name={file.name} size={file.size} mime={file.mime} compact />
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
const excerpts = new Map<string, Promise<string>>();
const videoPosters = new Map<string, Promise<VideoMediaPosterResult | null>>();

const videoPoster = (file: Attachment) => {
  if (!window.aelion?.videoMediaPoster) return Promise.resolve(null);
  let value = videoPosters.get(file.id);
  if (!value) {
    value = window.aelion
      .videoMediaPoster({ source: { kind: 'attachment', attachmentId: file.id }, maxWidth: 360 })
      .then(
        (result) => {
          if (!result) videoPosters.delete(file.id);
          return result;
        },
        () => {
          videoPosters.delete(file.id);
          return null;
        },
      );
    if (videoPosters.size >= 80) videoPosters.delete(videoPosters.keys().next().value!);
    videoPosters.set(file.id, value);
  }
  return value;
};
/** The opening of a text file, drawn small on its tile. Other formats would need rendering first, so they show a glyph. */
const excerpt = (file: Attachment) => {
  let value = excerpts.get(file.id);
  if (!value) {
    value = window.aelion.previewAttachment(file.id).then(
      (result) => (result.content || '').slice(0, 1600),
      () => '',
    );
    if (excerpts.size >= 80) excerpts.delete(excerpts.keys().next().value!);
    excerpts.set(file.id, value);
  }
  return value;
};
const hasExcerpt = (file: Attachment) =>
  file.size <= 1048576 && (sourceTextFile(file.name) || file.mime.startsWith('text/'));
/** A text file's first lines as a miniature page: a table for CSV, headings and paragraphs for prose, code as it is. */
function FileMiniature({ name, text }: { name: string; text: string }) {
  const suffix = name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
    lines = text.split(/\r?\n/);
  if (suffix === 'csv' || suffix === 'tsv') {
    const rows = lines
      .filter((line) => line.trim())
      .slice(0, 9)
      .map((line) =>
        line
          .split(suffix === 'tsv' ? '\t' : ',')
          .slice(0, 3)
          .map((cell) => cell.trim().replace(/^"|"$/g, '')),
      );
    return (
      <table className="file-mini is-table">
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (index ? <td key={column}>{cell}</td> : <th key={column}>{cell}</th>))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (!['md', 'markdown', 'txt', 'log'].includes(suffix)) return <pre className="file-mini is-code">{text}</pre>;
  return (
    <div className="file-mini">
      {lines
        .filter((line) => line.trim() && !/^\s*([-=*_]{3,}|```.*)\s*$/.test(line))
        .slice(0, 16)
        .map((line, index) => {
          const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
          const copy = (heading ? heading[1] : line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '· ')).replace(/[*_`]/g, '');
          return heading ? <b key={index}>{copy}</b> : <p key={index}>{copy}</p>;
        })}
    </div>
  );
}
/** A file in a message: what it holds on top (its first lines, a video poster, or its kind), its name and size below. */
function AttachmentTile({ file, onOpen }: { file: Attachment; onOpen: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [poster, setPoster] = useState<VideoMediaPosterResult | null>(null);
  const readable = hasExcerpt(file);
  const kind = fileKind(file.name, file.mime);
  const video = kind === 'video';
  useEffect(() => {
    let active = true;
    if (readable)
      void excerpt(file).then((value) => {
        if (active) setText(value);
      });
    return () => {
      active = false;
    };
  }, [file.id, readable]);
  useEffect(() => {
    if (!video) {
      setPoster(null);
      return;
    }
    let active = true;
    void videoPoster(file).then((value) => {
      if (active) setPoster(value);
    });
    return () => {
      active = false;
    };
  }, [file.id, video]);
  return (
    <article
      className={`attachment-thumb file-type-${kind} ${video ? 'is-video-card' : ''}`}
      data-attachment-id={file.id}
    >
      <div className="attachment-thumb-preview" aria-hidden="true">
        {video ? (
          <div className="attachment-video-poster">
            {poster?.posterDataUrl ? (
              <img src={poster.posterDataUrl} alt="" draggable={false} />
            ) : (
              <FileGlyph kind="video" />
            )}
            <span className="attachment-video-play vc-glass">
              <Icon name="play" size={17} />
            </span>
            {typeof poster?.durationSec === 'number' && poster.durationSec > 0 && (
              <span className="attachment-video-duration vc-glass">{formatShortDuration(poster.durationSec)}</span>
            )}
          </div>
        ) : text.trim() ? (
          <div className="attachment-thumb-page">
            <FileMiniature name={file.name} text={text} />
          </div>
        ) : (
          <FileGlyph kind={kind} />
        )}
      </div>
      {/* The button's ::before covers the tile, so the whole tile opens the preview. */}
      <button
        type="button"
        className="attachment-thumb-open"
        onClick={onOpen}
        title={t('预览 {name}', { name: file.name })}
        aria-label={t('预览附件 {name}', { name: file.name })}
      >
        <FileInfo name={file.name} size={file.size} mime={file.mime} />
      </button>
      <button
        type="button"
        className="attachment-thumb-save"
        title={t('另存为')}
        aria-label={t('保存 {name}', { name: file.name })}
        onClick={() => void window.aelion.saveAttachment(file.id)}
      >
        <Icon name="download" size={14} />
      </button>
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
          {others.map((file, index) =>
            compact ? (
              <AttachmentCard
                key={file.id}
                file={file}
                onOpen={() => open(others, index)}
                onRemove={onRemove ? () => onRemove(file.id) : undefined}
              />
            ) : (
              <AttachmentTile key={file.id} file={file} onOpen={() => open(others, index)} />
            ),
          )}
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
