// Speaking into the composer: record from the microphone, then turn the recording into text with the speech
// recognition chosen in settings. The text is handed back for the person to read and send; nothing is sent by itself.
import { useEffect, useRef, useState } from 'react';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';

/** A spoken message rarely needs more; the recording stops by itself here. */
const MAX_SECONDS = 5 * 60;

export type VoiceInputPhase = 'idle' | 'recording' | 'transcribing';

export function useVoiceInput({
  onText,
  onError,
}: {
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<VoiceInputPhase>('idle'),
    [seconds, setSeconds] = useState(0);
  const recording = useRef<
      { recorder: MediaRecorder; stream: MediaStream; cancelled: boolean; timer: number } | undefined
    >(undefined),
    handlers = useRef({ onText, onError });
  handlers.current = { onText, onError };
  const release = () => {
    const current = recording.current;
    if (!current) return;
    window.clearInterval(current.timer);
    current.stream.getTracks().forEach((track) => track.stop());
    recording.current = undefined;
  };
  useEffect(
    () => () => {
      if (recording.current) {
        recording.current.cancelled = true;
        if (recording.current.recorder.state !== 'inactive') recording.current.recorder.stop();
      }
      release();
    },
    [],
  );
  const start = async () => {
    if (phase !== 'idle') return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      handlers.current.onError(t('没能打开麦克风，请检查系统的麦克风权限'));
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' }),
      parts: Blob[] = [],
      started = Date.now();
    const current = {
      recorder,
      stream,
      cancelled: false,
      timer: window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS && recorder.state === 'recording') recorder.stop();
      }, 250),
    };
    recording.current = current;
    recorder.ondataavailable = (event) => event.data.size && parts.push(event.data);
    recorder.onstop = async () => {
      release();
      if (current.cancelled || !parts.length) return setPhase('idle');
      setPhase('transcribing');
      try {
        const audio = new Uint8Array(await new Blob(parts).arrayBuffer());
        const { text } = await window.aelion.transcribeSpeech({ audio });
        if (text.trim()) handlers.current.onText(text.trim());
        else handlers.current.onError(t('没有听清说了什么，请再说一次'));
      } catch (error) {
        handlers.current.onError(ipcErrorText(error));
      } finally {
        setPhase('idle');
      }
    };
    setSeconds(0);
    setPhase('recording');
    recorder.start(1000);
  };
  const finish = () => {
    if (recording.current?.recorder.state === 'recording') recording.current.recorder.stop();
  };
  const cancel = () => {
    if (!recording.current) return;
    recording.current.cancelled = true;
    finish();
  };
  return { phase, seconds, start, finish, cancel };
}
