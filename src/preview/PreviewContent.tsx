import { lazy, Suspense, useEffect, useState } from 'react';
import type { ArtifactPreview } from '../../shared/types/core';
import { WebPreview } from './WebPreview';
import { DocumentPreview } from './DocumentPreview';
import { FileTypeBadge } from '../files/FileAppearance';
import { ImagePreview } from './ImagePreview';
import type { PreviewItem } from './FilePreviewContext';
import { PreviewIcon } from './PreviewIcon';
import { previewErrorText, previewKind } from './preview-utils';
import { useI18n } from '../i18n';

const PdfPreview = lazy(() => import('./PdfPreview'));

export function PreviewContent({
  item,
  retry,
  override,
}: {
  item: PreviewItem;
  retry: number;
  override?: ArtifactPreview;
}) {
  const { t } = useI18n();
  const [loaded, setValue] = useState<ArtifactPreview>(),
    [error, setError] = useState(''),
    [showSource, setShowSource] = useState(false);
  const value = override || loaded;
  const kind = previewKind(item.name);
  useEffect(() => {
    let active = true;
    setValue(undefined);
    setError('');
    item
      .load()
      .then((value) => {
        if (active) setValue(value);
      })
      .catch((error) => {
        if (active) setError(previewErrorText(error));
      });
    return () => {
      active = false;
    };
  }, [item, retry]);
  if (error && !override)
    return (
      <div className="fp-state" role="alert">
        <PreviewIcon name="image" />
        <strong>{t('暂时无法预览')}</strong>
        <p>{error}</p>
      </div>
    );
  if (!value)
    return (
      <div className="fp-state" role="status">
        <span className="fp-loading" />
        <strong>{kind === '演示文稿' ? t('正在准备演示文稿') : t('正在打开预览')}</strong>
      </div>
    );
  const native = Boolean(window.aelion.openWebPreview);
  if (value.kind === 'web')
    return native && value.web ? (
      <WebPreview source={value.web} />
    ) : (
      <div className="fp-state" role="alert">
        {t('请在桌面应用中打开网页预览')}
      </div>
    );
  if (native && value.kind === 'html') {
    if (showSource) return <DocumentPreview value={value} name={item.name} onRendered={() => setShowSource(false)} />;
    const attachmentId = item.id.startsWith('attachment:') ? item.id.slice(11) : undefined;
    return (
      <WebPreview
        fileEditor={item.editor}
        editorContent={override?.content}
        source={{
          kind: 'document',
          format: 'html',
          name: item.name,
          workspace: item.workspace,
          attachmentId,
          ...(override || (!item.workspace && !attachmentId) ? { content: value.content } : {}),
        }}
        onSource={item.editor ? undefined : () => setShowSource(true)}
      />
    );
  }
  if (value.kind === 'image') return <ImagePreview src={value.dataUrl!} name={item.name} />;
  if (value.kind === 'pdf')
    return (
      <Suspense
        fallback={
          <div className="fp-state" role="status">
            {t('正在打开文档…')}
          </div>
        }
      >
        <PdfPreview src={value.dataUrl!} name={item.name} slides={kind === '演示文稿'} />
      </Suspense>
    );
  if (value.kind === 'unsupported')
    return (
      <div className="fp-state">
        <FileTypeBadge name={item.name} />
        <strong>{t('保存后，继续查看')}</strong>
        <p>{t('此格式暂不支持直接预览，可保存到本机打开。')}</p>
      </div>
    );
  return (
    <>
      <DocumentPreview value={value} name={item.name} />
      {value.truncated && (
        <div className="fp-truncated" role="status">
          {t('预览内容已截断，可保存原文件查看全部内容。')}
        </div>
      )}
    </>
  );
}
