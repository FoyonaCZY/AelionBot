// The message box: + for photos and files (a panel where the keyboard would be), the field with the microphone, and
// one round button to send or to stop the Bot. Voice is transcribed by the computer's speech service and lands in the
// field to be read before sending. Written while the computer is offline, text waits on the phone.
import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '../../../shared/types/attachment-types';
import { useI18n } from '../../../src/i18n';
import { connection, useConnection } from '../connection';
import { uploadFile } from '../files';
import { I } from '../icons';
import { Spinner, toast } from '../ui';

interface Draft {
  key: string;
  name: string;
  preview?: string;
  attachment?: Attachment;
  failed?: boolean;
}

export function Composer({
  scope,
  running,
  onStop,
  reply,
  onClearReply,
  placeholder,
}: {
  scope: { kind: 'bot' | 'group'; id: string; sessionId?: string };
  running?: boolean;
  onStop?: () => void;
  reply?: { messageId: string; text: string };
  onClearReply?: () => void;
  placeholder: string;
}) {
  const { t } = useI18n();
  const { status, home } = useConnection();
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [panel, setPanel] = useState(false);
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const camera = useRef<HTMLInputElement>(null),
    photos = useRef<HTMLInputElement>(null),
    files = useRef<HTMLInputElement>(null);
  const recorder = useVoice((transcript) => setText((value) => (value ? value + ' ' : '') + transcript));
  const online = status === 'ready';
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = Math.min(node.scrollHeight, 160) + 'px';
  }, [text]);

  const add = (list: FileList | null) => {
    setPanel(false);
    for (const file of Array.from(list || []).slice(0, 10)) {
      const key = crypto.randomUUID();
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      setDrafts((items) => [...items, { key, name: file.name, preview }]);
      uploadFile(scope, file).then(
        (attachment) => setDrafts((items) => items.map((item) => (item.key === key ? { ...item, attachment } : item))),
        (error: Error) => {
          toast(error.message);
          setDrafts((items) => items.map((item) => (item.key === key ? { ...item, failed: true } : item)));
        },
      );
    }
  };
  const uploading = drafts.some((item) => !item.attachment && !item.failed);
  const ready = drafts.filter((item) => item.attachment);
  const canSend = Boolean(text.trim() || ready.length) && !uploading && !sending;

  const send = async () => {
    if (!canSend) return;
    const message = text.trim();
    if (!online) {
      if (scope.kind !== 'bot') return toast(t('电脑离线，群聊消息要等它上线再发'));
      if (ready.length) return toast(t('电脑离线，只能先保存文字'));
      await connection.enqueue({
        botId: scope.id,
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
        text: message,
      });
      setText('');
      return;
    }
    setSending(true);
    try {
      const attachmentIds = ready.map((item) => item.attachment!.id);
      if (scope.kind === 'group')
        await connection.call('group.send', {
          id: scope.id,
          message,
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(reply ? { replyToMessageId: reply.messageId } : {}),
        });
      else
        await connection.call('chat.send', {
          botId: scope.id,
          ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
          message,
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(reply ? { replyToMessageId: reply.messageId } : {}),
        });
      setText('');
      setDrafts([]);
      onClearReply?.();
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (recorder.recording || recorder.transcribing)
    return (
      <div className="c-foot">
        <div className="c-voice">
          <button className="c-plus" aria-label={t('取消')} onClick={recorder.cancel}>
            <I name="close" size={20} />
          </button>
          {recorder.transcribing ? (
            <span className="c-voice-wait">
              <Spinner small /> {t('正在识别…')}
            </span>
          ) : (
            <>
              <span className="c-rec-dot" />
              <span className="c-wave">
                {recorder.levels.map((level, index) => (
                  <i key={index} style={{ height: 4 + level * 26 }} />
                ))}
              </span>
              <span className="c-rec-time">{recorder.seconds}″</span>
            </>
          )}
          <button className="c-send" aria-label={t('完成')} disabled={recorder.transcribing} onClick={recorder.stop}>
            <I name="check" size={22} stroke={2.4} />
          </button>
        </div>
      </div>
    );

  return (
    <>
      <div className={'c-foot' + (panel ? ' is-raised' : '')}>
        {reply && (
          <div className="c-reply">
            <span>{reply.text.slice(0, 80)}</span>
            <button aria-label={t('取消引用')} onClick={onClearReply}>
              <I name="close" size={14} stroke={2.4} />
            </button>
          </div>
        )}
        <div className="c-composer">
          <button className="c-plus" aria-label={t('添加图片或文件')} onClick={() => setPanel(!panel)}>
            <I name={panel ? 'close' : 'plus'} size={24} stroke={2} />
          </button>
          <div className={'c-field' + (drafts.length ? ' has-files' : '')}>
            {drafts.length > 0 && (
              <div className="c-drafts">
                {drafts.map((item) => (
                  <span key={item.key} className={'c-draft' + (item.failed ? ' is-failed' : '')}>
                    {item.preview ? (
                      <img src={item.preview} alt="" />
                    ) : (
                      <span className="c-draft-name">{item.name}</span>
                    )}
                    {!item.attachment && !item.failed && (
                      <span className="c-draft-wait">
                        <Spinner small />
                      </span>
                    )}
                    <button
                      aria-label={t('移除')}
                      onClick={() => setDrafts((items) => items.filter((entry) => entry.key !== item.key))}
                    >
                      <I name="close" size={11} stroke={2.6} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="c-field-row">
              <textarea
                ref={field}
                rows={1}
                value={text}
                placeholder={online ? placeholder : t('电脑上线后发送')}
                onChange={(event) => setText(event.target.value)}
                onFocus={() => setPanel(false)}
              />
              {!text && home?.speech.input && online && (
                <button className="c-mic" aria-label={t('语音输入')} onClick={recorder.start}>
                  <I name="mic" size={22} />
                </button>
              )}
            </div>
          </div>
          {canSend ? (
            <button className="c-send" aria-label={t('发送')} onClick={() => void send()}>
              {sending ? <Spinner small /> : <I name="up" size={22} stroke={2.4} />}
            </button>
          ) : running && onStop ? (
            <button className="c-send" aria-label={t('停止')} onClick={onStop}>
              <I name="stop" size={22} />
            </button>
          ) : null}
        </div>
      </div>
      {panel && (
        <div className="c-panel">
          <div className="c-tiles">
            <button onClick={() => camera.current?.click()}>
              <I name="camera" size={26} />
              {t('拍照')}
            </button>
            <button onClick={() => photos.current?.click()}>
              <I name="photo" size={26} />
              {t('照片')}
            </button>
            <button onClick={() => files.current?.click()}>
              <I name="file" size={26} />
              {t('文件')}
            </button>
          </div>
          <p className="c-panel-note">{t('单个文件不超过 25 MB；大照片会先压缩再发送。')}</p>
        </div>
      )}
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => add(event.target.files)}
      />
      <input
        ref={photos}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(event) => add(event.target.files)}
      />
      <input ref={files} type="file" multiple hidden onChange={(event) => add(event.target.files)} />
    </>
  );
}

/** Records from the microphone, shows its level, and transcribes on the computer when done. */
function useVoice(done: (text: string) => void) {
  const { t } = useI18n();
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [levels, setLevels] = useState<number[]>(() => Array(28).fill(0));
  const [seconds, setSeconds] = useState(0);
  const session = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    cancelled: boolean;
    stopMeter(): void;
  }>(undefined);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((item) =>
        MediaRecorder.isTypeSupported(item),
      );
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      // The level meter: louder speech, taller bars.
      const audio = new AudioContext(),
        analyser = audio.createAnalyser();
      audio.createMediaStreamSource(stream).connect(analyser);
      analyser.fftSize = 256;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const began = Date.now();
      const meter = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
        setLevels((items) => [...items.slice(1), Math.min(1, peak * 2.2)]);
        setSeconds(Math.floor((Date.now() - began) / 1000));
      }, 90);
      const current = {
        recorder,
        stream,
        chunks,
        cancelled: false,
        stopMeter: () => {
          clearInterval(meter);
          void audio.close();
        },
      };
      session.current = current;
      recorder.onstop = async () => {
        current.stopMeter();
        for (const track of stream.getTracks()) track.stop();
        setRecording(false);
        if (current.cancelled || !chunks.length) return;
        setTranscribing(true);
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType });
          const { text } = await connection.call('speech.transcribe', {
            audio: new Uint8Array(await blob.arrayBuffer()),
            name: recorder.mimeType.includes('mp4') ? 'voice.m4a' : 'voice.webm',
          });
          if (text.trim()) done(text.trim());
          else toast(t('没有听清，请再说一次'));
        } catch (error) {
          toast((error as Error).message);
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start(500);
      setSeconds(0);
      setRecording(true);
    } catch {
      toast(t('无法使用麦克风，请在系统设置里允许'));
    }
  };
  return {
    recording,
    transcribing,
    levels,
    seconds,
    start: () => void start(),
    stop: () => session.current?.recorder.state === 'recording' && session.current.recorder.stop(),
    cancel: () => {
      if (session.current) {
        session.current.cancelled = true;
        if (session.current.recorder.state === 'recording') session.current.recorder.stop();
      }
      setTranscribing(false);
    },
  };
}
