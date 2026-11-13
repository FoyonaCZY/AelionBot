// Whether speech recognition and synthesis are set up, for controls deep in the timeline and the composer that
// should only appear when they work. The app sets it from each snapshot.
import { useEffect, useSyncExternalStore } from 'react';
import type { SpeechSettings } from '../../shared/types/speech-types';

let available = { input: false, output: false };
const listeners = new Set<() => void>();

/** Keeps the availability in step with the settings of the current snapshot. */
export function useSpeechSettingsSync(settings: SpeechSettings | undefined) {
  const input = Boolean(settings?.input),
    output = Boolean(settings?.output);
  useEffect(() => {
    if (available.input === input && available.output === output) return;
    available = { input, output };
    listeners.forEach((listener) => listener());
  }, [input, output]);
}

export function useSpeechAvailable(kind: 'input' | 'output') {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => available[kind],
  );
}
