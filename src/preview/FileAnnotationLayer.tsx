import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { translate } from '../../shared/i18n';
import { nextPinNumber, PIN, pinColor, pinNumber, straightStroke } from '../../shared/preview/preview-annotations';
import type { AnnotationTool, PreviewAnnotation, PreviewMode } from '../../shared/types/preview-editor-types';
import { usePreviewRuntime } from './preview-runtime';
import { formatPinTimecode } from './preview-utils';
/**
 * Comment pins over a file preview (PDF page, image, document, code). The select tool drops a pin where it is
 * clicked or around a dragged region; the pen draws, and a straight stroke becomes an arrow. Each pin is numbered.
 */
export function FileAnnotationLayer({
  itemId,
  revision,
  mode,
  tool,
  onChange,
  register,
  initialCache,
  onCacheChange,
  selectedAnnotationId,
  onSelectAnnotation,
}: {
  selectedAnnotationId?: string;
  onSelectAnnotation?: (id: string) => void;
  initialCache?: Record<string, PreviewAnnotation[]>;
  onCacheChange?: (value: Record<string, PreviewAnnotation[]>) => void;
  itemId: string;
  revision: string;
  mode: PreviewMode;
  tool: AnnotationTool;
  onChange: (value: PreviewAnnotation[]) => void;
  register: (update: (value: PreviewAnnotation[]) => void) => () => void;
}) {
  const runtime = usePreviewRuntime();
  const root = useRef<SVGSVGElement>(null),
    targets = useRef({ x: 0, y: 0, width: 1, height: 1, key: '', isVideo: false }),
    cache = useRef(
      new Map<string, PreviewAnnotation[]>(
        Object.entries(initialCache || {}).filter(([key]) => !key.startsWith('web:')),
      ),
    ),
    [marks, setMarks] = useState<PreviewAnnotation[]>([]),
    [shape, setShape] = useState<PreviewAnnotation>(),
    [videoTime, setVideoTime] = useState<number | undefined>(undefined),
    [geometry, setGeometry] = useState({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      hostWidth: 1,
      hostHeight: 1,
      enabled: false,
      isVideo: false,
    }),
    drawing = useRef<PreviewAnnotation | undefined>(undefined),
    latestShape = useRef<PreviewAnnotation | undefined>(undefined),
    pointer = useRef<number | undefined>(undefined);
  const update = (value: PreviewAnnotation[]) => {
    cache.current.set(targets.current.key, value);
    setMarks(value);
    onCacheChange?.(Object.fromEntries(cache.current));
  };
  useEffect(() => register(update), [register]);
  useEffect(() => onChange(marks), [marks, onChange]);
  useLayoutEffect(() => {
    const svg = root.current,
      content = svg?.closest<HTMLElement>('.fp-content');
    if (!svg || !content) return;
    let frame = 0;
    let observed: Element | undefined;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (content.querySelector('.web-preview')) {
          setGeometry((old) => (old.enabled ? { ...old, enabled: false } : old));
          return;
        }
        const target = content.querySelector<HTMLElement>(
          '.fp-pdf-viewport .fp-pdf-page,.fp-image-space img,.vp-media-surface,.vs-canvas-surface,.fp-code-text code,.fp-paper,.fp-csv,.cm-content',
        );
        if (!target) {
          setGeometry((old) => (old.enabled ? { ...old, enabled: false } : old));
          return;
        }
        const isVideo = target.matches('.vp-media-surface,.vs-canvas-surface');
        if (isVideo) {
          const parsedTime = Number(target.dataset.videoTime);
          const nextTime = Number.isFinite(parsedTime) ? parsedTime : undefined;
          setVideoTime((old) => (old === nextTime ? old : nextTime));
        } else {
          setVideoTime((old) => (old === undefined ? old : undefined));
        }
        if (observed !== target) {
          if (observed) resize.unobserve(observed);
          resize.observe(target);
          observed = target;
        }
        const a = target.getBoundingClientRect(),
          b = content.getBoundingClientRect(),
          page = content.querySelector<HTMLElement>('[data-preview-page]')?.dataset.previewPage || '1',
          key = itemId + ':' + revision + ':' + page + ':' + (target.matches('.cm-content') ? 'editor' : 'preview');
        if (targets.current.key !== key) {
          targets.current.key = key;
          let value = cache.current.get(key);
          // Pins a Bot placed with preview_mark wait under the item until its page is shown.
          const pending = cache.current.get('pending:' + itemId);
          if (pending?.length && !target.matches('.cm-content')) {
            const here = pending.filter((mark) => (mark.page || 1) === Number(page));
            if (here.length) {
              value = [...(value || []), ...here];
              cache.current.set(key, value);
              cache.current.set(
                'pending:' + itemId,
                pending.filter((mark) => !here.includes(mark)),
              );
              onCacheChange?.(Object.fromEntries(cache.current));
            }
          }
          setMarks(value || []);
          setShape(undefined);
          drawing.current = undefined;
        }
        targets.current = { x: a.x, y: a.y, width: Math.max(1, a.width), height: Math.max(1, a.height), key, isVideo };
        const nextGeometry = {
          x: a.x - b.x,
          y: a.y - b.y,
          width: a.width,
          height: a.height,
          hostWidth: b.width,
          hostHeight: b.height,
          enabled: a.width > 0 && a.height > 0,
          isVideo,
        };
        setGeometry((old) =>
          old.x === nextGeometry.x &&
          old.y === nextGeometry.y &&
          old.width === nextGeometry.width &&
          old.height === nextGeometry.height &&
          old.hostWidth === nextGeometry.hostWidth &&
          old.hostHeight === nextGeometry.hostHeight &&
          old.enabled === nextGeometry.enabled &&
          old.isVideo === nextGeometry.isVideo
            ? old
            : nextGeometry,
        );
      });
    };
    const resize = new ResizeObserver(refresh);
    resize.observe(content);
    const mutations = new MutationObserver(refresh);
    mutations.observe(content, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-preview-page', 'data-video-time'],
    });
    content.addEventListener('scroll', refresh, true);
    window.addEventListener('resize', refresh);
    refresh();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      content.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
      cancelAnimationFrame(frame);
    };
  }, [itemId, revision]);
  useEffect(() => {
    if (mode === 'annotate') return;
    const id = pointer.current;
    if (id !== undefined && root.current?.hasPointerCapture(id)) root.current.releasePointerCapture(id);
    pointer.current = undefined;
    drawing.current = undefined;
    latestShape.current = undefined;
    setShape(undefined);
  }, [mode]);
  const point = (e: React.PointerEvent) => ({
    x: Math.max(0, Math.min(1, (e.clientX - targets.current.x) / targets.current.width)),
    y: Math.max(0, Math.min(1, (e.clientY - targets.current.y) / targets.current.height)),
  });
  const coordinate = (p: { x: number; y: number }) => ({
    x: geometry.x + p.x * geometry.width,
    y: geometry.y + p.y * geometry.height,
  });
  const render = (a: PreviewAnnotation, i: number) => {
    const p = coordinate(a),
      end = a.end && coordinate(a.end),
      x = p.x,
      y = p.y,
      w = (a.w || 0) * geometry.width,
      h = (a.h || 0) * geometry.height,
      draft = i < 0,
      color = draft ? PIN.focus : pinColor(a),
      focus = draft || selectedAnnotationId === a.id,
      angle = end ? Math.atan2(end.y - y, end.x - x) : 0,
      timeLabel = a.timestampSec !== undefined ? formatPinTimecode(a.timestampSec) : '',
      offFrame =
        !draft &&
        !focus &&
        videoTime !== undefined &&
        a.timestampSec !== undefined &&
        Math.abs(a.timestampSec - videoTime) > 1.5;
    return (
      <g key={a.id} data-annotation-id={draft ? undefined : a.id} opacity={offFrame ? 0.42 : 1}>
        {(a.type === 'rect' || a.type === 'element') && (w > 0 || h > 0) && (
          <rect
            x={x - 3}
            y={y - 3}
            width={w + 6}
            height={h + 6}
            rx={6}
            fill={color + (focus ? '12' : '08')}
            stroke={focus ? PIN.focus : color}
            strokeWidth={focus ? 2 : 1.5}
          />
        )}
        {a.type === 'arrow' && end && (
          <>
            <line x1={x} y1={y} x2={end.x} y2={end.y} stroke={color} strokeWidth={2} strokeLinecap="round" />
            <path
              d={`M ${end.x - 11 * Math.cos(angle - 0.45)} ${end.y - 11 * Math.sin(angle - 0.45)} L ${end.x} ${end.y} L ${end.x - 11 * Math.cos(angle + 0.45)} ${end.y - 11 * Math.sin(angle + 0.45)}`}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
        {a.type === 'pen' && (
          <polyline
            points={a.points
              ?.map(coordinate)
              .map((p) => p.x + ',' + p.y)
              .join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {!draft && (
          <g
            data-pin-id={a.id}
            style={{ pointerEvents: mode === 'edit' ? 'none' : 'visiblePainted', cursor: 'pointer' }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              event.preventDefault();
              onSelectAnnotation?.(a.id);
            }}
          >
            {focus && <circle cx={x} cy={y} r={15} fill={PIN.focus + '2e'} />}
            <circle cx={x} cy={y} r={11} fill={color} stroke="#fff" strokeWidth={2} />
            {a.status === 'working' && (
              <circle
                className="file-annotation-working"
                cx={x}
                cy={y}
                r={15}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeDasharray="4 4"
              />
            )}
            <text x={x} y={y + 3.5} textAnchor="middle" fontSize={10} fontWeight={600} fill="#fff">
              {pinNumber(a, i)}
            </text>
            {timeLabel && (
              <g transform={`translate(${x + 14}, ${y - 9})`}>
                <rect
                  x={0}
                  y={0}
                  width={Math.max(42, timeLabel.length * 6.5 + 10)}
                  height={18}
                  rx={9}
                  fill="rgba(20, 22, 26, 0.84)"
                  stroke="rgba(255, 255, 255, 0.25)"
                  strokeWidth={1}
                />
                <text
                  x={Math.max(42, timeLabel.length * 6.5 + 10) / 2}
                  y={12.5}
                  textAnchor="middle"
                  fontSize={9.5}
                  fontWeight={600}
                  fontFamily="var(--font-code, monospace)"
                  fill="#fff"
                >
                  {timeLabel}
                </text>
              </g>
            )}
          </g>
        )}
      </g>
    );
  };
  const move = (p: { x: number; y: number }) => {
    const a = drawing.current;
    if (!a) return;
    const last = latestShape.current || a;
    const next = {
      ...a,
      ...(a.type === 'rect'
        ? { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) }
        : a.type === 'pen'
          ? { points: [...(last.points || []).slice(-2998), p] }
          : {}),
    };
    latestShape.current = next;
    setShape(next);
    return next;
  };
  useEffect(() => {
    const svg = root.current;
    if (!svg) return;
    const wheel = (event: WheelEvent) => {
      const content = svg.closest('.fp-content'),
        view = content?.querySelector<HTMLElement>(
          '.fp-pdf-viewport,.fp-image-stage,.cm-scroller,.fp-csv,.fp-document-stage',
        );
      if (!view) return;
      event.preventDefault();
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1;
      view.scrollBy(event.deltaX * factor, event.deltaY * factor);
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  }, []);
  /** What the gesture leaves behind, or nothing for a stray click with the pen. */
  const finish = (a: PreviewAnnotation): PreviewAnnotation | undefined => {
    const { width, height } = targets.current;
    if (a.type === 'pen') {
      const points = a.points || [];
      if (points.length < 3) return;
      return straightStroke(points, width, height) ? { ...a, type: 'arrow', end: points.at(-1), points: undefined } : a;
    }
    // A short drag is a click: a pin at that point.
    if ((a.w || 0) * width < 6 && (a.h || 0) * height < 6) {
      const start = drawing.current || a;
      return { ...a, x: start.x, y: start.y, w: 0, h: 0 };
    }
    return a;
  };
  return (
    <svg
      ref={root}
      className="file-annotation-layer"
      data-tool={tool}
      style={{
        display: geometry.enabled ? undefined : 'none',
        // On video & studio previews, keep pointer events scoped strictly to the media frame rect so transport
        // controls, filmstrip scrubber, pin jump markers, and timeline stay interactive in annotate mode.
        pointerEvents: mode === 'annotate' && !geometry.isVideo ? 'auto' : 'none',
        visibility: mode === 'edit' ? 'hidden' : undefined,
        cursor: mode === 'annotate' && !geometry.isVideo ? 'crosshair' : undefined,
      }}
      viewBox={`0 0 ${geometry.hostWidth} ${geometry.hostHeight}`}
      aria-label={translate('文件评论')}
      onPointerDown={(e) => {
        if (e.button !== 0 || mode !== 'annotate' || marks.length >= 100 || pointer.current !== undefined) return;
        const target = targets.current;
        if (
          e.clientX < target.x ||
          e.clientX > target.x + target.width ||
          e.clientY < target.y ||
          e.clientY > target.y + target.height
        )
          return;
        const p = point(e),
          page =
            Number(
              root.current?.closest('.fp-content')?.querySelector<HTMLElement>('[data-preview-page]')?.dataset
                .previewPage,
            ) || undefined;
        let timestampSec: number | undefined;
        if (target.isVideo) {
          runtime?.video?.pause();
          const raw =
            runtime?.video?.getCurrentTimeSec() ??
            Number(
              root.current?.closest('.fp-content')?.querySelector<HTMLElement>('.vp-media-surface,.vs-canvas-surface')
                ?.dataset.videoTime,
            );
          if (Number.isFinite(raw) && raw >= 0) {
            timestampSec = Math.round(raw * 100) / 100;
          }
        }
        const a: PreviewAnnotation = {
          id: crypto.randomUUID(),
          type: tool === 'pen' ? 'pen' : 'rect',
          ...p,
          w: 0,
          h: 0,
          color: PIN.mine,
          ...(page ? { page } : {}),
          ...(timestampSec !== undefined ? { timestampSec } : {}),
          ...(tool === 'pen' ? { points: [p] } : {}),
        };
        pointer.current = e.pointerId;
        drawing.current = a;
        latestShape.current = a;
        setShape(a);
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (pointer.current === e.pointerId) move(point(e));
      }}
      onPointerUp={(e) => {
        if (pointer.current !== e.pointerId) return;
        const drawn = move(point(e)),
          a = drawn && finish(drawn);
        if (a) update([...marks, { ...a, n: nextPinNumber(marks) }]);
        pointer.current = undefined;
        drawing.current = undefined;
        latestShape.current = undefined;
        setShape(undefined);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        pointer.current = undefined;
        drawing.current = undefined;
        latestShape.current = undefined;
        setShape(undefined);
      }}
    >
      {mode === 'annotate' && geometry.isVideo && (
        <rect
          x={geometry.x}
          y={geometry.y}
          width={geometry.width}
          height={geometry.height}
          fill="transparent"
          style={{ pointerEvents: 'all', cursor: 'crosshair' }}
        />
      )}
      {marks.map(render)}
      {shape && render(shape, -1)}
    </svg>
  );
}
