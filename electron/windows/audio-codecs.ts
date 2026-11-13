// Chromium's own audio codecs, in a hidden sandboxed window, so recordings in MP3, M4A, AAC, FLAC, Ogg, Opus, WebM
// and the sound of MP4 videos can be recognized, and replies encoded as Opus voice messages, without shipping ffmpeg.
import { BrowserWindow } from 'electron';
import { AppError } from '../../shared/errors';
import type { AudioCodecs } from '../core/speech/speech-service';
import type { OpusPackets, Pcm } from '../core/speech/speech-audio';

/** An hour of 16 kHz samples is 115 MB; Chromium holds the decoded channels besides. */
const MAX_SECONDS = 60 * 60;
/** Bytes per call into and out of the page, so no single script or result is huge. */
const PART = 8 * 1024 * 1024;

/** Page code that turns the loaded bytes into one channel of float samples at `rate`. */
const MONO = (rate: number) => `
  const bytes=new Uint8Array(window.size);let at=0;
  for(const part of window.parts){const text=atob(part);for(let i=0;i<text.length;i++)bytes[at++]=text.charCodeAt(i)}
  window.parts=null;
  const url=URL.createObjectURL(new Blob([bytes]));
  const duration=await new Promise(resolve=>{const audio=new Audio();audio.preload='metadata';
    const timer=setTimeout(()=>resolve(NaN),10000);
    audio.onloadedmetadata=()=>{clearTimeout(timer);resolve(audio.duration)};audio.onerror=()=>{clearTimeout(timer);resolve(NaN)};audio.src=url});
  URL.revokeObjectURL(url);
  if(duration>${MAX_SECONDS})throw Error('录音超过 1 小时，请分段后再识别');
  let buffer;
  try{buffer=await new OfflineAudioContext(1,1,${rate}).decodeAudioData(bytes.buffer)}
  catch{throw Error('这个文件里没有可识别的音频，或者格式不受支持')}
  if(buffer.duration>${MAX_SECONDS})throw Error('录音超过 1 小时，请分段后再识别');
  const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i)),mono=new Float32Array(buffer.length);
  for(let i=0;i<mono.length;i++){let sum=0;for(const c of channels)sum+=c[i];mono[i]=Math.max(-1,Math.min(1,sum/channels.length))}
`;

export class AudioCodecWindow implements AudioCodecs {
  private windows = new Set<BrowserWindow>();
  private closed = false;
  /** An empty local page: WebCodecs needs a secure context, which about:blank is not. */
  constructor(private pagePath: string) {}
  dispose() {
    this.closed = true;
    for (const window of this.windows) if (!window.isDestroyed()) window.destroy();
    this.windows.clear();
  }
  /** Runs `work` in a fresh page holding `bytes`, and closes the page afterwards. */
  private async withPage<T>(
    bytes: Buffer,
    signal: AbortSignal,
    work: (run: (script: string) => Promise<any>) => Promise<T>,
  ) {
    signal.throwIfAborted();
    if (this.closed) throw new AppError('speech.codecs_closed', '音频编解码器已关闭');
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        partition: 'aelion-audio-codecs',
      },
    });
    this.windows.add(window);
    const close = () => {
      if (!window.isDestroyed()) window.destroy();
    };
    signal.addEventListener('abort', close, { once: true });
    const timeout = setTimeout(close, 5 * 60000);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    try {
      await window.loadFile(this.pagePath);
      const run = (script: string) => window.webContents.executeJavaScript(script);
      await run(`window.parts=[];window.size=${bytes.length}`);
      for (let at = 0; at < bytes.length; at += PART)
        await run(`window.parts.push(${JSON.stringify(bytes.subarray(at, at + PART).toString('base64'))})`);
      signal.throwIfAborted();
      return await work(run);
    } catch (error) {
      signal.throwIfAborted();
      throw new AppError(
        'speech.codec_failed',
        window.isDestroyed() ? '音频处理超时或编解码器已关闭' : (error as Error).message,
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', close);
      close();
      this.windows.delete(window);
    }
  }
  decode(bytes: Buffer, signal: AbortSignal): Promise<Pcm> {
    return this.withPage(bytes, signal, async (run) => {
      const length: number = await run(`(async()=>{${MONO(16000)}
        const pcm=new Int16Array(mono.length);for(let i=0;i<mono.length;i++)pcm[i]=mono[i]<0?mono[i]*32768:mono[i]*32767;
        window.pcm=pcm;return pcm.length})()`);
      const samples = new Int16Array(length);
      for (let at = 0; at < length; at += PART / 2) {
        signal.throwIfAborted();
        const part: Uint8Array = await run(
          `new Uint8Array(window.pcm.buffer.slice(${at * 2},${Math.min(length, at + PART / 2) * 2}))`,
        );
        new Uint8Array(samples.buffer).set(part, at * 2);
      }
      return { sampleRate: 16000, samples };
    });
  }
  encodeOpus(bytes: Buffer, signal: AbortSignal): Promise<OpusPackets> {
    return this.withPage(bytes, signal, async (run) => {
      const result: { sizes: number[]; samples: number[]; data: Uint8Array; preSkip: number; length: number } =
        await run(`(async()=>{${MONO(48000)}
        const chunks=[];let failure,preSkip=312;
        const encoder=new AudioEncoder({output:(chunk,meta)=>{const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);
            chunks.push({data,samples:Math.round((chunk.duration||20000)*48/1000)});
            const head=meta&&meta.decoderConfig&&meta.decoderConfig.description;
            if(head){const view=ArrayBuffer.isView(head)?new Uint8Array(head.buffer,head.byteOffset,head.byteLength):new Uint8Array(head);
              if(view.length>=12)preSkip=view[10]|(view[11]<<8)}},
          error:error=>failure=error});
        encoder.configure({codec:'opus',sampleRate:48000,numberOfChannels:1,bitrate:32000});
        for(let at=0;at<mono.length;at+=48000){const part=mono.slice(at,at+48000);
          encoder.encode(new AudioData({format:'f32',sampleRate:48000,numberOfFrames:part.length,numberOfChannels:1,timestamp:Math.round(at/48*1000),data:part}))}
        await encoder.flush();encoder.close();if(failure)throw failure;
        const data=new Uint8Array(chunks.reduce((n,c)=>n+c.data.length,0));let offset=0;for(const c of chunks){data.set(c.data,offset);offset+=c.data.length}
        return {sizes:chunks.map(c=>c.data.length),samples:chunks.map(c=>c.samples),data,preSkip,length:mono.length}})()`);
      let at = 0;
      const data = Buffer.from(result.data);
      return {
        packets: result.sizes.map((size, index) => {
          const packet = { data: data.subarray(at, at + size), samples: result.samples[index] };
          at += size;
          return packet;
        }),
        preSkip: result.preSkip,
        length: result.length,
      };
    });
  }
}
