import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TEACHING_LIMITS,
  type TeachingClientEvent,
  type TeachingClientKeyframe,
  type TeachingDraft,
  type TeachingListWindowsResult,
  type TeachingNarrationSegment,
  type TeachingSessionInfo,
  type TeachingTarget,
} from '../../shared/types/teaching-types';
import type { VncTeachingBridge } from '../ui/Vnc';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';

export type TeachingPhase = 'idle' | 'setup' | 'recording' | 'finishing' | 'review' | 'sending';

interface MicRecorderHandle {
  recorder: MediaRecorder;
  stream: MediaStream;
  parts: Blob[];
  stopPromise: Promise<Uint8Array | undefined>;
}

const MAX_SECONDS = Math.floor(TEACHING_LIMITS.maxDurationMs / 1000);
const MAX_CLIENT_KEYFRAMES = 24;
const VM_WINDOW_POLL_MIN_MS = 1200;

export function useTeaching({
  vmReady,
  desktopAvailable,
  onOpenComputer,
  onCloseComputer,
  onError,
  onNotify,
}: {
  vmReady: boolean;
  desktopAvailable: boolean;
  onOpenComputer: (botId: string) => void;
  onCloseComputer: () => Promise<void>;
  onError: (message: string) => void;
  onNotify: (message: string) => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<TeachingPhase>('idle');
  const [context, setContext] = useState<{ botId: string; botName: string; chatSessionId?: string }>();
  const [hostWindows, setHostWindows] = useState<TeachingListWindowsResult>({ available: false, windows: [] });
  const [loadingWindows, setLoadingWindows] = useState(false);
  const [session, setSession] = useState<TeachingSessionInfo>();
  const [seconds, setSeconds] = useState(0);
  const [stepCount, setStepCount] = useState(0);
  const [micActive, setMicActive] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [draft, setDraft] = useState<TeachingDraft>();

  const micRef = useRef<MicRecorderHandle | undefined>(undefined);
  const sessionRef = useRef<TeachingSessionInfo | undefined>(undefined);
  sessionRef.current = session;
  const startedAtRef = useRef(0);
  const vmEventsRef = useRef<TeachingClientEvent[]>([]);
  const vmKeyframesRef = useRef<TeachingClientKeyframe[]>([]);
  const vmWindowTitleRef = useRef<string | undefined>(undefined);
  const vmWindowQueryAtRef = useRef(0);
  const finishingRef = useRef(false);

  const handlersRef = useRef({ onOpenComputer, onCloseComputer, onError, onNotify });
  handlersRef.current = { onOpenComputer, onCloseComputer, onError, onNotify };

  const releaseMic = useCallback(() => {
    const handle = micRef.current;
    if (!handle) return;
    micRef.current = undefined;
    handle.stream.getTracks().forEach((track) => track.stop());
  }, []);

  const stopMic = useCallback(
    async (discard: boolean): Promise<Uint8Array | undefined> => {
      const handle = micRef.current;
      if (!handle) return undefined;
      if (handle.recorder.state !== 'inactive') handle.recorder.stop();
      const audio = await handle.stopPromise.catch(() => undefined);
      releaseMic();
      return discard ? undefined : audio;
    },
    [releaseMic],
  );

  const startMic = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const parts: Blob[] = [];
      const stopPromise = new Promise<Uint8Array | undefined>((resolve) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size) parts.push(event.data);
        };
        recorder.onstop = async () => {
          if (!parts.length) return resolve(undefined);
          try {
            resolve(new Uint8Array(await new Blob(parts).arrayBuffer()));
          } catch {
            resolve(undefined);
          }
        };
        recorder.onerror = () => resolve(undefined);
      });
      micRef.current = { recorder, stream, parts, stopPromise };
      recorder.start(1000);
      return true;
    } catch {
      handlersRef.current.onError(t('没能打开麦克风，本次将仅记录操作步骤'));
      return false;
    }
  }, [t]);

  const refreshHostWindows = useCallback(async () => {
    if (!window.aelion?.teachingListWindows) return;
    setLoadingWindows(true);
    try {
      setHostWindows(await window.aelion.teachingListWindows());
    } catch (error) {
      handlersRef.current.onError(ipcErrorText(error));
    } finally {
      setLoadingWindows(false);
    }
  }, []);

  const openSetup = useCallback(
    (botId: string, botName: string, chatSessionId?: string) => {
      if (phase !== 'idle') return;
      setContext({ botId, botName, chatSessionId });
      setPhase('setup');
      void refreshHostWindows();
    },
    [phase, refreshHostWindows],
  );

  const closeSetup = useCallback(() => {
    if (phase === 'setup') setPhase('idle');
  }, [phase]);

  const finish = useCallback(async () => {
    const active = sessionRef.current;
    if (!active || finishingRef.current) return;
    finishingRef.current = true;
    setPhase('finishing');
    try {
      const audio = await stopMic(false);
      if (active.target === 'vm') {
        await handlersRef.current.onCloseComputer().catch(() => {});
      }
      const durationMs = Math.max(0, Date.now() - startedAtRef.current);
      const result = await window.aelion.teachingFinish({
        sessionId: active.sessionId,
        durationMs,
        ...(audio?.byteLength ? { audio } : {}),
        ...(active.target === 'vm' ? { events: vmEventsRef.current, keyframes: vmKeyframesRef.current } : {}),
      });
      setSession(undefined);
      setMicActive(false);
      setMicMuted(false);
      setDraft(result);
      setPhase('review');
    } catch (error) {
      setSession(undefined);
      setMicActive(false);
      setMicMuted(false);
      setPhase('idle');
      handlersRef.current.onError(ipcErrorText(error));
    } finally {
      vmEventsRef.current = [];
      vmKeyframesRef.current = [];
      vmWindowTitleRef.current = undefined;
      finishingRef.current = false;
    }
  }, [stopMic]);

  const start = useCallback(
    async (options: { target: TeachingTarget; windowId?: number | null; withMic: boolean }) => {
      if (!context) return;
      if (options.target === 'vm' && (!vmReady || !desktopAvailable)) {
        handlersRef.current.onError(t('请先启动工作电脑，再进行工作电脑演示'));
        return;
      }
      try {
        vmEventsRef.current = [];
        vmKeyframesRef.current = [];
        vmWindowTitleRef.current = undefined;
        vmWindowQueryAtRef.current = 0;

        if (options.target === 'vm') {
          await window.aelion.ensureComputerDesktop(context.botId);
          await window.aelion.setComputerControl({ botId: context.botId, enabled: true });
        }

        const started = await window.aelion.teachingStart({
          botId: context.botId,
          ...(context.chatSessionId ? { chatSessionId: context.chatSessionId } : {}),
          target: options.target,
          ...(options.target === 'host' && options.windowId != null ? { windowId: options.windowId } : {}),
        });

        const micOn = options.withMic ? await startMic() : false;
        startedAtRef.current = Date.now();
        setSession(started);
        setSeconds(0);
        setStepCount(started.stepCount);
        setMicActive(micOn);
        setMicMuted(false);
        setPhase('recording');

        if (options.target === 'vm') {
          handlersRef.current.onOpenComputer(context.botId);
        }
      } catch (error) {
        await stopMic(true);
        if (options.target === 'vm') {
          await window.aelion.setComputerControl({ botId: context.botId, enabled: false }).catch(() => {});
        }
        handlersRef.current.onError(ipcErrorText(error));
      }
    },
    [context, vmReady, desktopAvailable, startMic, stopMic, t],
  );

  const cancel = useCallback(async () => {
    const active = sessionRef.current;
    const currentDraft = draft;
    await stopMic(true);
    if (active?.target === 'vm') {
      await handlersRef.current.onCloseComputer().catch(() => {});
    }
    const id = active?.sessionId || currentDraft?.draftId;
    setSession(undefined);
    setDraft(undefined);
    setMicActive(false);
    setMicMuted(false);
    setPhase('idle');
    vmEventsRef.current = [];
    vmKeyframesRef.current = [];
    vmWindowTitleRef.current = undefined;
    if (id) await window.aelion.teachingCancel(id).catch(() => {});
  }, [draft, stopMic]);

  const toggleMute = useCallback(() => {
    const handle = micRef.current;
    if (!handle) return;
    setMicMuted((prev) => {
      const next = !prev;
      handle.stream.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      return next;
    });
  }, []);

  const sendDraft = useCallback(
    async (input: {
      title: string;
      notes: string;
      narration: TeachingNarrationSegment[];
      selectedKeyframeIds: string[];
    }) => {
      if (!draft) return;
      setPhase('sending');
      try {
        await window.aelion.teachingSend({
          draftId: draft.draftId,
          title: input.title,
          notes: input.notes,
          narration: input.narration,
          selectedKeyframeIds: input.selectedKeyframeIds,
        });
        setDraft(undefined);
        setPhase('idle');
        handlersRef.current.onNotify(t('已将演示时间轴交给 Bot 学习技能'));
      } catch (error) {
        setPhase('review');
        handlersRef.current.onError(ipcErrorText(error));
      }
    },
    [draft, t],
  );

  // Elapsed timer & host step polling while recording.
  useEffect(() => {
    if (phase !== 'recording' || !session) return;
    const tick = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) void finish();
    }, 250);
    const poll =
      session.target === 'host'
        ? window.setInterval(() => {
            void window.aelion
              .teachingStatus(session.sessionId)
              .then((info) => {
                if (info) setStepCount(info.stepCount);
              })
              .catch(() => {});
          }, 600)
        : undefined;
    return () => {
      window.clearInterval(tick);
      if (poll !== undefined) window.clearInterval(poll);
    };
  }, [phase, session, finish]);

  // Clean up microphone & active backend session on unmount.
  useEffect(
    () => () => {
      releaseMic();
      if (sessionRef.current) void window.aelion?.teachingCancel(sessionRef.current.sessionId).catch(() => {});
    },
    [releaseMic],
  );

  const vncBridge = useMemo<VncTeachingBridge | undefined>(() => {
    if (phase !== 'recording' || session?.target !== 'vm') return undefined;
    return {
      active: true,
      startedAt: startedAtRef.current,
      windowTitle: () => vmWindowTitleRef.current,
      refreshWindowTitle: () => {
        const now = Date.now();
        if (now - vmWindowQueryAtRef.current < VM_WINDOW_POLL_MIN_MS) return;
        vmWindowQueryAtRef.current = now;
        void window.aelion
          .teachingVmWindow(session.sessionId)
          .then((result) => {
            if (result.title) vmWindowTitleRef.current = result.title;
          })
          .catch(() => {});
      },
      onEvent: (event) => {
        if (vmEventsRef.current.length >= TEACHING_LIMITS.maxClientEvents) return;
        vmEventsRef.current.push(event);
        setStepCount(vmEventsRef.current.length);
      },
      onKeyframe: (frame) => {
        const list = vmKeyframesRef.current;
        if (list.length >= MAX_CLIENT_KEYFRAMES) {
          // Thin out the second-oldest frame so start and recent actions are always preserved.
          list.splice(1, 1);
        }
        list.push(frame);
      },
    };
  }, [phase, session]);

  return {
    phase,
    context,
    hostWindows,
    loadingWindows,
    session,
    seconds,
    stepCount,
    micActive,
    micMuted,
    draft,
    vncBridge,
    openSetup,
    closeSetup,
    refreshHostWindows,
    start,
    finish,
    cancel,
    toggleMute,
    sendDraft,
  };
}
