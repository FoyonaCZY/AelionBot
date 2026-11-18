// What the computer is playing, as a spectrum for visuals that move with it (the conversation rail). Only levels
// are read, frame by frame; nothing is recorded or kept. The main process answers the page's getDisplayMedia with the
// system's audio (electron/windows/system-audio.ts); the video every such capture carries is stopped at once.
import { useEffect, useSyncExternalStore } from 'react';

/** off: nobody listens. live: levels arrive. unavailable: the system gave no audio (permission, platform). */
type SystemAudioState = 'off' | 'starting' | 'live' | 'unavailable';

/** How long the capture outlives its last user, so switching chats does not stop and restart it. */
const LINGER_MS = 3000;

let state: SystemAudioState = 'off';
const listeners = new Set<() => void>();
function publish(next: SystemAudioState) {
  if (state === next) return;
  state = next;
  listeners.forEach((listener) => listener());
}

let users = 0,
  attempt = 0,
  stopTimer: ReturnType<typeof setTimeout> | undefined,
  waitingForGesture: (() => void) | undefined;
let capture:
  { stream: MediaStream; context: AudioContext; analyser: AnalyserNode; bins: Uint8Array<ArrayBuffer> } | undefined;

function stop() {
  attempt++;
  waitingForGesture?.();
  if (capture) {
    capture.stream.getTracks().forEach((track) => track.stop());
    void capture.context.close().catch(() => {});
    capture = undefined;
  }
}

async function start(afterGesture = false) {
  const current = ++attempt;
  publish('starting');
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1, frameRate: 1 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
      selfBrowserSurface: 'include',
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions);
  } catch {
    if (current !== attempt) return;
    // Chromium may want the page to have been clicked first; try once more on the next click or key.
    if (!afterGesture) return retryOnGesture(current);
    return publish('unavailable');
  }
  stream.getVideoTracks().forEach((track) => {
    track.stop();
    stream.removeTrack(track);
  });
  const track = stream.getAudioTracks()[0];
  if (current !== attempt || !track || track.readyState === 'ended') {
    stream.getTracks().forEach((item) => item.stop());
    if (current === attempt) publish('unavailable');
    return;
  }
  const context = new AudioContext(),
    analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.7;
  // Into the analyser only, never back out to the speakers.
  context.createMediaStreamSource(stream).connect(analyser);
  void context.resume().catch(() => {});
  capture = { stream, context, analyser, bins: new Uint8Array(analyser.frequencyBinCount) };
  track.addEventListener('ended', () => {
    if (capture?.stream !== stream) return;
    stop();
    publish('unavailable');
  });
  publish('live');
}

function retryOnGesture(current: number) {
  const retry = () => {
    waitingForGesture?.();
    if (current === attempt && users > 0 && !document.hidden) void start(true);
  };
  waitingForGesture = () => {
    window.removeEventListener('pointerdown', retry, true);
    window.removeEventListener('keydown', retry, true);
    waitingForGesture = undefined;
  };
  window.addEventListener('pointerdown', retry, true);
  window.addEventListener('keydown', retry, true);
}

// Hidden or minimized, the window has nothing to move; the capture (and the system's recording indicator) stops.
const onVisibility = () => {
  if (users === 0) return;
  if (document.hidden) {
    stop();
    publish('off');
  } else if (!capture && state !== 'unavailable') void start();
};

function acquire() {
  users++;
  clearTimeout(stopTimer);
  if (users === 1) document.addEventListener('visibilitychange', onVisibility);
  if (!capture && state !== 'starting' && !document.hidden) void start();
}
function release() {
  users = Math.max(0, users - 1);
  if (users > 0) return;
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    if (users > 0) return;
    document.removeEventListener('visibilitychange', onVisibility);
    stop();
    publish('off');
  }, LINGER_MS);
}

/** Listens to the computer's sound while `enabled`; returns how that is going. */
export function useSystemAudio(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    acquire();
    return release;
  }, [enabled]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** The spectrum now: one byte per frequency band, low to high; undefined while nothing is captured. */
export function systemAudioSpectrum() {
  if (!capture) return undefined;
  capture.analyser.getByteFrequencyData(capture.bins);
  return { bins: capture.bins, sampleRate: capture.context.sampleRate };
}
