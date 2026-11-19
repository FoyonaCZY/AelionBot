// Speech recognition and synthesis with the provider and model chosen in settings. Recordings are decoded to 16 kHz
// mono and sent in pieces each protocol accepts; long text is read in pieces and the audio joined into one file.
import { AppError } from '../../../shared/errors';
import { SPEECH_RECORDING_LIMIT } from '../../../shared/types/speech-types';
import { speechChunks, spokenText } from '../../../shared/speech/speech-text';
import { clock, closeWav, oggOpus, readWav, speechPieces, wavFile, type OpusPackets, type Pcm } from './speech-audio';
import { recognize, speak, SPEECH_LIMITS, type SpeechAccess } from './speech-protocols';
import { speechSegments, type SpeechSegmentOptions } from './speech-timeline';

interface SpeechTimelineSegment {
  startMs: number;
  endMs: number;
  clock: string;
  text: string;
}
interface SpeechTimelineResult {
  segments: SpeechTimelineSegment[];
  text: string;
  seconds: number;
}

/** Decoding and encoding with the system's codecs; absent in the command-line app. */
export interface AudioCodecs {
  /** Any audio or video the system plays, as mono samples at `sampleRate`, 16 kHz unless given. */
  decode(bytes: Buffer, signal: AbortSignal, sampleRate?: number): Promise<Pcm>;
  /** Any audio as mono Opus packets for a voice message. */
  encodeOpus(bytes: Buffer, signal: AbortSignal): Promise<OpusPackets>;
  /** 8 kHz mono samples as an AMR-NB file for a voice message. */
  encodeAmr(samples: Int16Array, signal: AbortSignal): Promise<Buffer>;
}
export interface SpeechProviders {
  speechAccess(kind: 'input' | 'output', botId?: string): SpeechAccess | undefined;
}
/** The audio of voice messages a chat platform takes: Ogg Opus (Feishu) or AMR-NB (WeCom). */
export type VoiceFormat = 'ogg-opus' | 'amr';
/** One voice message, ready to send. */
export interface VoiceClip {
  bytes: Buffer;
  durationMs: number;
}

const PARALLEL = 4;
/** About two and a half minutes of speech: longer replies stay text in a chat app. */
const VOICE_MESSAGE_CHARS = 600;
/** Longer audio stays a file: nobody listens to that many voice messages in a row. */
const VOICE_MESSAGE_SECONDS = 5 * 60;
/** AMR voice messages play at most a minute in WeCom, as in WeChat; longer speech goes as several. */
const AMR_CLIP_SECONDS = 60;

/** Runs `work` over the items with at most `limit` running at once, keeping their order. */
async function parallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

