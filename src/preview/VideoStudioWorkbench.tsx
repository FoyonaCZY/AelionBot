import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  VideoClipFit,
  VideoClipSummary,
  VideoEditOperation,
  VideoEffectPreset,
  VideoExportFormat,
  VideoExportJob,
  VideoExportQuality,
  VideoProjectDetail,
  VideoTrackSummary,
  VideoTransitionPreset,
} from '../../shared/types/video-studio-types';
import { pinNumber } from '../../shared/preview/preview-annotations';
import { previewTextInput } from '../../shared/preview/preview-shortcuts';
import { useI18n } from '../i18n';
import { Icon } from '../ui/Icon';
import { useSwitchMotion } from '../ui/motion';
import { Presence } from '../ui/Presence';
import { Select } from '../ui/Select';
import { usePreviewRuntime } from './preview-runtime';
import { formatPinTimecode, formatVideoTimecode, previewErrorText } from './preview-utils';
import { VideoRange, VideoToast } from './video-controls';
import type { VideoPlayerDragOverlay, VideoPlayerFrameEvent, VideoPlayerHostCommand } from './video-player-frame';
import './video-studio.css';

type StudioTab = 'preview' | 'timeline' | 'annotate';

const RATES = [0.5, 1, 1.25, 1.5, 2] as const;
const FADES = [0, 0.3, 0.5, 1, 2] as const;
const EXPORT_FORMATS: ReadonlyArray<{ id: VideoExportFormat; label: string; hint: string }> = [
  { id: 'mp4', label: 'MP4', hint: 'H.264 + AAC' },
  { id: 'webm', label: 'WebM', hint: 'VP9 + Opus' },
  { id: 'gif', label: 'GIF', hint: '动图' },
  { id: 'wav', label: 'WAV', hint: 'PCM 音频' },
  { id: 'png', label: 'PNG', hint: '当前帧静图' },
];
const EXPORT_QUALITIES: ReadonlyArray<{ id: VideoExportQuality; label: string }> = [
  { id: 'draft', label: '草稿' },
  { id: 'standard', label: '标准' },
  { id: 'high', label: '高清' },
];
const TRANSITION_PRESETS: ReadonlyArray<{ id: VideoTransitionPreset | ''; label: string }> = [
  { id: '', label: '无转场' },
  { id: 'cross-dissolve', label: '交叉溶解' },
  { id: 'fade-black', label: '黑场过渡' },
  { id: 'fade-white', label: '白场过渡' },
  { id: 'slide-left', label: '向左滑入' },
  { id: 'slide-right', label: '向右滑入' },
];
/** `look` is a CSS filter close to what the preset renders, for the swatch in the inspector only. */
const EFFECT_PRESETS: ReadonlyArray<{ id: VideoEffectPreset | ''; label: string; look: string }> = [
  { id: '', label: '无效果', look: 'none' },
  { id: 'warm-film', label: '暖色胶片', look: 'sepia(0.35) saturate(1.3)' },
  { id: 'soft-glow', label: '柔光', look: 'brightness(1.12) contrast(0.88)' },
  { id: 'cinematic', label: '电影感', look: 'contrast(1.25) saturate(0.8)' },
  { id: 'grayscale', label: '黑白', look: 'grayscale(1)' },
  { id: 'sepia', label: '复古棕', look: 'sepia(0.9)' },
  { id: 'blur', label: '模糊', look: 'blur(2px)' },
];
const FIT_MODES: ReadonlyArray<{ id: VideoClipFit; label: string }> = [
  { id: 'contain', label: '适应画面' },
  { id: 'cover', label: '裁切铺满' },
  { id: 'fill', label: '拉伸填满' },
  { id: 'none', label: '原始尺寸' },
];

const PLAYER_ORIGIN = 'aelion-video://player';
const PLAYER_BASE_URL = `${PLAYER_ORIGIN}/index.html`;
const MIN_CLIP_US = 200_000;
const ZOOM_MIN = 24;
const ZOOM_MAX = 220;
const ZOOM_STEP = 24;
/** A press becomes a drag after this many pixels, so a click on a clip only selects it. */
const DRAG_THRESHOLD_PX = 3;
/** A dragged edge within this many pixels of the playhead or a neighbour's edge is held there. */
const SNAP_PX = 7;

function isNewerRevision(candidate: string, current: string): boolean {
  if (candidate === current) return false;
  if (/^\d+$/.test(candidate) && /^\d+$/.test(current)) {
    try {
      return BigInt(candidate) > BigInt(current);
    } catch {
      return candidate !== current;
    }
  }
  return true;
}

const STANDARD_TRACK_LABELS: Readonly<Record<string, string>> = {
  'Main Video': '主视频',
  Overlay: '叠加',
  Captions: '字幕',
  Voiceover: '配音',
  'Background Music': '背景音乐',
};

function trackDisplayName(track: VideoTrackSummary, t: (key: string) => string): string {
  const raw = track.name.trim();
  if (raw) {
    const mapped = STANDARD_TRACK_LABELS[raw];
    return mapped ? t(mapped) : raw;
  }
  if (track.kind === 'caption') return t('字幕');
  if (track.kind === 'audio') return t('音轨');
  return track.role === 'storyline' ? t('主视频') : t('叠加');
}

function clipDisplayLabel(clip: VideoClipSummary, project: VideoProjectDetail, t: (key: string) => string): string {
  if (clip.text?.trim()) return clip.text.trim();
  if (clip.name?.trim()) return clip.name.trim();
  if (clip.assetId) {
    const asset = project.assets.find((a) => a.id === clip.assetId);
    if (asset?.name) return asset.name;
  }
  if (clip.kind === 'caption') return t('字幕');
  if (clip.kind === 'text') return t('文字');
  if (clip.kind === 'audio') return t('音频');
  if (clip.kind === 'image') return t('图片');
  return t('视频片段');
}

/** Glyphs only the studio draws; same grid and stroke as Icon (src/ui/Icon.tsx). */
const STUDIO_GLYPHS = {
  ripple: 'M9 6H4.5v12H9M15 6h4.5v12H15M15 12H9m0 0 2.5-2.5M9 12l2.5 2.5',
  text: 'M6 6.5h12M12 6.5V19',
  duck: 'M5 6v12M10 9.5V18M15 13v5M20 15.5V18',
  level: 'M4 8h16M4 16h16M8 5v14M16 5v14',
  image:
    'M5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9A2.5 2.5 0 0 1 5.5 5ZM3.5 16 8 11.5l4 4 3-3 5.5 5.5',
  music: 'M9 17.5V6l10-2v11.5M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  blend: 'M14.5 12a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0ZM20.5 12a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z',
} as const;

function Glyph({ name, size = 15 }: { name: keyof typeof STUDIO_GLYPHS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={STUDIO_GLYPHS[name]} />
    </svg>
  );
}

/**
 * The preview shell closes on Escape from a capture listener on window, and it adds that listener again whenever
 * its own state changes, so one added later can never be sure to run first. This one is added once, when the
 * module loads, and hands Escape to whatever the studio has open (the export popover) before the shell sees it.
 */
let claimEscape: (() => void) | undefined;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || event.isComposing || !claimEscape) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      claimEscape();
    },
    true,
  );
}

/** A data or blob URL as a CSS image value, for the custom properties clips and swatches paint from. */
const cssImage = (url: string) => `url("${url.replace(/["\\\n\r]/g, (char) => encodeURIComponent(char))}")`;

const usToSec = (us: number) => us / 1_000_000;

function trackHue(track: VideoTrackSummary): 'visual' | 'overlay' | 'caption' | 'audio' {
  if (track.kind === 'audio' || track.kind === 'caption') return track.kind;
  return track.role === 'storyline' ? 'visual' : 'overlay';
}

const MUSIC_TRACK = /bgm|music|背景|配乐/i;

function TrackGlyph({ track }: { track: VideoTrackSummary }) {
  if (track.kind === 'caption') return <Icon name="captions" size={14} />;
  if (track.kind === 'audio')
    return MUSIC_TRACK.test(track.name) ? <Glyph name="music" size={14} /> : <Icon name="mic" size={14} />;
  return track.role === 'storyline' ? <Icon name="film" size={14} /> : <Glyph name="image" size={14} />;
}

/**
 * The part of an asset's analysed peaks a clip plays, as a mirrored envelope. The peaks are the ones stored with the
 * asset when it was imported; a clip whose asset has none stays a plain tinted bar. The viewBox stretches it to the
 * clip, so zooming never redraws it, and the stylesheet cuts it into bars of a fixed width.
 */
const ClipWave = memo(function ClipWave({
  peaks,
  from,
  to,
}: {
  peaks: readonly number[];
  /** 0..1 of the asset where the clip starts and ends. */
  from: number;
  to: number;
}) {
  const shape = useMemo(() => {
    const first = from * (peaks.length - 1),
      last = Math.max(first, to * (peaks.length - 1)),
      // Every measured peak the clip covers, plus the two points where it starts and ends between peaks.
      steps = Math.max(1, Math.min(1200, Math.ceil(last - first)));
    let upper = '',
      lower = '';
    for (let i = 0; i <= steps; i++) {
      const at = first + ((last - first) * i) / steps,
        low = Math.max(0, Math.min(peaks.length - 1, Math.floor(at))),
        high = Math.min(peaks.length - 1, low + 1),
        peak = (peaks[low] || 0) + ((peaks[high] || 0) - (peaks[low] || 0)) * (at - low),
        half = Math.round(Math.max(2, Math.min(1, Math.abs(peak)) * 50) * 10) / 10;
      upper += `${i ? 'L' : 'M'}${i} ${50 - half}`;
      lower = `L${i} ${50 + half}` + lower;
    }
    return { d: upper + lower + 'Z', width: steps };
  }, [peaks, from, to]);
  return (
    <svg className="vs-clip-wave" viewBox={`0 0 ${shape.width} 100`} preserveAspectRatio="none" aria-hidden="true">
      <path d={shape.d} />
    </svg>
  );
});

type DragMode = 'move' | 'trim-left' | 'trim-right';

/** Where a drag left a clip. Shown in place of the project's values until the edit it started has settled. */
interface ClipPlacement {
  readonly mode: DragMode;
  readonly clipId: string;
  readonly trackId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly sourceStartUs: number;
}

interface DragGesture {
  readonly mode: DragMode;
  readonly clip: VideoClipSummary;
  readonly trackId: string;
  readonly element: HTMLElement;
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startScrollLeft: number;
  readonly origStartUs: number;
  readonly origDurationUs: number;
  readonly origSourceStartUs: number;
  /** Times a dragged edge is held by: the playhead and the edges of the other clips on the track. */
  readonly snapUs: readonly number[];
  clientX: number;
  /** False until the pointer has travelled past the threshold; a press that never does is a click. */
  active: boolean;
  startUs: number;
  durationUs: number;
  sourceStartUs: number;
  snappedUs: number | undefined;
  frame: number;
}

