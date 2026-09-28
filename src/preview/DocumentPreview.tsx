import { useState } from 'react';
import type { ArtifactPreview } from '../../shared/types/core';
import { sourceLanguage } from '../../shared/preview/source-language';
import { CodePreview } from './CodePreview';
import { CsvPreview } from './CsvPreview';
import Markdown from '../chat/MessageMarkdown';
import { PreviewIcon } from './PreviewIcon';
import { PreviewToolbar } from './PreviewToolbar';
import { previewFormat, previewHtml } from './preview-utils';
import { useI18n } from '../i18n';

export function DocumentPreview({
  value,
  name,
  onRendered,
}: {
  value: ArtifactPreview;
  name: string;
  onRendered?: () => void;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState(Boolean(onRendered)),
    [device, setDevice] = useState('fit');
  const html = value.kind === 'html',
    markdown = value.kind === 'markdown',
    csv = previewFormat(name) === 'csv';
  return (
    <>
      <PreviewToolbar>
        <div className="fp-segments" aria-label={t('查看方式')}>
          {html || markdown ? (
            <>
              <button
                aria-pressed={!source}
                onClick={() => (onRendered ? onRendered() : setSource(false))}
                title={t('预览')}
                aria-label={t('预览')}
              >
                <PreviewIcon name="eye" />
              </button>
              <button aria-pressed={source} onClick={() => setSource(true)} title={t('源码')} aria-label={t('源码')}>
                <PreviewIcon name="code" />
              </button>
            </>
          ) : (
            <span>{csv ? t('表格') : sourceLanguage(name) ? t('源码') : t('文本')}</span>
          )}
        </div>
        {html && !source && (
          <div className="fp-segments" aria-label={t('网页显示尺寸')}>
            {[
              ['fit', '自适应'],
              ['1440', '桌面'],
              ['768', '平板'],
              ['390', '手机'],
            ].map(([id, label]) => (
              <button
                key={id}
                aria-pressed={device === id}
                onClick={() => setDevice(id)}
                title={t(label)}
                aria-label={t(label)}
              >
                <PreviewIcon
                  name={id === 'fit' ? 'fit' : id === '1440' ? 'desktop' : id === '768' ? 'tablet' : 'phone'}
                />
              </button>
            ))}
          </div>
        )}
      </PreviewToolbar>
      {html && !source ? (
        <div className="fp-web-stage">
          <iframe
            className="fp-web-frame"
            title={name}
            sandbox=""
            srcDoc={previewHtml(value.content || '')}
            style={{ width: device === 'fit' ? '100%' : Number(device) }}
          />
        </div>
      ) : (
        <div
          className={`fp-document-stage ${csv ? 'fp-csv-stage' : !markdown || source ? 'fp-source-stage' : ''}`}
          tabIndex={0}
          aria-label={t('文档内容')}
        >
          {markdown && !source ? (
            <article className="fp-paper markdown">
              <Markdown>{value.content || ''}</Markdown>
            </article>
          ) : csv ? (
            <CsvPreview content={value.content || ''} />
          ) : (
            <CodePreview content={value.content || ''} name={name} />
          )}
        </div>
      )}
    </>
  );
}
