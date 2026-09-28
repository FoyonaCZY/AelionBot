import { useRef, useState } from 'react';
import { Select } from '../ui/Select';
import { PreviewIcon } from './PreviewIcon';
import { PreviewToolbar } from './PreviewToolbar';
import { useImmersivePreview } from './preview-layout';
import { usePreviewViewport } from './use-preview-viewport';
import { useI18n } from '../i18n';

export function ImagePreview({ src, name }: { src: string; name: string }) {
  const { t } = useI18n();
  const immersive = useImmersivePreview(),
    [sizing, setSizing] = useState<'width' | 'fit'>('fit');
  const padding = immersive ? 0 : 24;
  const [zoom, setZoom] = useState<number | null>(null),
    [size, setSize] = useState({ width: 0, height: 0 }),
    [error, setError] = useState(false);
  const viewport = useRef<HTMLDivElement>(null),
    drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const room = usePreviewViewport(viewport, true, padding);
  const fit = size.width
      ? sizing === 'width'
        ? room.width / size.width
        : Math.min(1, room.width / size.width, room.height / size.height)
      : 1,
    scale = zoom ?? fit;
  const change = (delta: number) => setZoom(Math.max(0.1, Math.min(4, Math.round((scale + delta) * 100) / 100)));
  return (
    <>
      <PreviewToolbar>
        <div className="fp-tools">
          <button onClick={() => change(-0.25)} disabled={scale <= 0.1} title={t('缩小')} aria-label={t('缩小图片')}>
            <PreviewIcon name="minus" />
          </button>
          <Select
            className="fp-zoom-picker"
            aria-label={t('图片缩放比例')}
            value={zoom === null ? sizing : String(Math.round(scale * 100))}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'fit' || value === 'width') {
                setSizing(value);
                setZoom(null);
              } else setZoom(Number(value) / 100);
            }}
          >
            <option value="fit">{t('适应窗口')}</option>
            <option value="width">{t('适应宽度')}</option>
            {zoom !== null && ![25, 50, 75, 100, 125, 150, 200, 300, 400].includes(Math.round(scale * 100)) && (
              <option value={Math.round(scale * 100)}>{Math.round(scale * 100)}%</option>
            )}
            {[25, 50, 75, 100, 125, 150, 200, 300, 400].map((value) => (
              <option key={value} value={value}>
                {value}%
              </option>
            ))}
          </Select>
          <button onClick={() => change(0.25)} disabled={scale >= 4} title={t('放大')} aria-label={t('放大图片')}>
            <PreviewIcon name="plus" />
          </button>
          <button aria-pressed={zoom === 1} onClick={() => setZoom(1)} title={t('原始尺寸')} aria-label={t('原始尺寸')}>
            1:1
          </button>
        </div>
      </PreviewToolbar>
      <div
        className="fp-image-stage"
        ref={viewport}
        tabIndex={0}
        aria-label={t('图片画布，可滚动或拖动查看')}
        onDoubleClick={() => setZoom(zoom === null ? 1 : null)}
        onPointerDown={(event) => {
          if (event.button !== 0 || !viewport.current) return;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: viewport.current.scrollLeft,
            top: viewport.current.scrollTop,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current,
            el = viewport.current;
          if (start && el) {
            el.scrollLeft = start.left - (event.clientX - start.x);
            el.scrollTop = start.top - (event.clientY - start.y);
          }
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
      >
        {error ? (
          <div className="fp-state">{t('这张图片暂时无法显示，可以保存原文件后查看。')}</div>
        ) : (
          <div
            className="fp-image-space"
            style={{ minWidth: size.width * scale + padding * 2, minHeight: size.height * scale + padding * 2 }}
          >
            <img
              src={src}
              alt={name}
              draggable={false}
              onError={() => setError(true)}
              onLoad={(event) =>
                setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
              }
              style={size.width ? { width: size.width * scale, height: size.height * scale } : undefined}
            />
          </div>
        )}
      </div>
    </>
  );
}
