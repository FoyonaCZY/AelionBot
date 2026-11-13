// Reading text aloud in the app: one reading at a time, in pieces, the next one synthesized while the current plays,
// so a long reply starts speaking within a few seconds.
import { useSyncExternalStore } from 'react';
import { speechChunks, spokenText } from '../../shared/speech/speech-text';
import { ipcErrorText } from '../ui/ipc-error';

/** Short first piece so speech starts soon, then pieces long enough to sound natural. */
const FIRST_CHARS = 120;
const CHUNK_CHARS = 600;

export interface Reading {
  /** What is read, such as a message ID. */
  key: string;
  phase: 'loading' | 'playing';
}
let snapshot: Reading | undefined;
let stopCurrent: (() => void) | undefined;
const listeners = new Set<() => void>();
function publish(next: Reading | undefined) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** Stops whatever is being read. */
export function stopSpeaking() {
  stopCurrent?.();
  stopCurrent = undefined;
  publish(undefined);
}

/** Reads the text aloud, in the Bot's voice when one is given. A newer reading stops this one. */
export function speak(
  key: string,
  text: string,
  options: { botId?: string; onError?: (message: string) => void } = {},
) {
  stopSpeaking();
  const pieces = speechChunks(spokenText(text), CHUNK_CHARS, FIRST_CHARS);
  if (!pieces.length) return;
  let stopped = false,
    audio: HTMLAudioElement | undefined,
    url = '';
  const release = () => {
    audio?.pause();
    if (url) URL.revokeObjectURL(url);
    url = '';
  };
  const stop = () => {
    stopped = true;
    release();
  };
  stopCurrent = stop;
  publish({ key, phase: 'loading' });
  const fetchPiece = (piece: string) => window.aelion.synthesizeSpeech({ text: piece, botId: options.botId });
  void (async () => {
    try {
      let next = fetchPiece(pieces[0]);
      for (let index = 0; index < pieces.length; index++) {
        const { audio: bytes, mime } = await next;
        if (stopped) return;
        if (index + 1 < pieces.length) next = fetchPiece(pieces[index + 1]);
        release();
        url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
        const player = new Audio(url);
        audio = player;
        if (snapshot?.phase !== 'playing') publish({ key, phase: 'playing' });
        await new Promise<void>((resolve, reject) => {
          player.onended = () => resolve();
          player.onpause = () => stopped && resolve();
          player.onerror = () => reject(new Error('这段语音无法播放'));
          player.play().catch(reject);
        });
        if (stopped) return;
      }
    } catch (error) {
      if (!stopped) options.onError?.(ipcErrorText(error));
    } finally {
      release();
      if (stopCurrent === stop) {
        stopCurrent = undefined;
        publish(undefined);
      }
    }
  })();
}

/** What is being read now, for buttons that start and stop it. */
export function useSpeaking() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
