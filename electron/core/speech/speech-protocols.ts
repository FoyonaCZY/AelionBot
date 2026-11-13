// One request of speech recognition or synthesis in each protocol. The service above cuts recordings and texts to
// the sizes in SPEECH_LIMITS, so each request here fits what its protocol takes.
import { AppError } from '../../../shared/errors';
import type { SpeechProtocol } from '../../../shared/types/speech-types';
import { modelFetch } from '../model/model-http';

export interface SpeechAccess {
  protocol: SpeechProtocol;
  baseUrl: string;
  key: string;
  model: string;
  voice?: string;
}

/**
 * Seconds of 16 kHz WAV per recognition request and characters per synthesis request. OpenAI takes 25 MB of audio
 * and 4096 characters; MiMo 10 MB of Base64 within an 8k context; DeepSeek 120 seconds and 10,000 billed characters,
 * a Chinese character counting two.
 */
export const SPEECH_LIMITS: Record<SpeechProtocol, { pieceSeconds: number; textChars: number }> = {
  'openai-audio': { pieceSeconds: 600, textChars: 4000 },
  'chat-audio': { pieceSeconds: 110, textChars: 1500 },
  'deepseek-tools': { pieceSeconds: 110, textChars: 2000 },
};

const root = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, '');
/** DeepSeek's tools sit beside its versioned API, whichever of the two documented base URLs is configured. */
function deepseekTools(baseUrl: string) {
  try {
    return `${new URL(baseUrl).origin}/v1/tools`;
  } catch {
    throw new AppError('speech.base_url_invalid', '语音 Provider 的 Base URL 无效');
  }
}
const auth = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

async function send(url: string, init: RequestInit, signal: AbortSignal) {
  let response: Response;
  try {
    response = await modelFetch(url, { ...init, signal, redirect: 'error' });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AppError('speech.unreachable', '连接语音服务失败，请检查网络、代理和 Base URL');
  }
  if (response.ok) return response;
  const body = await response.text().catch(() => '');
  let detail = '';
  try {
    const data = JSON.parse(body);
    detail = String(data?.error?.message || data?.message || data?.error || '').slice(0, 300);
  } catch {
    detail = body.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  const status = response.status,
    [code, text] =
      status === 401 || status === 403
        ? ['speech.unauthorized', '语音服务的 API Key 无效或没有权限']
        : status === 402
          ? ['speech.balance', '语音服务账户余额不足']
          : status === 404
            ? ['speech.not_found', '语音服务没有这个接口或模型，请检查语音协议和模型名称']
            : status === 413
              ? ['speech.too_large', '音频或文字超过了语音服务的限制']
              : status === 429 || status === 503
                ? ['speech.busy', '语音服务繁忙，请稍后再试']
                : ['speech.failed', `语音服务返回 HTTP ${status}`];
  throw new AppError(code, detail ? `${text}（${detail}）` : text);
}
async function json(response: Response) {
  const data = await response.json().catch(() => undefined);
  if (!data || typeof data !== 'object') throw new AppError('speech.bad_response', '语音服务返回了无法解析的结果');
  // DeepSeek reports a failure after the upload as an error object in a successful response.
  if (data.error)
    throw new AppError('speech.failed', `语音服务处理失败（${String(data.error.message || '').slice(0, 300)}）`);
  return data as Record<string, any>;
}

/** Text of one piece of speech, sent as 16-bit WAV. */
export async function recognize(access: SpeechAccess, wav: Buffer, signal: AbortSignal): Promise<string> {
  const upload = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('file', new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'speech.wav');
    return form;
  };
  if (access.protocol === 'deepseek-tools') {
    const response = await send(
      `${deepseekTools(access.baseUrl)}/asr`,
      { method: 'POST', headers: auth(access.key), body: upload({}) },
      signal,
    );
    return String((await json(response)).text || '').trim();
  }
  if (access.protocol === 'openai-audio') {
    const response = await send(
      `${root(access.baseUrl)}/audio/transcriptions`,
      { method: 'POST', headers: auth(access.key), body: upload({ model: access.model, response_format: 'json' }) },
      signal,
    );
    return String((await json(response)).text || '').trim();
  }
  const response = await send(
    `${root(access.baseUrl)}/chat/completions`,
    {
      method: 'POST',
      headers: { ...auth(access.key), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: access.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}`, format: 'wav' },
              },
            ],
          },
        ],
      }),
    },
    signal,
  );
  const content = (await json(response)).choices?.[0]?.message?.content;
  return (
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : ''
  ).trim();
}

/** Speech of one piece of text, as the protocol returns it. */
export async function speak(
  access: SpeechAccess,
  text: string,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mime: 'audio/wav' | 'audio/mpeg' }> {
  if (access.protocol === 'deepseek-tools') {
    const response = await send(
      `${deepseekTools(access.baseUrl)}/tts`,
      {
        method: 'POST',
        headers: { ...auth(access.key), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice_id: access.voice || 'stella', format: 'wav' }),
      },
      signal,
    );
    // The audio streams as it is made; a failure partway drops the connection, which reading reports.
    return { bytes: Buffer.from(await response.arrayBuffer()), mime: 'audio/wav' };
  }
  if (access.protocol === 'openai-audio') {
    const response = await send(
      `${root(access.baseUrl)}/audio/speech`,
      {
        method: 'POST',
        headers: { ...auth(access.key), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: access.model,
          input: text,
          voice: access.voice || 'alloy',
          response_format: 'mp3',
        }),
      },
      signal,
    );
    return { bytes: Buffer.from(await response.arrayBuffer()), mime: 'audio/mpeg' };
  }
  // MiMo reads the assistant message aloud; a user message would only describe the style.
  const response = await send(
    `${root(access.baseUrl)}/chat/completions`,
    {
      method: 'POST',
      headers: { ...auth(access.key), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: access.model,
        messages: [{ role: 'assistant', content: text }],
        audio: { format: 'mp3', ...(access.voice ? { voice: access.voice } : {}) },
      }),
    },
    signal,
  );
  const data = (await json(response)).choices?.[0]?.message?.audio?.data;
  if (typeof data !== 'string' || !data) throw new AppError('speech.bad_response', '语音服务没有返回音频');
  return { bytes: Buffer.from(data, 'base64'), mime: 'audio/mpeg' };
}
