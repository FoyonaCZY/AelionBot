import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ArtifactPreview } from '../../shared/types/core';
import type { VideoMediaProbe, VideoMediaSourceRef, VideoQuickEditResult } from '../../shared/types/video-studio-types';
import { pinNumber } from '../../shared/preview/preview-annotations';
import { previewTextInput } from '../../shared/preview/preview-shortcuts';
import { useI18n } from '../i18n';
import { Icon } from '../ui/Icon';
import { Presence } from '../ui/Presence';
import { Select } from '../ui/Select';
import { useCollapse } from '../ui/use-collapse';
import type { PreviewItem } from './FilePreviewContext';
import { usePreviewRuntime } from './preview-runtime';
import { formatPinTimecode, formatVideoTimecode, previewErrorText } from './preview-utils';
import { VideoRange, VideoToast } from './video-controls';
import './video-preview.css';

const RATES = [0.5, 1, 1.25, 1.5, 2] as const;
/** The shortest range the trim grips can make. */
const MIN_TRIM_SEC = 0.1;
/** How long a finished toast stays, and how long the fullscreen dock waits before it steps away. */
const TOAST_MS = 6000;
const IDLE_MS = 2600;
/** How long the playhead takes to travel to a marker (--motion-view, plus a frame). */
const TRAVEL_MS = 260;

type DragMode = 'scrub' | 'in' | 'out' | 'move';
interface StatusMessage {
  id: number;
  tone: 'info' | 'ok' | 'error';
  text: string;
  /** Shown muted after the text: where the file went. */
  detail?: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Where the in and out time tags sit, in px from the scrubber's left edge: over their grips, no further than `pad`
 * beyond the scrubber's ends (the dock's padding) and pushed apart when the range is too short for both.
 */
function trimTagCentres(inX: number, outX: number, width: number, half: number, pad: number) {
  const min = half - pad,
    max = Math.max(min, width + pad - half),
    gap = half * 2 + 4;
  let a = clamp(inX - 6, min, max),
    b = clamp(outX + 6, min, max);
  if (b - a < gap) {
    const mid = clamp((a + b) / 2, min + gap / 2, Math.max(min + gap / 2, max - gap / 2));
    a = mid - gap / 2;
    b = mid + gap / 2;
  }
  return [a, b] as const;
}

function resolveMediaSource(item: PreviewItem): VideoMediaSourceRef | undefined {
  if (item.workspace) {
    return { kind: 'workspace', botId: item.workspace.botId, path: item.workspace.path };
  }
  if (item.id.startsWith('attachment:')) {
    return { kind: 'attachment', attachmentId: item.id.slice('attachment:'.length) };
  }
  return undefined;
}

function baseFileName(name: string) {
  const trimmed = name.replace(/\.[^.]+$/, '').trim();
  return trimmed || name;
}