interface TimelinePin {
  readonly id: string;
  readonly n: number;
  readonly sec: number;
}

interface TimelineProps {
  project: VideoProjectDetail;
  pps: number;
  totalSec: number;
  fps: number;
  selectedClipId: string;
  placement: ClipPlacement | null;
  editBusy: boolean;
  pins: readonly TimelinePin[];
  selectedPinId: string | undefined;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  rulerRef: React.RefObject<HTMLDivElement | null>;
  playheadTagRef: React.RefObject<HTMLSpanElement | null>;
  /** The clock's current time, read when a gesture starts. */
  timeRef: React.RefObject<number>;
  /** True from the press on a clip to its release: the project is not refreshed under a drag. */
  draggingRef: React.RefObject<boolean>;
  onSelect: (clipId: string) => void;
  onSeek: (timeUs: number) => void;
  onPin: (id: string, sec: number) => void;
  onTrack: (trackId: string, change: { muted?: boolean; solo?: boolean; enabled?: boolean }) => void;
  onDragPreview: (overlay: VideoPlayerDragOverlay | null) => void;
  onDragCommit: (placement: ClipPlacement) => void;
}

/**
 * Ruler, track rows and clips. It renders from the project, the zoom and the selection only: the playhead is moved
 * by the clock through --vs-time on the root, and a drag writes the dragged clip's own custom properties once a
 * frame, so neither re-renders this tree. A drag is committed once, when the pointer is released.
 */