export class SpeechService {
  constructor(
    private providers: SpeechProviders,
    private codecs?: AudioCodecs,
  ) {}
  available(kind: 'input' | 'output') {
    return Boolean(this.providers.speechAccess(kind));
  }
  private access(kind: 'input' | 'output', botId?: string) {
    const access = this.providers.speechAccess(kind, botId);
    if (!access)
      throw new AppError(
        kind === 'input' ? 'speech.input_unset' : 'speech.output_unset',
        kind === 'input'
          ? '还没有设置语音识别，请在设置的模型分配里选择'
          : '还没有设置语音合成，请在设置的模型分配里选择',
      );
    return access;
  }
  /**
   * The words in a recording. Speech longer than one request is recognized in pieces, four at a time, each line
   * starting with the time it begins when there is more than one.
   */
  async transcribe(bytes: Buffer, signal: AbortSignal): Promise<{ text: string; seconds: number }> {
    const access = this.access('input');
    if (bytes.length > SPEECH_RECORDING_LIMIT.bytes)
      throw new AppError('speech.recording_too_large', '录音不能超过 25 MB');
    let pcm = readWav(bytes);
    if (!pcm) {
      if (!this.codecs) throw new AppError('speech.format_unsupported', '这里只能识别 16 位 PCM WAV 录音');
      pcm = await this.codecs.decode(bytes, signal);
    }
    const { samples, sampleRate } = pcm,
      seconds = samples.length / sampleRate;
    if (seconds > SPEECH_RECORDING_LIMIT.seconds)
      throw new AppError('speech.recording_too_long', '录音超过 1 小时，请分段后再识别');
    if (!samples.length) return { text: '', seconds: 0 };
    const pieces = speechPieces(samples, sampleRate, SPEECH_LIMITS[access.protocol].pieceSeconds);
    const texts = await parallel(pieces, PARALLEL, async ([start, end]) => {
      const wav = wavFile(samples.subarray(start, end), sampleRate);
      try {
        return await recognize(access, wav, signal);
      } catch (error) {
        // A moment over a concurrency limit usually clears on a second try.
        if (signal.aborted || (error as AppError).code !== 'speech.busy') throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        signal.throwIfAborted();
        return recognize(access, wav, signal);
      }
    });
    const text =
      pieces.length === 1
        ? texts[0]
        : texts
            .map((line, index) => (line ? `[${clock(pieces[index][0] / sampleRate)}] ${line}` : ''))
            .filter(Boolean)
            .join('\n');
    return { text, seconds };
  }
  /**
   * Fine-grained timestamped transcription for narrated demonstrations: splits speech on natural pauses into short
   * segments (default <= 15 s), skips pure-silence gaps so pauses cost zero ASR calls, and returns `[m:ss]` segments.
   */
  async transcribeTimeline(
    bytes: Buffer,
    signal: AbortSignal,
    options?: SpeechSegmentOptions,
  ): Promise<SpeechTimelineResult> {
    const access = this.access('input');
    if (bytes.length > SPEECH_RECORDING_LIMIT.bytes)
      throw new AppError('speech.recording_too_large', '录音不能超过 25 MB');
    let pcm = readWav(bytes);
    if (!pcm) {
      if (!this.codecs) throw new AppError('speech.format_unsupported', '这里只能识别 16 位 PCM WAV 录音');
      pcm = await this.codecs.decode(bytes, signal);
    }
    const { samples, sampleRate } = pcm,
      seconds = samples.length / sampleRate;
    if (seconds > SPEECH_RECORDING_LIMIT.seconds)
      throw new AppError('speech.recording_too_long', '录音超过 1 小时，请分段后再识别');
    if (!samples.length) return { segments: [], text: '', seconds: 0 };
    const maxSeconds = Math.min(options?.maxSeconds ?? 15, SPEECH_LIMITS[access.protocol].pieceSeconds);
    const ranges = speechSegments(samples, sampleRate, { ...options, maxSeconds });
    if (!ranges.length) return { segments: [], text: '', seconds };
    const texts = await parallel(ranges, PARALLEL, async ([start, end]) => {
      const wav = wavFile(samples.subarray(start, end), sampleRate);
      try {
        return await recognize(access, wav, signal);
      } catch (error) {
        if (signal.aborted || (error as AppError).code !== 'speech.busy') throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        signal.throwIfAborted();
        return recognize(access, wav, signal);
      }
    });
    const segments: SpeechTimelineSegment[] = [];
    for (let index = 0; index < ranges.length; index++) {
      const line = texts[index]?.trim();
      if (!line) continue;
      const [start, end] = ranges[index];
      segments.push({
        startMs: Math.round((start / sampleRate) * 1000),
        endMs: Math.round((end / sampleRate) * 1000),
        clock: clock(start / sampleRate),
        text: line,
      });
    }
    return {
      segments,
      text: segments.map((item) => `[${item.clock}] ${item.text}`).join('\n'),
      seconds,
    };
  }
  /**
   * The text read aloud in the Bot's voice, as one file. Markdown is read the way a person would say it; text
   * longer than one request is read in pieces and the audio joined.
   */
  async synthesize(text: string, signal: AbortSignal, botId?: string) {
    const access = this.access('output', botId),
      spoken = spokenText(text);
    if (!spoken) throw new AppError('speech.text_empty', '没有可以朗读的文字');
    const parts: Array<{ bytes: Buffer; mime: 'audio/wav' | 'audio/mpeg' }> = [];
    for (const chunk of speechChunks(spoken, SPEECH_LIMITS[access.protocol].textChars)) {
      signal.throwIfAborted();
      parts.push(await speak(access, chunk, signal));
    }
    if (parts[0].mime === 'audio/mpeg')
      return { bytes: Buffer.concat(parts.map((part) => part.bytes)), mime: 'audio/mpeg' as const };
    // WAV pieces become one file: their samples joined behind one header.
    const pcm = parts.map((part) => {
      const bytes = Buffer.from(part.bytes);
      closeWav(bytes);
      const read = readWav(bytes);
      if (!read) throw new AppError('speech.bad_response', '语音服务返回的不是可用的 WAV 音频');
      return read;
    });
    if (pcm.length === 1) {
      const bytes = Buffer.from(parts[0].bytes);
      closeWav(bytes);
      return { bytes, mime: 'audio/wav' as const };
    }
    const samples = new Int16Array(pcm.reduce((total, item) => total + item.samples.length, 0));
    let at = 0;
    for (const item of pcm) {
      samples.set(item.samples, at);
      at += item.samples.length;
    }
    return { bytes: wavFile(samples, pcm[0].sampleRate), mime: 'audio/wav' as const };
  }
  /** A reply read aloud as voice messages, or undefined when it is too long to listen to or cannot be encoded. */
  async voiceMessage(text: string, format: VoiceFormat, signal: AbortSignal, botId?: string) {
    if (!this.codecs || !this.available('output') || spokenText(text).length > VOICE_MESSAGE_CHARS) return;
    const audio = await this.synthesize(text, signal, botId);
    return this.voiceClips(audio.bytes, format, signal);
  }
  /**
   * Audio as voice messages: Ogg Opus as one message, AMR as messages of at most a minute, cut at pauses. Undefined
   * without the system's codecs, for silence, and for audio longer than five minutes, which is better sent as a file.
   */
  async voiceClips(audio: Buffer, format: VoiceFormat, signal: AbortSignal): Promise<VoiceClip[] | undefined> {
    if (!this.codecs) return;
    if (format === 'ogg-opus') {
      const encoded = await this.codecs.encodeOpus(audio, signal),
        durationMs = Math.round((encoded.length / 48000) * 1000);
      if (!encoded.packets.length || durationMs > VOICE_MESSAGE_SECONDS * 1000) return;
      return [{ bytes: oggOpus(encoded), durationMs }];
    }
    const rate = 8000,
      { samples } = await this.codecs.decode(audio, signal, rate);
    if (!samples.length || samples.length > VOICE_MESSAGE_SECONDS * rate) return;
    const clips: VoiceClip[] = [];
    for (const [start, end] of speechPieces(samples, rate, AMR_CLIP_SECONDS))
      clips.push({
        bytes: await this.codecs.encodeAmr(samples.subarray(start, end), signal),
        durationMs: Math.round(((end - start) / rate) * 1000),
      });
    return clips;
  }
}