export function VideoPreview({
  src,
  name,
  item,
  initialMeta,
}: {
  src: string;
  name: string;
  item: PreviewItem;
  initialMeta?: Pick<ArtifactPreview, 'durationSec' | 'width' | 'height' | 'posterDataUrl'>;
}) {
  const { t } = useI18n();
  const runtime = usePreviewRuntime();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(initialMeta?.durationSec || 0);
  const [dimensions, setDimensions] = useState({
    width: initialMeta?.width || 0,
    height: initialMeta?.height || 0,
  });
  const [rate, setRate] = useState<number>(1);
  const [loop, setLoop] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState(false);
  const [hudIcon, setHudIcon] = useState<'play' | 'pause' | null>(null);
  const hudTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [probe, setProbe] = useState<VideoMediaProbe | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const [trimActive, setTrimActive] = useState(false);
  const [trimIn, setTrimIn] = useState(0);
  const [trimOut, setTrimOut] = useState(0);
  const [trimFormat, setTrimFormat] = useState<'mp4' | 'webm'>('mp4');

  const [busyAction, setBusyAction] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const statusId = useRef(0);
  const toastHover = useRef(false);
  const showStatus = useCallback((tone: StatusMessage['tone'], text: string, detail?: string) => {
    setStatusMessage({ id: ++statusId.current, tone, text, detail });
  }, []);

  // The picture is still on its way (metadata loading, or playback stalled): the stage shows a ring.
  const [loading, setLoading] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The scrubber: what is being dragged, the pointer over it, and its width for the trim tags and the compact rows.
  const [drag, setDrag] = useState<DragMode | null>(null);
  const [hovering, setHovering] = useState(false);
  const [limit, setLimit] = useState<'in' | 'out' | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const dragMode = useRef<DragMode | null>(null);
  /** Seconds between the pointer and the grip (or the range's start) it holds, so a grab never makes it jump. */
  const dragGrab = useRef(0);
  const pointerX = useRef<number | null>(null);
  const pointerFrame = useRef(0);
  const travelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const timeTextRef = useRef<HTMLSpanElement>(null);
  const hoverTextRef = useRef<HTMLElement>(null);
  const source = useMemo(() => resolveMediaSource(item), [item.id, item.workspace?.botId, item.workspace?.path]);
  const fps = probe?.fps && probe.fps > 0 ? probe.fps : 30;
  const effectiveDuration = duration > 0 ? duration : probe?.durationUs ? probe.durationUs / 1_000_000 : 0;
  const silences = probe?.silences || [];
  const totalSilenceSec = useMemo(() => silences.reduce((sum, seg) => sum + seg.durationUs / 1_000_000, 0), [silences]);
  const timecodedPins = useMemo(
    () =>
      (runtime?.annotations || [])
        .map((mark, index) => ({ mark, n: pinNumber(mark, index) }))
        .filter((entry) => entry.mark.timestampSec !== undefined),
    [runtime?.annotations],
  );

  const flashHud = useCallback((icon: 'play' | 'pause') => {
    setHudIcon(icon);
    if (hudTimer.current) clearTimeout(hudTimer.current);
    hudTimer.current = setTimeout(() => setHudIcon(null), 500);
  }, []);

  useEffect(() => {
    return () => {
      if (hudTimer.current) clearTimeout(hudTimer.current);
      if (travelTimer.current) clearTimeout(travelTimer.current);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      cancelAnimationFrame(pointerFrame.current);
    };
  }, []);

  // Fullscreen: the button shows which way it goes, and the dock steps away after a short idle while playing.
  useEffect(() => {
    const sync = () => setFullscreen(Boolean(rootRef.current) && document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      // Not while something in the dock has the pointer, the focus ring or an open list.
      const dock = rootRef.current?.querySelector('.vp-dock');
      if (dock?.matches(':hover, :has(:focus-visible), :has(:open)') || dragMode.current) return;
      setIdle(true);
    }, IDLE_MS);
  }, []);
  const hideWhenIdle = fullscreen && playing;
  useEffect(() => {
    if (hideWhenIdle) wake();
    else {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      setIdle(false);
    }
  }, [hideWhenIdle, wake]);

  // A finished action's toast leaves by itself; a failure stays until it is closed.
  useEffect(() => {
    if (statusMessage?.tone !== 'ok') return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (ms: number) => {
      timer = setTimeout(() => {
        if (toastHover.current) arm(1500);
        else setStatusMessage((current) => (current?.id === statusMessage.id ? null : current));
      }, ms);
    };
    arm(TOAST_MS);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  /** Moves the playhead and the timecode without a render: playback calls it every frame, a seek right away. */
  const paintPlayhead = useCallback(
    (sec: number) => {
      const ratio = effectiveDuration > 0 ? clamp(sec / effectiveDuration, 0, 1) : 0;
      trackRef.current?.style.setProperty('--vp-p', String(ratio));
      const text = timeTextRef.current?.firstChild;
      if (text) text.nodeValue = formatVideoTimecode(sec, fps);
    },
    [effectiveDuration, fps],
  );

  const seekTo = useCallback(
    (sec: number) => {
      const video = videoRef.current;
      if (!video) return;
      const maxTime = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : effectiveDuration;
      const clamped = Math.max(0, maxTime > 0 ? Math.min(sec, maxTime) : sec);
      video.currentTime = clamped;
      setCurrentTime(clamped);
      paintPlayhead(clamped);
    },
    [effectiveDuration, paintPlayhead],
  );

  /** A seek the eye can follow: the playhead slides to the new time instead of jumping (video-preview.css). */
  const travelTo = useCallback(
    (sec: number) => {
      const track = trackRef.current;
      if (track) {
        track.toggleAttribute('data-travel', true);
        if (travelTimer.current) clearTimeout(travelTimer.current);
        travelTimer.current = setTimeout(() => track.removeAttribute('data-travel'), TRAVEL_MS);
      }
      seekTo(sec);
    },
    [seekTo],
  );

  // While it plays the playhead follows the video frame by frame; timeupdate alone comes about four times a second.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      const video = videoRef.current;
      if (video && !dragMode.current) paintPlayhead(video.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, paintPlayhead]);

  const pauseVideo = useCallback(() => {
    const video = videoRef.current;
    if (video && !video.paused) video.pause();
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || error) return;
    if (video.paused || video.ended) {
      if (trimActive && trimOut > trimIn && (video.currentTime < trimIn || video.currentTime >= trimOut - 0.04)) {
        video.currentTime = trimIn;
      }
      void video.play().catch(() => {});
      flashHud('play');
    } else {
      video.pause();
      flashHud('pause');
    }
  }, [error, flashHud, trimActive, trimIn, trimOut]);

  const stepFrame = useCallback(
    (deltaFrames: number) => {
      const video = videoRef.current;
      if (!video) return;
      if (!video.paused) video.pause();
      const step = deltaFrames / fps;
      seekTo((video.currentTime || 0) + step);
    },
    [fps, seekTo],
  );

  const captureCurrentFrame = useCallback(async (): Promise<string | undefined> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return undefined;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return undefined;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } catch {
      return undefined;
    }
  }, []);

  // Register video controls with PreviewRuntimeContext so FileAnnotationLayer and PinChips can read time & seek.
  useEffect(() => {
    const setVideo = runtime?.setVideo;
    if (!setVideo) return;
    setVideo({
      getCurrentTimeSec: () => videoRef.current?.currentTime ?? 0,
      seekTo,
      pause: pauseVideo,
      captureFrame: captureCurrentFrame,
    });
    return () => setVideo(undefined);
  }, [runtime?.setVideo, seekTo, pauseVideo, captureCurrentFrame]);

  // Pause automatically when entering annotate mode so pins land on a stationary frame.
  useEffect(() => {
    if (runtime?.mode === 'annotate') pauseVideo();
  }, [runtime?.mode, pauseVideo]);

  // Lazily analyze the media in the background for filmstrip, waveform, and silence intervals.
  useEffect(() => {
    setProbe(null);
    if (!source || !window.aelion?.videoMediaAnalyze) return;
    let active = true;
    setAnalyzing(true);
    window.aelion
      .videoMediaAnalyze({
        source,
        includeFilmstrip: true,
        filmstripCount: 14,
        includeWaveform: true,
        waveformPoints: 180,
        detectSilence: true,
      })
      .then((result) => {
        if (!active) return;
        setProbe(result);
        if (result.durationUs > 0) {
          const sec = result.durationUs / 1_000_000;
          setDuration((prev) => (prev > 0 ? prev : sec));
          setTrimOut((prev) => (prev > 0 ? prev : sec));
        }
        if (result.width && result.height) {
          setDimensions((prev) => (prev.width ? prev : { width: result.width!, height: result.height! }));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setAnalyzing(false);
      });
    return () => {
      active = false;
    };
  }, [source]);

  // The audio waveform along the scrubber's bottom edge; drawn once, and again when the scrubber changes size.
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    const peaks = probe?.waveform;
    if (!canvas || !peaks?.length) return;
    const draw = () => {
      const width = canvas.clientWidth,
        height = canvas.clientHeight;
      if (width < 4 || height < 4) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      // White on the picture in both themes, like the other marks drawn over it.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      // About one bar every 3px, each as tall as the loudest peak it covers.
      const bars = Math.max(1, Math.min(peaks.length, Math.floor(width / 3)));
      const step = width / bars,
        barWidth = Math.max(1, step * 0.6);
      for (let i = 0; i < bars; i++) {
        const from = Math.floor((i * peaks.length) / bars),
          to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / bars));
        let amp = 0;
        for (let j = from; j < to; j++) amp = Math.max(amp, peaks[j] || 0);
        const barHeight = Math.max(1.5, Math.min(1, amp) * (height - 2));
        ctx.beginPath();
        ctx.roundRect(i * step, height - barHeight, barWidth, barHeight, barWidth / 2);
        ctx.fill();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [probe?.waveform]);

  // The scrubber's width places the trim tags and decides which labels fit.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => setTrackWidth(track.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  // Sync video element properties.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.loop = loop;
  }, [loop]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
  }, [volume, muted]);

  // Keyboard shortcuts: Space (play/pause), J/K/L shuttle, Left/Right frame step, M mute, I/O trim handles.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const root = rootRef.current;
      if (!root) return;
      const panel = root.closest('.fp-panel');
      const active = document.activeElement as HTMLElement | null;
      if (panel && active && !panel.contains(active) && active !== document.body) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || previewTextInput(event)) return;
      if (active?.closest('.cm-editor,[role="listbox"],[role="menu"]')) return;

      const key = event.key;
      const lower = key.toLowerCase();
      if (key === ' ') {
        if (active?.closest('button,[role="button"],a,summary')) return;
        event.preventDefault();
        togglePlay();
        return;
      }
      if (key === 'ArrowLeft') {
        event.preventDefault();
        stepFrame(-1);
        return;
      }
      if (key === 'ArrowRight') {
        event.preventDefault();
        stepFrame(1);
        return;
      }
      if (lower === 'k') {
        event.preventDefault();
        pauseVideo();
        flashHud('pause');
        return;
      }
      if (lower === 'j') {
        event.preventDefault();
        const video = videoRef.current;
        if (!video) return;
        if (!video.paused && rate > 1) {
          setRate(1);
        } else {
          pauseVideo();
          seekTo((video.currentTime || 0) - 1.5);
        }
        return;
      }
      if (lower === 'l') {
        event.preventDefault();
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) {
          setRate(1);
          void video.play().catch(() => {});
          flashHud('play');
        } else {
          setRate((prev) => (prev < 1.5 ? 1.5 : prev < 2 ? 2 : 1));
        }
        return;
      }
      if (lower === 'm') {
        event.preventDefault();
        setMuted((prev) => !prev);
        return;
      }
      if (trimActive && lower === 'i') {
        event.preventDefault();
        setTrimIn(Math.min(currentTime, Math.max(0, trimOut - MIN_TRIM_SEC)));
        return;
      }
      if (trimActive && lower === 'o') {
        event.preventDefault();
        setTrimOut(Math.max(currentTime, Math.min(effectiveDuration, trimIn + MIN_TRIM_SEC)));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    togglePlay,
    stepFrame,
    pauseVideo,
    seekTo,
    flashHud,
    rate,
    trimActive,
    currentTime,
    trimIn,
    trimOut,
    effectiveDuration,
  ]);

  /** The trim range as the pointer handlers need it: they run between renders. */
  const trimRange = useRef({ in: 0, out: 0 });
  trimRange.current = { in: trimIn, out: trimOut || effectiveDuration };

  const timeFromPointer = (clientX: number) => {
    const track = trackRef.current;
    if (!track || effectiveDuration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    return clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * effectiveDuration;
  };

  /** The time under the pointer: the line follows it, the bubble stops at the scrubber's ends. */
  const paintHover = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width);
    track.style.setProperty('--vp-hx', `${x}px`);
    track.style.setProperty('--vp-hbx', `${clamp(x, 22, Math.max(22, rect.width - 22))}px`);
    const text = hoverTextRef.current?.firstChild;
    if (text) text.nodeValue = formatPinTimecode((x / Math.max(1, rect.width)) * effectiveDuration);
  };

  const applyDrag = (clientX: number) => {
    const mode = dragMode.current;
    if (!mode) return;
    const range = trimRange.current;
    const sec = timeFromPointer(clientX) - dragGrab.current;
    if (mode === 'scrub') {
      seekTo(sec);
    } else if (mode === 'in') {
      // The grips stop at the shortest range instead of crossing.
      const max = Math.max(0, range.out - MIN_TRIM_SEC);
      const next = clamp(sec, 0, max);
      setLimit(sec > max ? 'in' : null);
      setTrimIn(next);
      seekTo(next);
    } else if (mode === 'out') {
      const min = Math.min(effectiveDuration, range.in + MIN_TRIM_SEC);
      const next = clamp(sec, min, effectiveDuration);
      setLimit(sec < min ? 'out' : null);
      setTrimOut(next);
      seekTo(next);
    } else {
      // The whole range moves, keeping its length.
      const length = range.out - range.in;
      const next = clamp(sec, 0, Math.max(0, effectiveDuration - length));
      setTrimIn(next);
      setTrimOut(next + length);
      seekTo(next);
    }
  };

  // Pointer moves are applied once a frame, however many arrive.
  const latestDrag = useRef(applyDrag);
  latestDrag.current = applyDrag;
  const latestHover = useRef(paintHover);
  latestHover.current = paintHover;
  const queuePointer = (clientX: number) => {
    pointerX.current = clientX;
    if (pointerFrame.current) return;
    pointerFrame.current = requestAnimationFrame(() => {
      pointerFrame.current = 0;
      if (pointerX.current === null) return;
      latestHover.current(pointerX.current);
      latestDrag.current(pointerX.current);
    });
  };

  const onScrubPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-trim-handle]')?.dataset.trimHandle;
    const mode: DragMode = handle === 'in' || handle === 'out' || handle === 'move' ? handle : 'scrub';
    const sec = timeFromPointer(event.clientX),
      range = trimRange.current;
    dragGrab.current = mode === 'scrub' ? 0 : sec - (mode === 'out' ? range.out : range.in);
    dragMode.current = mode;
    setDrag(mode);
    event.currentTarget.setPointerCapture(event.pointerId);
    // A click lands at once; a grabbed grip shows its own frame without moving.
    trackRef.current?.removeAttribute('data-travel');
    paintHover(event.clientX);
    applyDrag(event.clientX);
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // The last move may still be waiting for its frame.
    if (pointerFrame.current) {
      cancelAnimationFrame(pointerFrame.current);
      pointerFrame.current = 0;
      if (event.type === 'pointerup') applyDrag(event.clientX);
    }
    dragMode.current = null;
    setDrag(null);
    setLimit(null);
  };

  const toggleTrimMode = () => {
    setTrimActive((prev) => {
      const next = !prev;
      if (next && effectiveDuration > 0 && trimOut <= trimIn) {
        setTrimIn(0);
        setTrimOut(effectiveDuration);
      }
      return next;
    });
  };

  const runQuickEdit = async (
    key: string,
    task: () => Promise<VideoQuickEditResult>,
    successText: (result: VideoQuickEditResult) => string,
  ) => {
    if (busyAction) return;
    setBusyAction(key);
    setStatusMessage(null);
    try {
      const result = await task();
      if (result.project && runtime?.openVideoProject) {
        runtime.openVideoProject(result.project);
        return;
      }
      // Where the file went follows the message, muted.
      showStatus('ok', successText(result), result.outputPath || undefined);
    } catch (err) {
      showStatus('error', previewErrorText(err));
    } finally {
      setBusyAction('');
    }
  };

  const handleTrimExport = () => {
    if (!source || !window.aelion?.videoQuickEdit) {
      showStatus('error', t('当前视频来源暂不支持快速剪辑'));
      return;
    }
    const startSec = Math.max(0, Math.min(trimIn, effectiveDuration));
    const endSec = Math.max(startSec + MIN_TRIM_SEC, Math.min(trimOut || effectiveDuration, effectiveDuration));
    void runQuickEdit(
      'trim',
      () =>
        window.aelion.videoQuickEdit({
          source,
          edit: { action: 'trim', startSec, endSec, format: trimFormat, quality: 'standard' },
        }),
      () => t('已导出裁剪片段'),
    );
  };

  const handleRemoveSilence = () => {
    if (!source || !window.aelion?.videoQuickEdit) {
      showStatus('error', t('当前视频来源暂不支持快速剪辑'));
      return;
    }
    void runQuickEdit(
      'remove_silence',
      () =>
        window.aelion.videoQuickEdit({
          source,
          edit: { action: 'remove_silence', format: trimFormat, quality: 'standard' },
        }),
      (result) =>
        typeof result.removedSec === 'number' && result.removedSec > 0
          ? t('已去除 {sec} 秒静音并导出', { sec: result.removedSec.toFixed(1) })
          : t('已导出静音精剪视频'),
    );
  };

  const handleCaptureFrame = async () => {
    if (busyAction) return;
    const timeSec = videoRef.current?.currentTime ?? currentTime;
    if (source && window.aelion?.videoQuickEdit) {
      await runQuickEdit(
        'capture_frame',
        () => window.aelion.videoQuickEdit({ source, edit: { action: 'capture_frame', timeSec } }),
        (result) =>
          result.outputPath ? t('已保存当前帧') : t('已截取当前帧 {time}', { time: formatPinTimecode(timeSec) }),
      );
      return;
    }
    // Fallback: client-side PNG capture download.
    const dataUrl = await captureCurrentFrame();
    if (!dataUrl) {
      showStatus('error', t('暂时无法截取当前画面'));
      return;
    }
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${baseFileName(name)}-${formatPinTimecode(timeSec).replace(/:/g, '-')}.png`;
    link.click();
    showStatus('ok', t('已截取当前帧 {time}', { time: formatPinTimecode(timeSec) }));
  };

  const handleOpenStudio = () => {
    if (!source || !window.aelion?.videoQuickEdit) {
      showStatus('error', t('当前视频来源暂不支持多轨编辑'));
      return;
    }
    pauseVideo();
    void runQuickEdit(
      'promote_to_project',
      () =>
        window.aelion.videoQuickEdit({
          source,
          edit: {
            action: 'promote_to_project',
            title: baseFileName(name),
            botId: item.workspace?.botId || item.directoryBotId,
          },
        }),
      () => t('已打开多轨视频工作室'),
    );
  };

  const toggleFullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  };

  const progress = effectiveDuration > 0 ? clamp(currentTime / effectiveDuration, 0, 1) : 0;
  const trimEnd = trimOut || effectiveDuration;
  const trimInRatio = effectiveDuration > 0 ? clamp(trimIn / effectiveDuration, 0, 1) : 0;
  const trimOutRatio = effectiveDuration > 0 ? clamp(trimEnd / effectiveDuration, trimInRatio, 1) : 1;
  const selectedRangeSec = Math.max(0, trimEnd - trimIn);
  const annotating = runtime?.mode === 'annotate';
  const aspect = dimensions.width > 0 && dimensions.height > 0 ? dimensions.width / dimensions.height : undefined;
  // The dock reaches 14px beyond the scrubber; the tags keep clear of its rounded corners. A tag is wider once its
  // time carries hours.
  const [tagInX, tagOutX] = trimTagCentres(
    trimInRatio * trackWidth,
    trimOutRatio * trackWidth,
    trackWidth,
    effectiveDuration >= 3600 ? 38 : 30,
    6,
  );
  /** How tight the dock is: 0 roomy, 1 the secondary labels give way to their icons, 2 only the essentials stay. */
  const compact = trackWidth > 0 && trackWidth < 350 ? 2 : trackWidth > 0 && trackWidth < 640 ? 1 : 0;
  const lane = useCollapse(timecodedPins.length > 0 || trimActive);
  const showCenterPlay = !annotating && !playing && !hudIcon && !loading;
  // A long export says it is working above the dock; the quick ones only spin inside their button.
  const busyText = busyAction === 'trim' ? t('导出中…') : busyAction === 'remove_silence' ? t('去静音中…') : '';
  const toast: StatusMessage | null = statusMessage ?? (busyText ? { id: 0, tone: 'info', text: busyText } : null);
  const fullscreenLabel = fullscreen ? t('退出全屏') : t('全屏播放');

  return (
    <div
      className="vp-root"
      ref={rootRef}
      data-idle={(idle && hideWhenIdle) || undefined}
      onPointerMove={hideWhenIdle ? wake : undefined}
      onPointerDown={hideWhenIdle ? wake : undefined}
      onKeyDown={hideWhenIdle ? wake : undefined}
    >
      <div className="vp-stage">
        {error ? (
          <div className="fp-state" role="alert">
            <Icon name="video" size={28} />
            <strong>{t('暂时无法播放此视频')}</strong>
            <p>{t('当前环境无法播放此视频，可保存原文件后查看。')}</p>
          </div>
        ) : (
          <div className="vp-stage-frame" style={aspect ? ({ '--vp-ar': aspect } as CSSProperties) : undefined}>
            <video
              ref={videoRef}
              className="vp-media-surface"
              src={src}
              poster={initialMeta?.posterDataUrl || probe?.posterDataUrl}
              playsInline
              preload="metadata"
              aria-label={name}
              data-video-time={currentTime.toFixed(3)}
              onClick={() => {
                if (!annotating) togglePlay();
              }}
              onDoubleClick={() => {
                if (!annotating) toggleFullscreen();
              }}
              onLoadedMetadata={(event) => {
                const v = event.currentTarget;
                setLoading(false);
                if (Number.isFinite(v.duration) && v.duration > 0) {
                  setDuration(v.duration);
                  setTrimOut((prev) => (prev > 0 ? prev : v.duration));
                }
                if (v.videoWidth && v.videoHeight) {
                  setDimensions({ width: v.videoWidth, height: v.videoHeight });
                }
              }}
              onTimeUpdate={(event) => {
                const v = event.currentTarget;
                setCurrentTime(v.currentTime);
                if (trimActive && trimOut > trimIn && v.currentTime >= trimOut) {
                  if (loop) {
                    v.currentTime = trimIn;
                  } else {
                    v.pause();
                    v.currentTime = trimOut;
                  }
                }
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onWaiting={() => setLoading(true)}
              onPlaying={() => setLoading(false)}
              onCanPlay={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setError(true);
              }}
            />
            <Presence>
              {showCenterPlay && (
                <button type="button" className="vp-center-play vc-glass" aria-label={t('播放')} onClick={togglePlay}>
                  <Icon name="play" size={26} />
                </button>
              )}
            </Presence>
            <Presence>
              {hudIcon && (
                <span className="vp-flash vc-glass" aria-hidden="true">
                  <Icon name={hudIcon} size={24} />
                </span>
              )}
            </Presence>
            {loading && (
              <span className="vp-loading vc-glass" role="status" aria-label={t('正在加载视频…')}>
                <i className="vc-spinner" aria-hidden="true" />
              </span>
            )}
            {dimensions.width > 0 && (
              <span className="vp-meta vc-glass" aria-hidden="true">
                {dimensions.width}×{dimensions.height}
                {probe?.fps ? ` · ${Math.round(probe.fps)}fps` : ''}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="vp-dock" data-compact={compact || undefined}>
        <div
          className="vp-toasts"
          onPointerEnter={() => (toastHover.current = true)}
          onPointerLeave={() => (toastHover.current = false)}
        >
          <Presence>
            {toast && (
              <VideoToast
                key={toast.id}
                tone={toast.tone}
                detail={toast.detail}
                onClose={toast.tone === 'info' ? undefined : () => setStatusMessage(null)}
                closeLabel={t('关闭提示')}
              >
                {toast.text}
              </VideoToast>
            )}
          </Presence>
        </div>

        {/* Comment markers; the trim tags use the same lane. */}
        {lane.mounted && (
          <div className="ui-collapse" data-closing={lane.closing || undefined}>
            <div className={`vp-lane ${trimActive ? 'is-trim' : ''}`}>
              {effectiveDuration > 0 &&
                timecodedPins.map(({ mark, n }) => {
                  const at = mark.timestampSec || 0;
                  return (
                    <button
                      key={mark.id}
                      type="button"
                      className={`vp-pin ${runtime?.selectedAnnotationId === mark.id ? 'is-active' : ''}`}
                      style={{ left: `${clamp(at / effectiveDuration, 0, 1) * 100}%` }}
                      title={`#${n} · ${formatPinTimecode(at)}${mark.text ? ' · ' + mark.text : ''}`}
                      aria-label={t('跳转到评论 {n}（{time}）', { n, time: formatPinTimecode(at) })}
                      onClick={() => {
                        pauseVideo();
                        travelTo(at);
                        runtime?.selectAnnotation?.(mark.id);
                      }}
                    >
                      {n}
                    </button>
                  );
                })}
            </div>
          </div>
        )}
        {/* Scrubber: filmstrip, waveform, silence, trim range and playhead. */}
        <div
          ref={trackRef}
          className={`vp-scrubwrap ${trimActive ? 'is-trim' : ''}`}
          style={{ '--vp-p': progress, '--vp-in': trimInRatio, '--vp-out': trimOutRatio } as CSSProperties}
          data-drag={drag || undefined}
          data-hover={hovering || undefined}
          data-limit={limit || undefined}
          role="slider"
          tabIndex={0}
          aria-label={t('视频播放进度')}
          aria-valuemin={0}
          aria-valuemax={Math.round(effectiveDuration * 10) / 10}
          aria-valuenow={Math.round(currentTime * 10) / 10}
          aria-valuetext={formatPinTimecode(currentTime)}
          onPointerDown={onScrubPointerDown}
          onPointerMove={(event) => queuePointer(event.clientX)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onPointerEnter={(event) => {
            paintHover(event.clientX);
            setHovering(true);
          }}
          onPointerLeave={() => setHovering(false)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              event.stopPropagation();
              stepFrame(-1);
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              event.stopPropagation();
              stepFrame(1);
            }
          }}
        >
          <div className={`vp-scrub ${probe?.filmstrip?.length ? '' : 'is-bare'}`} aria-hidden="true">
            <div className="vp-film">
              {probe?.filmstrip?.length ? (
                probe.filmstrip.map((frame, i) => (
                  <img key={`${frame.timeUs}-${i}`} src={frame.dataUrl} alt="" draggable={false} />
                ))
              ) : (
                <div className="vp-film-empty">{analyzing ? <span>{t('正在生成缩略图与波形…')}</span> : null}</div>
              )}
            </div>
            <span className="vp-veil" />
            {effectiveDuration > 0 &&
              silences.map((seg, i) => (
                <span
                  key={`${seg.startUs}-${i}`}
                  className="vp-silence"
                  style={{
                    left: `${(seg.startUs / 1_000_000 / effectiveDuration) * 100}%`,
                    width: `${Math.max(0.5, (seg.durationUs / 1_000_000 / effectiveDuration) * 100)}%`,
                  }}
                  title={t('静音片段 · {sec} 秒', { sec: (seg.durationUs / 1_000_000).toFixed(1) })}
                />
              ))}
            {probe?.waveform?.length ? (
              <div className="vp-wave">
                <canvas ref={waveformCanvasRef} />
              </div>
            ) : null}
            <Presence>
              {trimActive && (
                <>
                  <span className="vp-trim-mask is-before" />
                  <span className="vp-trim-mask is-after" />
                </>
              )}
            </Presence>
          </div>
          <Presence>
            {trimActive && (
              <>
                <div className="vp-trim">
                  <span
                    className="vp-trim-grip is-in"
                    data-trim-handle="in"
                    title={t('入点 {time}（快捷键 I）', { time: formatVideoTimecode(trimIn, fps) })}
                  />
                  <span
                    className="vp-trim-grip is-out"
                    data-trim-handle="out"
                    title={t('出点 {time}（快捷键 O）', { time: formatVideoTimecode(trimEnd, fps) })}
                  />
                  <span className="vp-trim-move" data-trim-handle="move" title={t('拖动以移动整个裁剪范围')} />
                </div>
                <span
                  className="vp-trim-tag is-in"
                  style={{ '--x': `${tagInX}px` } as CSSProperties}
                  aria-hidden="true"
                >
                  {formatPinTimecode(trimIn)}
                </span>
                <span
                  className="vp-trim-tag is-out"
                  style={{ '--x': `${tagOutX}px` } as CSSProperties}
                  aria-hidden="true"
                >
                  {formatPinTimecode(trimEnd)}
                </span>
              </>
            )}
          </Presence>
          <span className="vp-hover" aria-hidden="true">
            <i />
            <b ref={hoverTextRef}>{formatPinTimecode(0)}</b>
          </span>
          <span className="vp-playhead" aria-hidden="true">
            <i />
          </span>
        </div>
        {/* Transport */}
        <div className="vp-row">
          <button
            type="button"
            className="vc-play"
            onClick={togglePlay}
            title={playing ? t('暂停 (Space)') : t('播放 (Space)')}
            aria-label={playing ? t('暂停') : t('播放')}
          >
            <span className="vp-swap" key={playing ? 'pause' : 'play'}>
              <Icon name={playing ? 'pause' : 'play'} size={16} />
            </span>
          </button>
          {compact < 2 && (
            <>
              <button
                type="button"
                className="vc-icon-btn"
                onClick={() => stepFrame(-1)}
                title={t('上一帧 (←)')}
                aria-label={t('上一帧')}
              >
                <Icon name="stepBack" size={16} />
              </button>
              <button
                type="button"
                className="vc-icon-btn"
                onClick={() => stepFrame(1)}
                title={t('下一帧 (→)')}
                aria-label={t('下一帧')}
              >
                <Icon name="stepForward" size={16} />
              </button>
            </>
          )}
          <span className="vc-timecode" aria-live="off">
            <span ref={timeTextRef}>{formatVideoTimecode(currentTime, fps)}</span>
            {compact < 2 && <em> / {formatVideoTimecode(effectiveDuration, fps)}</em>}
          </span>
          <span className="vp-grow" />
          <Select
            className="vc-select"
            aria-label={t('播放倍速')}
            title={t('播放倍速')}
            value={String(rate)}
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
            aria-pressed={loop}
            title={t('循环播放')}
            aria-label={t('循环播放')}
            onClick={() => setLoop((prev) => !prev)}
          >
            <Icon name="repeat" size={16} />
          </button>
          <button
            type="button"
            className="vc-icon-btn"
            aria-pressed={muted}
            title={muted ? t('取消静音 (M)') : t('静音 (M)')}
            aria-label={muted ? t('取消静音') : t('静音')}
            onClick={() => setMuted((prev) => !prev)}
          >
            <span className="vp-swap" key={muted || volume === 0 ? 'off' : 'on'}>
              <Icon name={muted || volume === 0 ? 'speakerOff' : 'speaker'} size={16} />
            </span>
          </button>
          {compact === 0 && (
            <VideoRange
              className="vp-volume"
              step={0.05}
              value={muted ? 0 : volume}
              aria-label={t('音量')}
              onChange={(next) => {
                setVolume(next);
                if (next > 0 && muted) setMuted(false);
              }}
            />
          )}
          <button
            type="button"
            className="vc-icon-btn"
            title={fullscreenLabel}
            aria-label={fullscreenLabel}
            onClick={toggleFullscreen}
          >
            <span className="vp-swap" key={fullscreen ? 'exit' : 'enter'}>
              <Icon name={fullscreen ? 'shrink' : 'expand'} size={16} />
            </span>
          </button>
        </div>
        {/* Quick edit: while trimming, the tools cross-fade to the range, the format and the export. */}
        <div className="vp-row vp-tools" role="toolbar" aria-label={t('视频快速剪辑')}>
          <button
            type="button"
            className="vc-btn"
            aria-pressed={trimActive}
            disabled={Boolean(busyAction)}
            onClick={toggleTrimMode}
          >
            <Icon name="scissors" size={15} />
            <span>{t('裁剪')}</span>
          </button>
          <div className="vp-tools-swap">
            <div className="vp-tools-set" data-off={trimActive || undefined} inert={trimActive}>
              <button
                type="button"
                className="vc-btn"
                disabled={Boolean(busyAction) || !source}
                aria-busy={busyAction === 'remove_silence' || undefined}
                title={
                  totalSilenceSec > 0
                    ? t('检测到 {count} 处静音，共 {sec} 秒', {
                        count: silences.length,
                        sec: totalSilenceSec.toFixed(1),
                      })
                    : t('自动检测并移除静音停顿')
                }
                onClick={handleRemoveSilence}
              >
                {busyAction === 'remove_silence' ? (
                  <i className="vc-spinner" aria-hidden="true" />
                ) : (
                  <Icon name="waveform" size={15} />
                )}
                <span className={compact >= 2 ? 'vp-label-hidden' : undefined}>
                  {busyAction === 'remove_silence' ? t('去静音中…') : t('一键去静音')}
                </span>
                {totalSilenceSec >= 0.3 && <em className="vc-badge">-{totalSilenceSec.toFixed(1)}s</em>}
              </button>
              <button
                type="button"
                className="vc-btn"
                disabled={Boolean(busyAction)}
                aria-busy={busyAction === 'capture_frame' || undefined}
                title={compact >= 1 ? t('截取当前帧') : undefined}
                onClick={() => void handleCaptureFrame()}
              >
                {busyAction === 'capture_frame' ? (
                  <i className="vc-spinner" aria-hidden="true" />
                ) : (
                  <Icon name="camera" size={15} />
                )}
                <span className={compact >= 1 ? 'vp-label-hidden' : undefined}>
                  {busyAction === 'capture_frame' ? t('截取中…') : t('截取当前帧')}
                </span>
              </button>
              <span className="vp-grow" />
              <button
                type="button"
                className="vc-btn is-quiet"
                disabled={Boolean(busyAction) || !source}
                aria-busy={busyAction === 'promote_to_project' || undefined}
                title={compact >= 1 ? t('打开多轨编辑器') : undefined}
                onClick={handleOpenStudio}
              >
                {busyAction === 'promote_to_project' ? (
                  <i className="vc-spinner" aria-hidden="true" />
                ) : (
                  <Icon name="timeline" size={15} />
                )}
                <span className={compact >= 1 ? 'vp-label-hidden' : undefined}>
                  {busyAction === 'promote_to_project' ? t('正在打开…') : t('打开多轨编辑器')}
                </span>
              </button>
            </div>
            <div className="vp-tools-set" data-off={!trimActive || undefined} inert={!trimActive}>
              {compact < 2 && (
                <span className="vc-timecode">
                  {formatPinTimecode(trimIn)} – {formatPinTimecode(trimEnd)}
                  {compact < 1 && <em> · {t('{seconds} 秒', { seconds: selectedRangeSec.toFixed(1) })}</em>}
                </span>
              )}
              <span className="vp-grow" />
              <div className="vc-seg is-sm" role="group" aria-label={t('导出格式')}>
                {(['mp4', 'webm'] as const).map((format) => (
                  <button
                    key={format}
                    type="button"
                    aria-pressed={trimFormat === format}
                    disabled={Boolean(busyAction)}
                    onClick={() => setTrimFormat(format)}
                  >
                    {format === 'mp4' ? 'MP4' : 'WebM'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="vc-btn is-ink"
                disabled={Boolean(busyAction) || selectedRangeSec < MIN_TRIM_SEC - 1e-6}
                aria-busy={busyAction === 'trim' || undefined}
                onClick={handleTrimExport}
              >
                {busyAction === 'trim' && <i className="vc-spinner" aria-hidden="true" />}
                {busyAction === 'trim' ? t('导出中…') : t('导出裁剪片段')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