const StudioTimeline = memo(function StudioTimeline(props: TimelineProps) {
  const { project, pps, totalSec, fps, selectedClipId, placement, pins, selectedPinId } = props;
  const { t } = useI18n();
  const gridRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLSpanElement>(null);
  const tagRef = useRef<HTMLSpanElement>(null);
  const hoverRef = useRef<HTMLSpanElement>(null);
  const gesture = useRef<DragGesture | null>(null);
  const scrub = useRef({ active: false, frame: 0, clientX: 0 });
  // The handlers below outlive a render; they read what they need from here.
  const live = useRef(props);
  live.current = props;

  const assets = useMemo(() => new Map(project.assets.map((asset) => [asset.id, asset])), [project.assets]);
  /** One custom property per pictured asset on the grid, so a long data URL is in the DOM once, not once a clip. */
  const posters = useMemo(() => {
    const names = new Map<string, string>(),
      style: Record<string, string> = {};
    for (const track of project.tracks)
      for (const clip of track.clips) {
        if ((clip.kind !== 'video' && clip.kind !== 'image') || !clip.posterDataUrl || !clip.assetId) continue;
        if (names.has(clip.assetId)) continue;
        const name = `--vs-poster-${names.size}`;
        names.set(clip.assetId, name);
        style[name] = cssImage(clip.posterDataUrl);
      }
    return { names, style };
  }, [project.tracks]);

  const tickStep = pps >= 110 ? 1 : pps >= 40 ? 2 : 5;
  const ticks = useMemo(() => {
    const out: number[] = [];
    // Up to, not at, the end: the last label would reach past the lane and give it a scrollbar.
    for (let sec = 0; sec < totalSec; sec += tickStep) out.push(sec);
    return out;
  }, [totalSec, tickStep]);

  /** The time under a pointer, from where the ruler lane is on screen. */
  const timeAt = (clientX: number) => {
    const lane = live.current.rulerRef.current;
    if (!lane) return 0;
    return Math.max(0, Math.round(((clientX - lane.getBoundingClientRect().left) / live.current.pps) * 1_000_000));
  };

  /** Takes the pointer's last position into the gesture — threshold, clamps, snapping — and draws it on the clip. */
  const drawDrag = () => {
    const g = gesture.current;
    if (!g) return;
    g.frame = 0;
    const { pps: scale, scrollRef, fps: rate } = live.current;
    const dx = g.clientX - g.startClientX + ((scrollRef.current?.scrollLeft ?? g.startScrollLeft) - g.startScrollLeft);
    if (!g.active) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      g.active = true;
      g.element.dataset.drag = g.mode;
    }
    const deltaUs = Math.round((dx / scale) * 1_000_000),
      reachUs = (SNAP_PX / scale) * 1_000_000;
    const snap = (edgeUs: number) => {
      let best: number | undefined;
      for (const at of g.snapUs)
        if (Math.abs(at - edgeUs) <= reachUs && (best === undefined || Math.abs(at - edgeUs) < Math.abs(best - edgeUs)))
          best = at;
      return best;
    };
    g.snappedUs = undefined;
    if (g.mode === 'move') {
      let startUs = Math.max(0, g.origStartUs + deltaUs);
      const head = snap(startUs),
        tail = snap(startUs + g.origDurationUs);
      if (
        head !== undefined &&
        (tail === undefined || Math.abs(head - startUs) <= Math.abs(tail - startUs - g.origDurationUs))
      ) {
        startUs = g.snappedUs = head;
      } else if (tail !== undefined && tail >= g.origDurationUs) {
        g.snappedUs = tail;
        startUs = tail - g.origDurationUs;
      }
      g.startUs = startUs;
    } else if (g.mode === 'trim-right') {
      let durationUs = Math.max(MIN_CLIP_US, g.origDurationUs + deltaUs);
      const tail = snap(g.origStartUs + durationUs);
      if (tail !== undefined && tail - g.origStartUs >= MIN_CLIP_US) {
        g.snappedUs = tail;
        durationUs = tail - g.origStartUs;
      }
      g.durationUs = durationUs;
    } else {
      const maxShift = g.origDurationUs - MIN_CLIP_US,
        minShift = Math.max(-g.origStartUs, -g.origSourceStartUs);
      let shift = Math.max(minShift, Math.min(maxShift, deltaUs));
      const head = snap(g.origStartUs + shift);
      if (head !== undefined && head - g.origStartUs >= minShift && head - g.origStartUs <= maxShift) {
        g.snappedUs = head;
        shift = head - g.origStartUs;
      }
      g.startUs = g.origStartUs + shift;
      g.durationUs = g.origDurationUs - shift;
      g.sourceStartUs = g.origSourceStartUs + shift;
    }

    const style = g.element.style;
    if (g.mode === 'move') style.setProperty('--drag-x', `${usToSec(g.startUs - g.origStartUs) * scale}px`);
    else {
      style.setProperty('--s', String(usToSec(g.startUs)));
      style.setProperty('--d', String(usToSec(g.durationUs)));
    }
    const guide = guideRef.current;
    if (guide) {
      if (g.snappedUs === undefined) delete guide.dataset.on;
      else {
        guide.style.setProperty('--snap', String(usToSec(g.snappedUs)));
        guide.dataset.on = '';
      }
    }
    const tag = tagRef.current,
      grid = gridRef.current;
    if (tag && grid) {
      const box = g.element.getBoundingClientRect(),
        base = grid.getBoundingClientRect(),
        x = g.mode === 'move' ? box.left + box.width / 2 : g.mode === 'trim-left' ? box.left : box.right;
      tag.textContent =
        g.mode === 'move'
          ? formatVideoTimecode(usToSec(g.startUs), rate)
          : t('{sec} 秒', { sec: usToSec(g.durationUs).toFixed(1) });
      tag.style.setProperty('--tag-x', `${x - base.left}px`);
      tag.style.setProperty('--tag-y', `${Math.max(0, box.top - base.top - 22)}px`);
      tag.dataset.on = '';
    }
    live.current.onDragPreview({
      timeUs: live.current.timeRef.current,
      clipId: g.clip.id,
      trackId: g.trackId,
      startUs: g.startUs,
      ...(g.mode !== 'move' ? { durationUs: g.durationUs, sourceStartUs: g.sourceStartUs } : {}),
    });
  };

  const pressClip = (event: React.PointerEvent<HTMLElement>, clip: VideoClipSummary, track: VideoTrackSummary) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    live.current.onSelect(clip.id);
    if (track.locked || live.current.editBusy || gesture.current) return;
    const grip = (event.target as HTMLElement).closest('.vs-clip-grip');
    const snapUs = [live.current.timeRef.current];
    for (const other of track.clips)
      if (other.id !== clip.id) snapUs.push(other.startUs, other.startUs + other.durationUs);
    gesture.current = {
      mode: !grip ? 'move' : grip.classList.contains('is-left') ? 'trim-left' : 'trim-right',
      clip,
      trackId: track.id,
      element: event.currentTarget,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startScrollLeft: live.current.scrollRef.current?.scrollLeft ?? 0,
      origStartUs: clip.startUs,
      origDurationUs: clip.durationUs,
      origSourceStartUs: clip.sourceStartUs || 0,
      snapUs,
      clientX: event.clientX,
      active: false,
      startUs: clip.startUs,
      durationUs: clip.durationUs,
      sourceStartUs: clip.sourceStartUs || 0,
      snappedUs: undefined,
      frame: 0,
    };
    live.current.draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const dragClip = (event: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointerId) return;
    g.clientX = event.clientX;
    if (!g.frame) g.frame = requestAnimationFrame(drawDrag);
  };

  /** Release commits what the drag reached; a cancelled pointer puts the clip back. */
  const finishDrag = (event: React.PointerEvent, commit: boolean) => {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointerId) return;
    if (g.frame) cancelAnimationFrame(g.frame);
    if (commit) {
      g.clientX = event.clientX;
      drawDrag();
    }
    gesture.current = null;
    live.current.draggingRef.current = false;
    if (g.element.hasPointerCapture(g.pointerId)) g.element.releasePointerCapture(g.pointerId);
    delete g.element.dataset.drag;
    if (guideRef.current) delete guideRef.current.dataset.on;
    if (tagRef.current) delete tagRef.current.dataset.on;
    if (!g.active) return;
    live.current.onDragPreview(null);
    const style = g.element.style,
      moved = Math.abs(g.startUs - g.origStartUs) > 5_000,
      resized = Math.abs(g.durationUs - g.origDurationUs) > 5_000;
    style.removeProperty('--drag-x');
    if (commit && (g.mode === 'move' ? moved : moved || resized)) {
      // The placement renders in this same event, so the clip stays where it was dropped while the edit runs.
      live.current.onDragCommit({
        mode: g.mode,
        clipId: g.clip.id,
        trackId: g.trackId,
        startUs: g.startUs,
        durationUs: g.durationUs,
        sourceStartUs: g.sourceStartUs,
      });
    } else {
      style.setProperty('--s', String(usToSec(g.origStartUs)));
      style.setProperty('--d', String(usToSec(g.origDurationUs)));
    }
  };

  const scrubNow = () => {
    scrub.current.frame = 0;
    live.current.onSeek(timeAt(scrub.current.clientX));
  };
  const endScrub = (event: React.PointerEvent<HTMLElement>, seek: boolean) => {
    if (!scrub.current.active) return;
    scrub.current.active = false;
    if (scrub.current.frame) cancelAnimationFrame(scrub.current.frame);
    scrub.current.frame = 0;
    if (seek) live.current.onSeek(timeAt(event.clientX));
    delete event.currentTarget.dataset.scrubbing;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  useEffect(
    () => () => {
      if (gesture.current?.frame) cancelAnimationFrame(gesture.current.frame);
      if (scrub.current.frame) cancelAnimationFrame(scrub.current.frame);
      live.current.draggingRef.current = false;
    },
    [],
  );

  return (
    <div className="vs-tracks-scroll" ref={props.scrollRef}>
      <div
        className="vs-tracks-grid"
        ref={gridRef}
        style={{ '--vs-pps': pps, '--vs-total': totalSec, ...posters.style } as CSSProperties}
      >
        <div className="vs-ruler-row">
          <div className="vs-track-head is-ruler">{t('轨道')}</div>
          <div
            className="vs-ruler-lane"
            ref={props.rulerRef}
            onPointerDown={(event) => {
              if (event.button !== 0 || (event.target as HTMLElement).closest('.vs-pin-dot')) return;
              scrub.current.active = true;
              scrub.current.clientX = event.clientX;
              event.currentTarget.dataset.scrubbing = '';
              event.currentTarget.setPointerCapture(event.pointerId);
              scrubNow();
            }}
            onPointerMove={(event) => {
              const hover = hoverRef.current;
              // Over a comment pin the pin's own title speaks; the time bubble steps aside.
              if ((event.target as HTMLElement).closest('.vs-pin-dot')) delete event.currentTarget.dataset.hover;
              else if (hover) {
                hover.textContent = formatVideoTimecode(usToSec(timeAt(event.clientX)), fps);
                hover.style.setProperty(
                  '--hx',
                  `${event.clientX - event.currentTarget.getBoundingClientRect().left}px`,
                );
                event.currentTarget.dataset.hover = '';
              }
              if (!scrub.current.active) return;
              scrub.current.clientX = event.clientX;
              if (!scrub.current.frame) scrub.current.frame = requestAnimationFrame(scrubNow);
            }}
            onPointerUp={(event) => endScrub(event, true)}
            onPointerCancel={(event) => endScrub(event, false)}
            onPointerLeave={(event) => {
              delete event.currentTarget.dataset.hover;
            }}
          >
            {ticks.map((sec) => (
              <span key={sec} className="vs-tick" style={{ '--at': sec } as CSSProperties}>
                <span>{formatPinTimecode(sec).slice(0, -2)}</span>
              </span>
            ))}
            <span className="vs-ruler-hover" ref={hoverRef} aria-hidden="true" />
            <span className="vs-ruler-stem" aria-hidden="true" />
            <span className="vs-playhead-tag" ref={props.playheadTagRef} aria-hidden="true" />
            {pins.map((pin) => (
              <button
                key={pin.id}
                type="button"
                className={`vs-pin-dot is-ruler ${selectedPinId === pin.id ? 'is-active' : ''}`}
                style={{ '--at': pin.sec } as CSSProperties}
                title={`#${pin.n} · ${formatPinTimecode(pin.sec)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onPin(pin.id, pin.sec);
                }}
              >
                {pin.n}
              </button>
            ))}
          </div>
        </div>

        <div className="vs-track-rows">
          {project.tracks.map((track) => {
            const name = trackDisplayName(track, t);
            return (
              <div
                key={track.id}
                className={`vs-track-row ${track.enabled ? '' : 'is-disabled'}`}
                data-kind={trackHue(track)}
              >
                <div className="vs-track-head">
                  <span className="vs-track-icon" aria-hidden="true">
                    <TrackGlyph track={track} />
                  </span>
                  <span className="vs-track-name" title={name}>
                    {name}
                  </span>
                  {track.kind === 'audio' && (
                    <>
                      <button
                        type="button"
                        className="vs-toggle"
                        aria-pressed={Boolean(track.muted)}
                        aria-label={t('静音轨道')}
                        title={t('静音轨道')}
                        onClick={() => props.onTrack(track.id, { muted: !track.muted })}
                      >
                        M
                      </button>
                      <button
                        type="button"
                        className="vs-toggle"
                        aria-pressed={Boolean(track.solo)}
                        aria-label={t('独奏轨道')}
                        title={t('独奏轨道')}
                        onClick={() => props.onTrack(track.id, { solo: !track.solo })}
                      >
                        S
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="vs-toggle"
                    aria-pressed={!track.enabled}
                    aria-label={track.enabled ? t('隐藏轨道') : t('显示轨道')}
                    title={track.enabled ? t('隐藏轨道') : t('显示轨道')}
                    onClick={() => props.onTrack(track.id, { enabled: !track.enabled })}
                  >
                    <Icon name={track.enabled ? 'eye' : 'eyeOff'} size={14} />
                  </button>
                </div>

                <div className="vs-track-lane" onClick={() => props.onSelect('')}>
                  {track.clips.map((clip) => {
                    const placed = placement?.clipId === clip.id ? placement : null,
                      startUs = placed ? placed.startUs : clip.startUs,
                      durationUs = placed ? placed.durationUs : clip.durationUs,
                      label = clipDisplayLabel(clip, project, t),
                      seconds = usToSec(durationUs),
                      asset = clip.assetId ? assets.get(clip.assetId) : undefined,
                      poster = clip.assetId ? posters.names.get(clip.assetId) : undefined,
                      peaks = clip.kind === 'audio' && asset?.durationUs ? asset.waveform : undefined,
                      sourceStartUs = placed ? placed.sourceStartUs : clip.sourceStartUs || 0,
                      sourceDurationUs =
                        (!placed && clip.sourceDurationUs) || Math.round(durationUs * (clip.rate || 1));
                    return (
                      <div
                        key={clip.id}
                        role="button"
                        tabIndex={0}
                        aria-pressed={selectedClipId === clip.id}
                        data-kind={clip.kind}
                        className={`vs-clip${selectedClipId === clip.id ? ' is-selected' : ''}${
                          track.locked ? ' is-locked' : ''
                        }${clip.enabled ? '' : ' is-off'}`}
                        style={
                          {
                            '--s': usToSec(startUs),
                            '--d': seconds,
                            ...(poster ? { '--vs-poster': `var(${poster})` } : {}),
                          } as CSSProperties
                        }
                        title={`${label} · ${t('{sec} 秒', { sec: seconds.toFixed(1) })}`}
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => pressClip(event, clip, track)}
                        onPointerMove={dragClip}
                        onPointerUp={(event) => finishDrag(event, true)}
                        onPointerCancel={(event) => finishDrag(event, false)}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          event.stopPropagation();
                          props.onSelect(clip.id);
                        }}
                      >
                        {poster && <span className="vs-clip-film" />}
                        {peaks?.length ? (
                          <ClipWave
                            peaks={peaks}
                            from={Math.min(1, sourceStartUs / asset!.durationUs!)}
                            to={Math.min(1, (sourceStartUs + sourceDurationUs) / asset!.durationUs!)}
                          />
                        ) : null}
                        <span
                          className={`vs-clip-label${poster ? ' is-tag vc-glass' : peaks?.length ? ' is-tag' : ''}`}
                        >
                          {label}
                        </span>
                        <span className="vs-clip-grip is-left" />
                        <span className="vs-clip-grip is-right" />
                      </div>
                    );
                  })}
                  {track.clips.map(
                    (clip) =>
                      clip.transitionIn && (
                        <span
                          key={clip.id}
                          className="vs-cut"
                          style={
                            {
                              '--s': usToSec(placement?.clipId === clip.id ? placement.startUs : clip.startUs),
                            } as CSSProperties
                          }
                        >
                          <Glyph name="blend" size={12} />
                        </span>
                      ),
                  )}
                </div>
              </div>
            );
          })}
          <div className="vs-lane-overlay" aria-hidden="true">
            <span className="vs-playhead-line" />
            <span className="vs-snap-guide" ref={guideRef} />
          </div>
        </div>
        <span className="vs-drag-tag" ref={tagRef} aria-hidden="true" />
      </div>
    </div>
  );
});

type ApplyEdit = (operations: VideoEditOperation[], historyLabel?: string) => Promise<void>;

function Field({ label, value, children }: { label: string; value?: string; children: React.ReactNode }) {
  return (
    <label className="vs-field">
      <span className="vs-label">
        {label}
        {value !== undefined && <em>{value}</em>}
      </span>
      {children}
    </label>
  );
}

function ClipKindIcon({ kind }: { kind: VideoClipSummary['kind'] }) {
  if (kind === 'image') return <Glyph name="image" size={16} />;
  if (kind === 'text') return <Glyph name="text" size={16} />;
  return (
    <Icon
      name={kind === 'video' ? 'film' : kind === 'caption' ? 'captions' : kind === 'audio' ? 'waveform' : 'layers'}
      size={16}
    />
  );
}

/**
 * The selected clip's properties. Mounted once per clip (keyed by its id), so the typed-but-unsent text, size,
 * colour and gain are its own; whatever is still unsent when the selection moves on is committed as it unmounts.
 */
function ClipInspector({
  project,
  clip,
  prevClip,
  applyEdit,
  removedRef,
}: {
  project: VideoProjectDetail;
  clip: VideoClipSummary;
  prevClip: VideoClipSummary | undefined;
  applyEdit: ApplyEdit;
  /** Clips whose deletion is already queued: nothing more is sent for them. */
  removedRef: React.RefObject<Set<string>>;
}) {
  const { t } = useI18n();
  const clipId = clip.id,
    textual = clip.kind === 'text' || clip.kind === 'caption',
    visual = clip.kind === 'video' || clip.kind === 'image',
    audible = clip.kind === 'audio' || clip.kind === 'video';
  const values = () => ({
    text: clip.text || '',
    fontSize: clip.textStyle?.fontSizePx ?? 48,
    color: clip.textStyle?.fill || '#ffffff',
    gainDb: clip.gainDb ?? 0,
  });
  const [text, setText] = useState(() => values().text);
  const [fontSize, setFontSize] = useState(() => String(values().fontSize));
  const [color, setColor] = useState(() => values().color);
  const [gainDb, setGainDb] = useState(() => values().gainDb);
  const committed = useRef(values());
  const draft = useRef({ text, fontSize, color, gainDb });
  draft.current = { text, fontSize, color, gainDb };
  const colorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The project changed under the inspector (an undo, a Bot's edit): show what it holds now.
  useEffect(() => {
    const next = values();
    committed.current = next;
    setText(next.text);
    setFontSize(String(next.fontSize));
    setColor(next.color);
    setGainDb(next.gainDb);
  }, [clip.text, clip.textStyle?.fontSizePx, clip.textStyle?.fill, clip.gainDb]);

  /** Sends whichever drafts differ from what the project last confirmed. */
  const commitDrafts = (override?: Partial<typeof draft.current>) => {
    const next = { ...draft.current, ...override },
      last = committed.current,
      operations: VideoEditOperation[] = [];
    const size = Math.max(14, Math.min(200, Math.round(Number(next.fontSize)) || 48));
    if (textual) {
      if (next.text !== last.text) operations.push({ op: 'update_text', clipId, text: next.text });
      if (size !== last.fontSize) operations.push({ op: 'update_text', clipId, style: { fontSizePx: size } });
      if (next.color !== last.color) operations.push({ op: 'update_text', clipId, style: { fill: next.color } });
    }
    if (audible && next.gainDb !== last.gainDb)
      operations.push({ op: 'set_clip_style', clipId, style: {}, gainDb: next.gainDb });
    committed.current = { text: next.text, fontSize: size, color: next.color, gainDb: next.gainDb };
    if (operations.length) void applyEdit(operations);
    return size;
  };
  const commitRef = useRef(commitDrafts);
  commitRef.current = commitDrafts;
  useEffect(
    () => () => {
      if (colorTimer.current) clearTimeout(colorTimer.current);
      if (!removedRef.current.has(clipId)) commitRef.current();
    },
    [],
  );

  const activeEffect = clip.effects?.find((effect) => effect.enabled !== false);
  const chooseEffect = (preset: VideoEffectPreset | '') => {
    const operations: VideoEditOperation[] = [];
    if (activeEffect && activeEffect.preset !== preset)
      operations.push({ op: 'set_effect', clipId, preset: activeEffect.preset, remove: true });
    if (preset && activeEffect?.preset !== preset)
      operations.push({ op: 'set_effect', clipId, preset, intensity: 0.7, enabled: true });
    if (operations.length) void applyEdit(operations);
  };
  const setStyle = (change: { fit?: VideoClipFit; rate?: number; fadeInUs?: number; fadeOutUs?: number }) => {
    const { fit, ...rest } = change;
    void applyEdit([{ op: 'set_clip_style', clipId, style: fit ? { fit } : {}, ...rest }]);
  };
  const fadeSeconds = (us: number | undefined) => Math.round((us || 0) / 100_000) / 10;
  const fadeOptions = (current: number) =>
    (FADES.includes(current as (typeof FADES)[number]) ? FADES : [...FADES, current].sort((a, b) => a - b)).map(
      (seconds) => (
        <option key={seconds} value={seconds}>
          {seconds ? t('{sec} 秒', { sec: seconds }) : t('无')}
        </option>
      ),
    );
  const fadeIn = fadeSeconds(clip.fadeInUs),
    fadeOut = fadeSeconds(clip.fadeOutUs),
    rate = clip.rate ?? 1;

  return (
    <div
      className="vs-inspector-body"
      data-kind={clip.kind}
      style={
        clip.posterDataUrl && visual ? ({ '--vs-poster': cssImage(clip.posterDataUrl) } as CSSProperties) : undefined
      }
    >
      <div className="vs-inspector-head">
        <span className="vs-thumb" aria-hidden="true">
          {!(clip.posterDataUrl && visual) && <ClipKindIcon kind={clip.kind} />}
        </span>
        <div>
          <strong title={clipDisplayLabel(clip, project, t)}>{clipDisplayLabel(clip, project, t)}</strong>
          <small>
            {formatPinTimecode(usToSec(clip.startUs))} · {t('{sec} 秒', { sec: usToSec(clip.durationUs).toFixed(1) })}
          </small>
        </div>
      </div>

      {textual && (
        <>
          <Field label={t('文字内容')}>
            <input
              type="text"
              className="vs-input"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onBlur={() => commitDrafts()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
              }}
            />
          </Field>
          <div className="vs-two">
            <Field label={t('字号')}>
              <input
                type="number"
                className="vs-input"
                min={14}
                max={200}
                value={fontSize}
                onChange={(event) => setFontSize(event.target.value)}
                onBlur={() => setFontSize(String(commitDrafts()))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
            </Field>
            <Field label={t('颜色')}>
              <span className="vs-color">
                <input
                  type="color"
                  value={color}
                  onChange={(event) => {
                    const next = event.target.value;
                    setColor(next);
                    if (colorTimer.current) clearTimeout(colorTimer.current);
                    colorTimer.current = setTimeout(() => {
                      colorTimer.current = undefined;
                      commitRef.current({ color: next });
                    }, 200);
                  }}
                  onBlur={() => {
                    if (colorTimer.current) clearTimeout(colorTimer.current);
                    colorTimer.current = undefined;
                    commitDrafts();
                  }}
                />
                {color}
              </span>
            </Field>
          </div>
        </>
      )}

      {visual && (
        <>
          <div className="vs-two">
            <Field label={t('画面填充')}>
              <Select
                value={clip.style?.fit || 'contain'}
                onChange={(event) => setStyle({ fit: event.target.value as VideoClipFit })}
              >
                {FIT_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {t(mode.label)}
                  </option>
                ))}
              </Select>
            </Field>
            {prevClip && (
              <Field label={t('转场')}>
                <Select
                  value={clip.transitionIn?.preset || ''}
                  onChange={(event) =>
                    void applyEdit([
                      {
                        op: 'set_transition',
                        fromClipId: prevClip.id,
                        toClipId: clipId,
                        preset: (event.target.value as VideoTransitionPreset | '') || null,
                        durationUs: 500_000,
                      },
                    ])
                  }
                >
                  {TRANSITION_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {t(preset.label)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <div>
            <span className="vs-label">{t('画面效果')}</span>
            <div className="vs-fx" role="group" aria-label={t('画面效果')}>
              {EFFECT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={(activeEffect?.preset || '') === preset.id}
                  title={t(preset.label)}
                  onClick={() => chooseEffect(preset.id)}
                >
                  <b>
                    <i style={{ '--fx': preset.look } as CSSProperties} />
                  </b>
                  <span>{t(preset.label)}</span>
                </button>
              ))}
            </div>
          </div>
          {clip.kind === 'video' && (
            <div>
              <span className="vs-label">{t('变速')}</span>
              <div className="vc-seg is-sm" role="group" aria-label={t('变速')}>
                {RATES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={rate === value}
                    onClick={() => setStyle({ rate: value })}
                  >
                    {value}x
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {audible && (
        <>
          <Field label={t('音量')} value={`${Math.round(gainDb)} dB`}>
            <VideoRange
              value={gainDb}
              min={-24}
              max={12}
              step={1}
              aria-label={t('音量')}
              onChange={setGainDb}
              onCommit={(value) => commitDrafts({ gainDb: value })}
            />
          </Field>
          <div className="vs-two">
            <Field label={t('淡入')}>
              <Select
                value={fadeIn}
                onChange={(event) => setStyle({ fadeInUs: Math.round(Number(event.target.value) * 1_000_000) })}
              >
                {fadeOptions(fadeIn)}
              </Select>
            </Field>
            <Field label={t('淡出')}>
              <Select
                value={fadeOut}
                onChange={(event) => setStyle({ fadeOutUs: Math.round(Number(event.target.value) * 1_000_000) })}
              >
                {fadeOptions(fadeOut)}
              </Select>
            </Field>
          </div>
        </>
      )}
    </div>
  );
}

/** The export card under the 导出 button. The workbench owns when it is open; it takes focus as it appears. */
function ExportPopover({
  format,
  quality,
  attach,
  onFormat,
  onQuality,
  onAttach,
  onCancel,
  onStart,
}: {
  format: VideoExportFormat;
  quality: VideoExportQuality;
  attach: boolean;
  onFormat: (format: VideoExportFormat) => void;
  onQuality: (quality: VideoExportQuality) => void;
  onAttach: (attach: boolean) => void;
  onCancel: () => void;
  onStart: () => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus({ preventScroll: true }), []);
  const hint = EXPORT_FORMATS.find((item) => item.id === format)?.hint || '';
  return (
    <div className="vs-export-popover" role="dialog" aria-label={t('导出视频')} tabIndex={-1} ref={root}>
      <h3>{t('导出视频')}</h3>
      <div>
        <span className="vs-label">{t('格式')}</span>
        <div className="vc-seg is-sm" role="group" aria-label={t('格式')}>
          {EXPORT_FORMATS.map((item) => (
            <button key={item.id} type="button" aria-pressed={format === item.id} onClick={() => onFormat(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <p className="vs-export-hint">{t(hint)}</p>
      </div>
      {(format === 'mp4' || format === 'webm' || format === 'gif') && (
        <div>
          <span className="vs-label">{t('画质')}</span>
          <div className="vc-seg is-sm" role="group" aria-label={t('画质')}>
            {EXPORT_QUALITIES.map((item) => (
              <button key={item.id} type="button" aria-pressed={quality === item.id} onClick={() => onQuality(item.id)}>
                {t(item.label)}
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="vs-export-check">
        <input type="checkbox" checked={attach} onChange={(event) => onAttach(event.target.checked)} />
        <span>{t('导出完成后作为附件发送')}</span>
      </label>
      <div className="vs-export-footer">
        <button type="button" className="vc-btn" onClick={onCancel}>
          {t('取消')}
        </button>
        <button type="button" className="vc-btn is-ink" onClick={onStart}>
          {t('开始导出')}
        </button>
      </div>
    </div>
  );
}

/**
 * The slim scrubber of the preview and annotate modes, with the numbered comment pins. Its fill and knob follow the
 * clock through --vs-time; `currentSec` is only the value announced to assistive technology.
 */
function MiniScrubber({
  durationSec,
  currentSec,
  pins,
  selectedPinId,
  onSeek,
  onStep,
  onPin,
}: {
  durationSec: number;
  currentSec: number;
  pins: readonly TimelinePin[];
  selectedPinId: string | undefined;
  onSeek: (timeUs: number) => void;
  onStep: (frames: number) => void;
  onPin: (id: string, sec: number) => void;
}) {
  const { t } = useI18n();
  const scrub = useRef({ active: false, frame: 0, clientX: 0 });
  const seek = useRef(onSeek);
  seek.current = onSeek;
  const seekAt = (element: HTMLElement, clientX: number) => {
    const box = element.getBoundingClientRect();
    seek.current(Math.max(0, Math.min(1, (clientX - box.left) / Math.max(1, box.width))) * durationSec * 1_000_000);
  };
  const end = (event: React.PointerEvent<HTMLElement>, commit: boolean) => {
    if (!scrub.current.active) return;
    scrub.current.active = false;
    cancelAnimationFrame(scrub.current.frame);
    scrub.current.frame = 0;
    if (commit) seekAt(event.currentTarget, event.clientX);
    delete event.currentTarget.dataset.scrubbing;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  useEffect(() => () => cancelAnimationFrame(scrub.current.frame), []);
  return (
    <div
      className="vs-mini-scrubber"
      role="slider"
      tabIndex={0}
      aria-label={t('视频播放进度')}
      aria-valuemin={0}
      aria-valuemax={Math.round(durationSec * 10) / 10}
      aria-valuenow={Math.round(currentSec * 10) / 10}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest('.vs-pin-dot')) return;
        scrub.current.active = true;
        event.currentTarget.dataset.scrubbing = '';
        event.currentTarget.setPointerCapture(event.pointerId);
        seekAt(event.currentTarget, event.clientX);
      }}
      onPointerMove={(event) => {
        if (!scrub.current.active) return;
        scrub.current.clientX = event.clientX;
        const element = event.currentTarget;
        if (!scrub.current.frame)
          scrub.current.frame = requestAnimationFrame(() => {
            scrub.current.frame = 0;
            seekAt(element, scrub.current.clientX);
          });
      }}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        onStep(event.key === 'ArrowLeft' ? -1 : 1);
      }}
    >
      <span className="vs-mini-track">
        <span className="vs-mini-fill" />
      </span>
      <span className="vs-mini-rail">
        <span className="vs-mini-knob" />
      </span>
      {pins.map((pin) => (
        <button
          key={pin.id}
          type="button"
          className={`vs-pin-dot ${selectedPinId === pin.id ? 'is-active' : ''}`}
          style={{ left: `${Math.min(100, Math.max(0, (pin.sec / durationSec) * 100))}%` }}
          title={`#${pin.n} · ${formatPinTimecode(pin.sec)}`}
          onClick={(event) => {
            event.stopPropagation();
            onPin(pin.id, pin.sec);
          }}
        >
          {pin.n}
        </button>
      ))}
    </div>
  );
}

export function VideoStudioWorkbench({ projectId, name }: { projectId: string; name: string }) {
  const { t } = useI18n();
  const runtime = usePreviewRuntime();
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const timecodeRef = useRef<HTMLSpanElement>(null);
  const playheadTagRef = useRef<HTMLSpanElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const exportWrapRef = useRef<HTMLDivElement>(null);

  const [project, setProject] = useState<VideoProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<StudioTab>('timeline');

  const [playing, setPlaying] = useState(false);
  // A coarse copy of the clock for what React decides from it (can the clip be split here, which static frame to
  // fetch). The playhead, the timecodes and the scrubber follow the clock itself, frame by frame.
  const [currentTimeUs, setCurrentTimeUs] = useState(0);
  const [rate, setRate] = useState<number>(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  const [playerReady, setPlayerReady] = useState(false);
  const [fallbackMode, setFallbackMode] = useState(false);
  const [fallbackImage, setFallbackImage] = useState('');
  const [iframeKey, setIframeKey] = useState(0);

  const [selectedClipId, setSelectedClipId] = useState<string>('');
  const [pxPerSec, setPxPerSec] = useState(72);
  const [editBusy, setEditBusy] = useState(false);
  const [placement, setPlacement] = useState<ClipPlacement | null>(null);
  const [syncNotice, setSyncNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [statusError, setStatusError] = useState('');

  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<VideoExportFormat>('mp4');
  const [exportQuality, setExportQuality] = useState<VideoExportQuality>('standard');
  const [exportAttach, setExportAttach] = useState(true);
  const [exportJob, setExportJob] = useState<VideoExportJob | null>(null);

  const draggingRef = useRef(false);
  const removedClipsRef = useRef(new Set<string>());
  const dragEmitAt = useRef(0);
  const currentTimeRef = useRef(0);
  const projectRef = useRef<VideoProjectDetail | null>(null);
  projectRef.current = project;
  const editQueueRef = useRef<Promise<void>>(Promise.resolve());
  const inFlightEditsRef = useRef(0);
  const editEpochRef = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingCaptures = useRef(new Map<string, (dataUrl: string | undefined) => void>());

  const durationUs = project?.durationUs || 0;
  const durationSec = durationUs / 1_000_000;
  const fps = project?.fps && project.fps > 0 ? project.fps : 30;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const ppsRef = useRef(pxPerSec);

  // The clock. The player reports its time about thirty times a second; between reports the playhead runs on from
  // the last one at the playback rate, once a frame, and each report nudges it back in line instead of jumping.
  const clock = useRef({
    playing: false,
    baseUs: 0,
    baseAt: 0,
    heardAt: 0,
    soughtAt: 0,
    rate: 1,
    durationUs: 0,
    frame: 0,
    sync: 0,
  });
  clock.current.rate = rate;
  clock.current.durationUs = durationUs;

  /** Writes a time to everything that shows it, without a render. */
  const paintTime = useCallback((timeUs: number) => {
    currentTimeRef.current = timeUs;
    const sec = timeUs / 1_000_000,
      code = formatVideoTimecode(sec, fpsRef.current);
    rootRef.current?.style.setProperty('--vs-time', sec.toFixed(4));
    for (const label of [timecodeRef.current, playheadTagRef.current])
      if (label && label.textContent !== code) label.textContent = code;
    // The annotation layer reads the picture's time from here and re-measures on every change, so while playing
    // it is told about thirty times a second, as the player's own reports used to.
    const surface = surfaceRef.current;
    if (surface && !(clock.current.playing && Math.abs(sec - Number(surface.dataset.videoTime)) < 0.03))
      surface.dataset.videoTime = sec.toFixed(3);
  }, []);

  /** Keeps the playing playhead in view: the timeline pages on when it runs off either side. */
  const followPlayhead = useCallback(() => {
    const scroll = timelineScrollRef.current,
      lane = rulerRef.current;
    if (!scroll || !lane || !clock.current.playing || draggingRef.current) return;
    const x = (currentTimeRef.current / 1_000_000) * ppsRef.current,
      left = scroll.scrollLeft,
      width = scroll.clientWidth - lane.offsetLeft;
    if (x >= left && x <= left + width - 24) return;
    scroll.scrollTo({
      left: Math.max(0, x - 48),
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, []);

  /** Hands the clock's time to React a few times a second at most. */
  const syncTime = useCallback(() => {
    const c = clock.current;
    if (c.sync) return;
    c.sync = window.setTimeout(() => {
      c.sync = 0;
      setCurrentTimeUs(currentTimeRef.current);
      followPlayhead();
    }, 120);
  }, [followPlayhead]);

  const predictUs = () => {
    const c = clock.current;
    // A player that has gone quiet is stalled: hold a quarter of a second after its last report.
    const at = Math.min(performance.now(), c.heardAt + 250);
    return Math.max(0, Math.min(c.durationUs || Number.MAX_SAFE_INTEGER, c.baseUs + (at - c.baseAt) * 1000 * c.rate));
  };

  const runClock = useCallback(() => {
    const c = clock.current;
    c.frame = 0;
    if (!c.playing) return;
    paintTime(predictUs());
    syncTime();
    c.frame = requestAnimationFrame(runClock);
  }, [paintTime, syncTime]);

  /** A time from the player, or a seek of ours: `playing` says whether the clock should run on from it. */
  const setClock = useCallback(
    (timeUs: number, playing: boolean) => {
      const c = clock.current,
        now = performance.now();
      if (playing && c.playing) {
        const predicted = predictUs(),
          error = timeUs - predicted;
        c.baseUs = Math.abs(error) > 120_000 ? timeUs : predicted + error * 0.15;
      } else c.baseUs = timeUs;
      c.baseAt = c.heardAt = now;
      c.playing = playing;
      if (playing) {
        if (!c.frame) c.frame = requestAnimationFrame(runClock);
        return;
      }
      if (c.frame) cancelAnimationFrame(c.frame);
      c.frame = 0;
      paintTime(timeUs);
      syncTime();
    },
    [paintTime, runClock, syncTime],
  );

  useEffect(
    () => () => {
      const c = clock.current;
      if (c.frame) cancelAnimationFrame(c.frame);
      if (c.sync) clearTimeout(c.sync);
      c.frame = c.sync = 0;
      c.playing = false;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const selectedClipInfo = (() => {
    if (!project || !selectedClipId) return null;
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (!clip) continue;
      const sorted = [...track.clips].sort((a, b) => a.startUs - b.startUs);
      const pos = sorted.indexOf(clip);
      return { track, clip, prevClip: pos > 0 ? sorted[pos - 1] : undefined };
    }
    return null;
  })();

  const timecodedPins = useMemo<TimelinePin[]>(
    () =>
      (runtime?.annotations || []).flatMap((mark, index) =>
        mark.timestampSec === undefined ? [] : [{ id: mark.id, n: pinNumber(mark, index), sec: mark.timestampSec }],
      ),
    [runtime?.annotations],
  );

  const postToPlayer = useCallback((command: VideoPlayerHostCommand) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(command, PLAYER_ORIGIN);
  }, []);

  /** A passing notice in the toast stack; it leaves by itself unless `stay` is set. */
  const showNotice = useCallback((text: string, tone: 'ok' | 'error', stay = false) => {
    setSyncNotice({ text, tone });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = stay ? undefined : setTimeout(() => setSyncNotice(null), 2600);
  }, []);

  // Load initial project details via IPC.
  const fetchProject = useCallback(async () => {
    if (!window.aelion?.videoProjectGet) {
      setLoadError(t('当前环境暂不支持视频工作室'));
      setLoading(false);
      return;
    }
    try {
      const detail = await window.aelion.videoProjectGet(projectId);
      setProject(detail);
      setLoadError('');
      const latestExport = detail.recentExports?.find((j) => j.status === 'running' || j.status === 'queued');
      if (latestExport) setExportJob(latestExport);
    } catch (err) {
      setLoadError(previewErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    setLoading(true);
    setProject(null);
    setPlayerReady(false);
    setFallbackMode(false);
    setSelectedClipId('');
    setPlacement(null);
    void fetchProject();
  }, [fetchProject]);

  // Bot-Human sync: poll for revision updates when Bot tools mutate the project.
  useEffect(() => {
    if (!projectId || !window.aelion?.videoProjectGet) return;
    let active = true;
    const idle = () => active && inFlightEditsRef.current === 0 && !draggingRef.current;
    const poll = async () => {
      if (!idle()) return;
      const startEpoch = editEpochRef.current;
      try {
        const latest = await window.aelion.videoProjectGet(projectId);
        if (!idle() || editEpochRef.current !== startEpoch) return;
        const current = projectRef.current;
        if (current && isNewerRevision(latest.revision, current.revision)) {
          projectRef.current = latest;
          setProject(latest);
          postToPlayer({ source: 'aelion-video-host', type: 'load', projectId, revision: latest.revision });
          showNotice(t('已同步最新修改'), 'ok');
        }
      } catch {}
    };
    const interval = setInterval(() => void poll(), 2500);
    const onFocus = () => void poll();
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [projectId, postToPlayer, showNotice, t]);

  // Listen to player iframe events.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== PLAYER_ORIGIN) return;
      const data = event.data as VideoPlayerFrameEvent | null | undefined;
      if (!data || typeof data !== 'object' || data.source !== 'aelion-video-player') return;
      if (data.type === 'ready') {
        setPlayerReady(true);
        setFallbackMode(false);
      } else if (data.type === 'timeupdate' || data.type === 'statechange') {
        // A report already on its way when we sought still carries the time from before the seek. For a moment
        // after one, only whether the player is playing is taken from it, so a scrub or a frame step never
        // flickers back to where it came from.
        const c = clock.current,
          stale = performance.now() - c.soughtAt < 200;
        setClock(!stale ? data.timeUs : c.playing ? predictUs() : currentTimeRef.current, data.playing);
        setPlaying(data.playing);
      } else if (data.type === 'frameCaptured') {
        const resolve = pendingCaptures.current.get(data.requestId);
        if (resolve) {
          pendingCaptures.current.delete(data.requestId);
          resolve(data.dataUrl);
        }
      } else if (data.type === 'error') {
        setClock(currentTimeRef.current, false);
        setPlaying(false);
        setFallbackMode(true);
        setStatusError(data.message);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [setClock]);

  // Graceful fallback to static server-rendered frames if iframe fails to become ready.
  useEffect(() => {
    if (playerReady || fallbackMode || !project) return;
    const timer = setTimeout(() => {
      if (!playerReady) setFallbackMode(true);
    }, 4500);
    return () => clearTimeout(timer);
  }, [playerReady, fallbackMode, project, iframeKey]);

  // One static frame is rendered at a time; while it is, only the latest time asked for is kept, so scrubbing in
  // fallback mode asks for the frame under the pointer rather than for every one it passed.
  const fallbackFrames = useRef<{ busy: boolean; next: number | undefined }>({ busy: false, next: undefined });
  const fetchFallbackFrame = useCallback(
    async (timeUs: number) => {
      if (!window.aelion?.videoProjectFrame) return;
      const queue = fallbackFrames.current;
      if (queue.busy) {
        queue.next = timeUs;
        return;
      }
      queue.busy = true;
      try {
        const result = await window.aelion.videoProjectFrame({
          projectId,
          timestampsUs: [Math.max(0, Math.round(timeUs))],
          maxWidth: 960,
        });
        const frame = result.frames[0];
        if (frame?.dataUrl) setFallbackImage(frame.dataUrl);
      } catch {}
      queue.busy = false;
      if (queue.next !== undefined) {
        const next = queue.next;
        queue.next = undefined;
        void fetchFallbackFrame(next);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (!fallbackMode || !project) return;
    void fetchFallbackFrame(currentTimeRef.current);
  }, [fallbackMode, project?.revision, fetchFallbackFrame]);

  const pausePlayer = useCallback(() => {
    setClock(currentTimeRef.current, false);
    setPlaying(false);
    postToPlayer({ source: 'aelion-video-host', type: 'pause' });
  }, [postToPlayer, setClock]);

  const seekUs = useCallback(
    (timeUs: number) => {
      const clamped = Math.max(0, durationUs > 0 ? Math.min(Math.round(timeUs), Math.max(0, durationUs - 1)) : 0);
      const c = clock.current;
      // A seek while playing keeps playing from the new time; the next report confirms it.
      c.baseUs = clamped;
      c.baseAt = c.heardAt = c.soughtAt = performance.now();
      paintTime(clamped);
      syncTime();
      if (fallbackMode) void fetchFallbackFrame(clamped);
      else postToPlayer({ source: 'aelion-video-host', type: 'seek', timeUs: clamped });
    },
    [durationUs, fallbackMode, fetchFallbackFrame, paintTime, postToPlayer, syncTime],
  );

  // Keep studio mode tab in sync with FilePreview's annotate mode.
  useEffect(() => {
    if (runtime?.mode === 'annotate') {
      pausePlayer();
      setTab('annotate');
    } else if (tab === 'annotate') {
      setTab('preview');
    }
  }, [runtime?.mode]);

  const chooseTab = (next: StudioTab) => {
    setTab(next);
    if (next === 'annotate') {
      pausePlayer();
      runtime?.setMode('annotate');
    } else if (runtime?.mode === 'annotate') {
      runtime.setMode('browse');
    }
  };

  const togglePlay = useCallback(() => {
    if (fallbackMode) return;
    if (playing) {
      pausePlayer();
    } else {
      setPlaying(true);
      postToPlayer({ source: 'aelion-video-host', type: 'play' });
    }
  }, [fallbackMode, playing, pausePlayer, postToPlayer]);

  const stepFrame = useCallback(
    (deltaFrames: number) => {
      pausePlayer();
      seekUs(currentTimeRef.current + Math.round((deltaFrames / fps) * 1_000_000));
    },
    [pausePlayer, seekUs, fps],
  );

  const captureFrame = useCallback(async (): Promise<string | undefined> => {
    if (!fallbackMode && playerReady && iframeRef.current?.contentWindow) {
      const requestId = crypto.randomUUID();
      const dataUrl = await new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          pendingCaptures.current.delete(requestId);
          resolve(undefined);
        }, 2500);
        pendingCaptures.current.set(requestId, (url) => {
          clearTimeout(timer);
          resolve(url);
        });
        postToPlayer({ source: 'aelion-video-host', type: 'captureFrame', requestId });
      });
      if (dataUrl) return dataUrl;
    }
    if (window.aelion?.videoProjectFrame) {
      try {
        const result = await window.aelion.videoProjectFrame({
          projectId,
          timestampsUs: [Math.max(0, Math.round(currentTimeRef.current))],
          maxWidth: 1280,
        });
        return result.frames[0]?.dataUrl;
      } catch {
        return undefined;
      }
    }
    return fallbackImage || undefined;
  }, [fallbackMode, playerReady, postToPlayer, projectId, fallbackImage]);

  // Register video controls with PreviewRuntimeContext for FileAnnotationLayer timecoded pins.
  useEffect(() => {
    const setVideo = runtime?.setVideo;
    if (!setVideo) return;
    setVideo({
      getCurrentTimeSec: () => currentTimeRef.current / 1_000_000,
      seekTo: (sec) => seekUs(sec * 1_000_000),
      pause: pausePlayer,
      captureFrame,
    });
    return () => setVideo(undefined);
  }, [runtime?.setVideo, seekUs, pausePlayer, captureFrame]);

  // Sync rate & volume with player iframe.
  useEffect(() => {
    if (playerReady) postToPlayer({ source: 'aelion-video-host', type: 'setRate', rate });
  }, [playerReady, rate, postToPlayer]);

  useEffect(() => {
    if (playerReady) postToPlayer({ source: 'aelion-video-host', type: 'setVolume', volume, muted });
  }, [playerReady, volume, muted, postToPlayer]);

  // Apply edit operations serially via IPC (always reading latest revision) and reload player iframe on new revision.
  const applyEdit = useCallback<ApplyEdit>(
    (operations, historyLabel) => {
      const targetProjectId = projectRef.current?.id;
      if (!targetProjectId || !window.aelion?.videoProjectEdit) return Promise.resolve();
      editEpochRef.current += 1;
      inFlightEditsRef.current += 1;
      setEditBusy(true);
      const run = editQueueRef.current.then(async () => {
        try {
          const current = projectRef.current;
          if (!current || current.id !== targetProjectId) return;
          setStatusError('');
          const result = await window.aelion.videoProjectEdit({
            projectId: current.id,
            expectedRevision: current.revision,
            operations,
            ...(historyLabel ? { historyLabel } : {}),
          });
          if (projectRef.current?.id !== targetProjectId) return;
          projectRef.current = result.project;
          setProject(result.project);
          postToPlayer({
            source: 'aelion-video-host',
            type: 'load',
            projectId: result.project.id,
            revision: result.revision,
          });
          if (result.warnings?.length) showNotice(result.warnings[0]!, 'error', true);
        } catch (err) {
          if (projectRef.current?.id === targetProjectId) {
            setStatusError(previewErrorText(err));
          }
        } finally {
          inFlightEditsRef.current = Math.max(0, inFlightEditsRef.current - 1);
          setEditBusy(inFlightEditsRef.current > 0);
        }
      });
      editQueueRef.current = run.catch(() => {});
      return run;
    },
    [postToPlayer, showNotice],
  );

  // Timeline quick actions.
  const splittableAt = (timeUs: number) =>
    Boolean(
      selectedClipInfo &&
      timeUs > selectedClipInfo.clip.startUs + 100_000 &&
      timeUs < selectedClipInfo.clip.startUs + selectedClipInfo.clip.durationUs - 100_000,
    );
  const canSplit = splittableAt(currentTimeUs);

  const handleSplit = () => {
    // The button follows the clock's coarse copy; the cut itself is made at the exact time.
    const atUs = Math.round(currentTimeRef.current);
    if (!selectedClipInfo || !splittableAt(atUs)) return;
    void applyEdit([{ op: 'split_clip', clipId: selectedClipInfo.clip.id, atUs }], t('分割片段'));
  };

  const handleDeleteClip = (ripple: boolean) => {
    if (!selectedClipInfo) return;
    const id = selectedClipInfo.clip.id;
    removedClipsRef.current.add(id);
    setSelectedClipId('');
    void applyEdit([{ op: 'delete_clip', clipId: id, ripple }], ripple ? t('波纹删除') : t('删除片段'));
  };

  const handleAddText = (role: 'text' | 'caption') => {
    if (!project) return;
    const w = project.width || 1920;
    const h = project.height || 1080;
    const box =
      role === 'caption'
        ? {
            x: Math.round(w * 0.08),
            y: Math.round(h * 0.78),
            width: Math.round(w * 0.84),
            height: Math.round(h * 0.14),
          }
        : {
            x: Math.round(w * 0.12),
            y: Math.round(h * 0.12),
            width: Math.round(w * 0.76),
            height: Math.round(h * 0.18),
          };
    void applyEdit(
      [
        {
          op: 'add_text',
          role,
          text: role === 'caption' ? t('在此输入字幕内容') : t('标题文字'),
          startUs: Math.round(currentTimeRef.current),
          durationUs: 3_000_000,
          box,
          style: {
            fontSizePx: role === 'caption' ? Math.round(h * 0.044) : Math.round(h * 0.065),
            fill: '#ffffff',
            align: 'center',
            ...(role === 'caption'
              ? { backgroundFill: '#000000', backgroundOpacity: 0.55, backgroundPaddingPx: 12, backgroundRadiusPx: 8 }
              : {}),
          },
        },
      ],
      role === 'caption' ? t('添加字幕') : t('添加文字'),
    );
  };

  const handleAutoDuck = () => {
    if (!project) return;
    const audioTracks = project.tracks.filter((tr) => tr.kind === 'audio');
    if (audioTracks.length < 2) {
      setStatusError(t('需要至少两条音频轨道才能自动压低背景音'));
      return;
    }
    const bgmTrack =
      audioTracks.find((tr) => /bgm|music|背景|配乐/i.test(tr.name)) || audioTracks[audioTracks.length - 1]!;
    const sidechain = audioTracks.filter((tr) => tr.id !== bgmTrack.id).map((tr) => tr.id);
    void applyEdit(
      [
        {
          op: 'auto_duck',
          programTrackIds: [bgmTrack.id],
          sidechainTrackIds: sidechain,
          reductionDb: -10,
        },
      ],
      t('自动压低背景音'),
    );
  };

  const handleRemoveSilence = () => {
    if (!selectedClipInfo) return;
    void applyEdit([{ op: 'remove_silence', clipId: selectedClipInfo.clip.id }], t('一键去静音'));
  };

  const handleNormalizeLoudness = () => {
    void applyEdit([{ op: 'normalize_loudness', targetLufs: -14 }], t('响度标准化'));
  };

  // Poll active export job until terminal state.
  useEffect(() => {
    if (!exportJob || (exportJob.status !== 'queued' && exportJob.status !== 'running')) return;
    if (!window.aelion?.videoExportStatus) return;
    let active = true;
    const timer = setInterval(() => {
      void window.aelion
        .videoExportStatus(exportJob.id)
        .then((next) => {
          if (active && next) setExportJob(next);
        })
        .catch(() => {});
    }, 500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [exportJob?.id, exportJob?.status]);

  const startExport = async () => {
    if (!project || !window.aelion?.videoProjectExport) return;
    setExportOpen(false);
    setStatusError('');
    try {
      const job = await window.aelion.videoProjectExport({
        projectId: project.id,
        format: exportFormat,
        quality: exportQuality,
        attachToChat: exportAttach,
        ...(exportFormat === 'png' ? { timeUs: Math.round(currentTimeRef.current) } : {}),
      });
      setExportJob(job);
    } catch (err) {
      setStatusError(previewErrorText(err));
    }
  };

  const cancelExport = async () => {
    if (!exportJob || !window.aelion?.videoExportCancel) return;
    try {
      await window.aelion.videoExportCancel(exportJob.id);
      setExportJob((prev) => (prev ? { ...prev, status: 'cancelled' } : null));
    } catch (err) {
      setStatusError(previewErrorText(err));
    }
  };

  // A cancelled export only needs saying once.
  useEffect(() => {
    if (exportJob?.status !== 'cancelled') return;
    const timer = setTimeout(() => setExportJob(null), 2600);
    return () => clearTimeout(timer);
  }, [exportJob?.status]);

  // The export popover closes on Escape (before the preview shell takes the key to close itself), on a press
  // outside it, and when focus goes to the player frame, whose presses never reach this document.
  useEffect(() => {
    if (!exportOpen) return;
    const escape = () => {
      setExportOpen(false);
      exportButtonRef.current?.focus({ preventScroll: true });
    };
    const dismiss = () => setExportOpen(false);
    const outside = (event: PointerEvent) => {
      if (!exportWrapRef.current?.contains(event.target as Node)) dismiss();
    };
    claimEscape = escape;
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', dismiss);
    return () => {
      if (claimEscape === escape) claimEscape = undefined;
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', dismiss);
    };
  }, [exportOpen]);

  // Keyboard shortcuts: Space, Left/Right, Undo/Redo, Delete.
  const deleteSelected = useRef<() => boolean>(() => false);
  deleteSelected.current = () => {
    // Only where the selection can be seen, and under the same conditions as the 删除 button.
    if (tab !== 'timeline' || !selectedClipInfo || editBusy) return false;
    handleDeleteClip(false);
    return true;
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const root = rootRef.current;
      if (!root) return;
      const panel = root.closest('.fp-panel');
      const active = document.activeElement as HTMLElement | null;
      if (panel && active && !panel.contains(active) && active !== document.body) return;
      if (event.isComposing || previewTextInput(event)) return;

      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          if (projectRef.current?.canRedo) void applyEdit([{ op: 'redo' }]);
        } else if (projectRef.current?.canUndo) {
          void applyEdit([{ op: 'undo' }]);
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === ' ' && !active?.closest('button,[role="button"],a,summary')) {
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepFrame(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepFrame(1);
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && deleteSelected.current()) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyEdit, togglePlay, stepFrame]);

  // What the timeline calls back with. They keep their identity, so the memoised timeline renders for the project,
  // the zoom and the selection only.
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const openPin = useCallback(
    (id: string, sec: number) => {
      pausePlayer();
      seekUs(sec * 1_000_000);
      runtimeRef.current?.selectAnnotation?.(id);
    },
    [pausePlayer, seekUs],
  );
  const changeTrack = useCallback(
    (trackId: string, change: { muted?: boolean; solo?: boolean; enabled?: boolean }) =>
      void applyEdit([{ op: 'set_track_audio', trackId, ...change }]),
    [applyEdit],
  );
  const emitDragPreview = useCallback(
    (overlay: VideoPlayerDragOverlay | null) => {
      const now = performance.now();
      if (overlay && now - dragEmitAt.current < 48) return;
      dragEmitAt.current = now;
      postToPlayer({ source: 'aelion-video-host', type: 'previewDrag', overlay });
    },
    [postToPlayer],
  );
  const commitDrag = useCallback(
    (next: ClipPlacement) => {
      setPlacement(next);
      const { clipId, trackId, startUs, durationUs: lengthUs, sourceStartUs } = next;
      void applyEdit([
        next.mode === 'move'
          ? { op: 'move_clip', clipId, startUs, trackId }
          : { op: 'trim_clip', clipId, startUs, durationUs: lengthUs, sourceStartUs },
      ]).finally(() => setPlacement((current) => (current === next ? null : current)));
    },
    [applyEdit],
  );

  const timelineTotalSec = Math.max(durationSec + 2, 10);

  // Zoom keeps a time in place: the playhead while it is in view, the middle of the view otherwise.
  const zoomAnchor = useRef<{ sec: number; offset: number } | null>(null);
  const zoomTween = useRef(0);
  const setZoom = useCallback((next: number) => {
    const scroll = timelineScrollRef.current,
      lane = rulerRef.current;
    if (scroll && lane) {
      const width = scroll.clientWidth - lane.offsetLeft,
        head = (currentTimeRef.current / 1_000_000) * ppsRef.current - scroll.scrollLeft,
        offset = head >= 0 && head <= width ? head : width / 2;
      zoomAnchor.current = { sec: (scroll.scrollLeft + offset) / ppsRef.current, offset };
    }
    setPxPerSec(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next)));
  }, []);
  useLayoutEffect(() => {
    ppsRef.current = pxPerSec;
    const anchor = zoomAnchor.current,
      scroll = timelineScrollRef.current;
    zoomAnchor.current = null;
    if (anchor && scroll) scroll.scrollLeft = Math.max(0, anchor.sec * pxPerSec - anchor.offset);
  }, [pxPerSec]);
  /** The − and + buttons glide to the next step instead of jumping. */
  const zoomBy = (direction: 1 | -1) => {
    const from = ppsRef.current,
      to = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(from + direction * ZOOM_STEP))),
      started = performance.now();
    cancelAnimationFrame(zoomTween.current);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setZoom(to);
    const step = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - started) / 160));
      setZoom(progress < 1 ? from + (to - from) * (1 - (1 - progress) ** 3) : to);
      if (progress < 1) zoomTween.current = requestAnimationFrame(step);
    };
    zoomTween.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(zoomTween.current), []);
  // The first time a project's timeline is shown, the zoom fits the whole of it into the view.
  const fittedProject = useRef('');
  useLayoutEffect(() => {
    const scroll = timelineScrollRef.current,
      lane = rulerRef.current;
    if (!scroll || !lane || !project || durationSec <= 0 || fittedProject.current === project.id) return;
    fittedProject.current = project.id;
    const room = scroll.clientWidth - lane.offsetLeft;
    if (room > 0) setPxPerSec(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.floor(room / timelineTotalSec))));
  }, [project?.id, tab, durationSec > 0]);

  // Modes cross-fade. The picture only fades: the annotation layer lays its pins out from where it is measured.
  useSwitchMotion(bodyRef, tab, undefined, 'fade');

  // Whatever shows the time is filled by the clock, also when it has only just been rendered.
  useLayoutEffect(() => {
    paintTime(currentTimeRef.current);
  });

  if (loading) {
    return (
      <div className="vs-state" role="status">
        <i className="vc-spinner" aria-hidden="true" />
        <strong>{t('正在准备视频工作室')}</strong>
      </div>
    );
  }

  if (loadError || !project) {
    return (
      <div className="vs-state" role="alert">
        <span className="vs-state-icon" aria-hidden="true">
          <Icon name="film" size={24} />
        </span>
        <strong>{t('暂时无法打开视频项目')}</strong>
        <p>{loadError || name}</p>
        <button type="button" className="vc-btn" onClick={() => void fetchProject()}>
          {t('重试')}
        </button>
      </div>
    );
  }

  const annotating = runtime?.mode === 'annotate';
  const playerSrc = `${PLAYER_BASE_URL}?projectId=${encodeURIComponent(project.id)}`;
  const exporting = exportJob?.status === 'queued' || exportJob?.status === 'running';

  return (
    <div className="vs-root" ref={rootRef} style={{ '--vs-duration': Math.max(durationSec, 0.001) } as CSSProperties}>
      <header className="vs-topbar">
        <div className="vs-title">
          <strong title={project.title}>{project.title || name}</strong>
          <span>
            {project.aspect} · {project.width}×{project.height} · {Math.round(fps)}fps ·{' '}
            {formatPinTimecode(durationSec)}
          </span>
        </div>

        <div className="vc-seg" role="tablist" aria-label={t('视频工作区模式')}>
          {(
            [
              { id: 'preview', label: t('预览') },
              { id: 'timeline', label: t('时间轴') },
              { id: 'annotate', label: t('批注') },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => chooseTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="vs-top-actions">
          <button
            type="button"
            className="vc-icon-btn"
            disabled={!project.canUndo || editBusy}
            title={t('撤销') + ' (Ctrl+Z)'}
            aria-label={t('撤销')}
            onClick={() => void applyEdit([{ op: 'undo' }])}
          >
            <Icon name="undo" size={17} />
          </button>
          <button
            type="button"
            className="vc-icon-btn"
            disabled={!project.canRedo || editBusy}
            title={t('重做') + ' (Ctrl+Shift+Z)'}
            aria-label={t('重做')}
            onClick={() => void applyEdit([{ op: 'redo' }])}
          >
            <Icon name="redo" size={17} />
          </button>

          <div className="vs-export-wrap" ref={exportWrapRef}>
            <button
              type="button"
              className="vc-btn is-ink"
              ref={exportButtonRef}
              aria-haspopup="dialog"
              aria-expanded={exportOpen}
              onClick={() => setExportOpen((open) => !open)}
            >
              <Icon name="download" size={15} />
              <span>{t('导出')}</span>
            </button>
            <Presence>
              {exportOpen && (
                <ExportPopover
                  format={exportFormat}
                  quality={exportQuality}
                  attach={exportAttach}
                  onFormat={setExportFormat}
                  onQuality={setExportQuality}
                  onAttach={setExportAttach}
                  onCancel={() => setExportOpen(false)}
                  onStart={() => void startExport()}
                />
              )}
            </Presence>
          </div>
        </div>
      </header>

      <div className="vs-body" ref={bodyRef}>
        <div className="vs-main">
          <div className="vs-stage">
            <div className="vs-stage-frame">
              <div
                className="vs-canvas-surface"
                ref={surfaceRef}
                style={{ '--vs-aspect': (project.width || 16) / (project.height || 9) } as CSSProperties}
              >
                {fallbackMode ? (
                  <div className="vs-fallback-stage">
                    {fallbackImage || project.posterDataUrl ? (
                      <img src={fallbackImage || project.posterDataUrl} alt={project.title} draggable={false} />
                    ) : (
                      <div className="vs-fallback-empty">
                        <Icon name="film" size={28} />
                        <span>{t('静态画面预览')}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      className="vc-btn is-sm vc-glass vs-fallback-retry"
                      onClick={() => {
                        setFallbackMode(false);
                        setPlayerReady(false);
                        setIframeKey((k) => k + 1);
                      }}
                    >
                      {t('重试实时画布')}
                    </button>
                  </div>
                ) : (
                  <iframe
                    key={iframeKey}
                    ref={iframeRef}
                    className={`vs-player-iframe ${annotating ? 'is-inert' : ''}`}
                    src={playerSrc}
                    title={project.title || name}
                    onError={() => setFallbackMode(true)}
                  />
                )}
              </div>
            </div>

            {/* Export progress and notices float here instead of taking a row each. */}
            <div className="vs-toasts">
              <Presence>
                {exportJob && (
                  <VideoToast
                    tone={exporting ? 'info' : exportJob.status === 'failed' ? 'error' : 'ok'}
                    {...(exporting
                      ? {
                          progress: Math.max(0.04, exportJob.progress),
                          action: { label: t('取消导出'), onClick: () => void cancelExport() },
                        }
                      : { detail: exportJob.error || exportJob.outputPath, onClose: () => setExportJob(null) })}
                  >
                    {exportJob.status === 'completed'
                      ? t('{format} 导出完成', { format: exportJob.format.toUpperCase() })
                      : exportJob.status === 'failed'
                        ? t('导出失败')
                        : exportJob.status === 'cancelled'
                          ? t('已取消导出')
                          : t('正在导出 {format}… {pct}%', {
                              format: exportJob.format.toUpperCase(),
                              pct: Math.round(exportJob.progress * 100),
                            })}
                  </VideoToast>
                )}
              </Presence>
              <Presence>
                {statusError && (
                  <VideoToast tone="error" onClose={() => setStatusError('')}>
                    {statusError}
                  </VideoToast>
                )}
              </Presence>
              <Presence>
                {syncNotice && (
                  <VideoToast tone={syncNotice.tone} onClose={() => setSyncNotice(null)}>
                    {syncNotice.text}
                  </VideoToast>
                )}
              </Presence>
            </div>
          </div>

          <div className="vs-transport">
            <span className="vc-timecode">
              <span ref={timecodeRef} /> <em>/ {formatVideoTimecode(durationSec, fps)}</em>
            </span>
            <div className="vs-transport-center">
              <button
                type="button"
                className="vc-icon-btn"
                title={t('上一帧 (←)')}
                aria-label={t('上一帧')}
                onClick={() => stepFrame(-1)}
              >
                <Icon name="stepBack" size={16} />
              </button>
              <button
                type="button"
                className="vc-play"
                disabled={fallbackMode}
                title={playing ? t('暂停 (Space)') : t('播放 (Space)')}
                aria-label={playing ? t('暂停') : t('播放')}
                onClick={togglePlay}
              >
                <Icon name={playing ? 'pause' : 'play'} size={16} />
              </button>
              <button
                type="button"
                className="vc-icon-btn"
                title={t('下一帧 (→)')}
                aria-label={t('下一帧')}
                onClick={() => stepFrame(1)}
              >
                <Icon name="stepForward" size={16} />
              </button>
            </div>
            <div className="vs-transport-side">
              <Select
                className="vc-select"
                aria-label={t('播放倍速')}
                value={rate}
                onChange={(event) => setRate(Number(event.target.value))}
              >
                {RATES.map((value) => (
                  <option key={value} value={value}>
                    {value}x
                  </option>
                ))}
              </Select>
              <button
                type="button"
                className="vc-icon-btn"
                aria-pressed={muted}
                title={muted ? t('取消静音') : t('静音')}
                aria-label={muted ? t('取消静音') : t('静音')}
                onClick={() => setMuted((prev) => !prev)}
              >
                <Icon name={muted || volume === 0 ? 'speakerOff' : 'speaker'} size={16} />
              </button>
              <VideoRange
                value={muted ? 0 : volume}
                step={0.05}
                aria-label={t('音量')}
                onChange={(next) => {
                  setVolume(next);
                  if (next > 0 && muted) setMuted(false);
                }}
              />
            </div>
          </div>

          {tab !== 'timeline' && durationUs > 0 && (
            <MiniScrubber
              durationSec={durationSec}
              currentSec={currentTimeUs / 1_000_000}
              pins={timecodedPins}
              selectedPinId={runtime?.selectedAnnotationId}
              onSeek={seekUs}
              onStep={stepFrame}
              onPin={openPin}
            />
          )}
        </div>

        {tab === 'timeline' && (
          <aside className={`vs-inspector ${selectedClipInfo ? '' : 'is-empty'}`} aria-label={t('片段属性')}>
            {selectedClipInfo ? (
              <ClipInspector
                key={selectedClipInfo.clip.id}
                project={project}
                clip={selectedClipInfo.clip}
                prevClip={selectedClipInfo.prevClip}
                applyEdit={applyEdit}
                removedRef={removedClipsRef}
              />
            ) : (
              <div className="vs-inspector-empty">
                <Icon name="sliders" size={20} />
                <span>{t('选中时间轴上的片段，在这里调整它')}</span>
              </div>
            )}
          </aside>
        )}
      </div>

      {tab === 'timeline' && (
        <section className="vs-timeline-panel" aria-label={t('多轨时间轴')}>
          <div className="vs-timeline-bar">
            <div className="vs-timeline-tools">
              <button
                type="button"
                className="vc-btn is-quiet is-sm"
                disabled={!canSplit || editBusy}
                onClick={handleSplit}
                title={t('在当前播放头位置分割选中片段')}
              >
                <Icon name="scissors" size={15} />
                {t('分割')}
              </button>
              <button
                type="button"
                className="vc-btn is-quiet is-sm"
                disabled={!selectedClipInfo || editBusy}
                onClick={() => handleDeleteClip(false)}
              >
                <Icon name="trash" size={15} />
                {t('删除')}
              </button>
              <button
                type="button"
                className="vc-btn is-quiet is-sm"
                disabled={!selectedClipInfo || editBusy}
                onClick={() => handleDeleteClip(true)}
                title={t('删除选中片段并自动前移后续片段')}
              >
                <Glyph name="ripple" />
                {t('波纹删除')}
              </button>
              <span className="vs-divider" aria-hidden="true" />
              <button
                type="button"
                className="vc-btn is-quiet is-sm"
                disabled={editBusy}
                onClick={() => handleAddText('text')}
              >
                <Glyph name="text" />
                {t('添加文字')}
              </button>
              <button
                type="button"
                className="vc-btn is-quiet is-sm"
                disabled={editBusy}
                onClick={() => handleAddText('caption')}
              >
                <Icon name="captions" size={15} />
                {t('添加字幕')}
              </button>
              <span className="vs-divider" aria-hidden="true" />
              <button type="button" className="vc-btn is-quiet is-sm" disabled={editBusy} onClick={handleAutoDuck}>
                <Glyph name="duck" />
                {t('自动压低背景音')}
              </button>
              <button
                type="button"
                className="vc-btn is-quiet is-sm"
                disabled={!selectedClipInfo || editBusy}
                onClick={handleRemoveSilence}
              >
                <Icon name="waveform" size={15} />
                {t('一键去静音')}
              </button>
              <button
                type="button"
                className="vc-btn is-quiet is-sm"
                disabled={editBusy}
                onClick={handleNormalizeLoudness}
              >
                <Glyph name="level" />
                {t('响度标准化')}
              </button>
            </div>

            <div className="vs-zoom">
              <button
                type="button"
                className="vc-icon-btn is-sm"
                disabled={pxPerSec <= ZOOM_MIN}
                title={t('缩小')}
                aria-label={t('缩小')}
                onClick={() => zoomBy(-1)}
              >
                <Icon name="minus" size={14} />
              </button>
              <VideoRange
                value={pxPerSec}
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={2}
                aria-label={t('时间轴缩放')}
                onChange={(next) => {
                  cancelAnimationFrame(zoomTween.current);
                  setZoom(next);
                }}
              />
              <button
                type="button"
                className="vc-icon-btn is-sm"
                disabled={pxPerSec >= ZOOM_MAX}
                title={t('放大')}
                aria-label={t('放大')}
                onClick={() => zoomBy(1)}
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
          </div>

          <StudioTimeline
            project={project}
            pps={pxPerSec}
            totalSec={timelineTotalSec}
            fps={fps}
            selectedClipId={selectedClipId}
            placement={placement}
            editBusy={editBusy}
            pins={timecodedPins}
            selectedPinId={runtime?.selectedAnnotationId}
            scrollRef={timelineScrollRef}
            rulerRef={rulerRef}
            playheadTagRef={playheadTagRef}
            timeRef={currentTimeRef}
            draggingRef={draggingRef}
            onSelect={setSelectedClipId}
            onSeek={seekUs}
            onPin={openPin}
            onTrack={changeTrack}
            onDragPreview={emitDragPreview}
            onDragCommit={commitDrag}
          />
        </section>
      )}
    </div>
  );
}
