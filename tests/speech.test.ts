import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { answer, tempDir, until } from './helpers';
import { ChatPinQueue } from '../electron/core/agent/chat-pins';
import { Interactions } from '../electron/core/agent/interactions';
import { Connectors } from '../electron/core/connectors/connector-hub';
import type { AdapterHandlers, ConnectorAdapter } from '../electron/core/connectors/connector-adapter';
import type { LarkSdk } from '../electron/core/connectors/adapters/feishu';
import { Store } from '../electron/core/storage/store';
import { ModelProviders } from '../electron/core/model/model-providers';
import { disposeModelHttp } from '../electron/core/model/model-http';
import { Attachments } from '../electron/core/attachments/attachments';
import { Harness } from '../electron/core/agent/harness';
import { SpeechService, type AudioCodecs } from '../electron/core/speech/speech-service';
import { recognize, speak, type SpeechAccess } from '../electron/core/speech/speech-protocols';
import {
  billedCharacters,
  closeWav,
  oggOpus,
  readWav,
  speechPieces,
  wavFile,
} from '../electron/core/speech/speech-audio';
import { speechChunks, spokenText } from '../shared/speech/speech-text';
import { defaultSpeechProtocol } from '../shared/types/speech-types';
import type { ModelClient } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';

test.after(() => disposeModelHttp());

interface Call {
  url: string;
  headers: Headers;
  body: any;
}
/** Multipart fields as plain values, with files as their name, type and bytes. */
async function fields(form: FormData) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of form.entries())
    result[key] =
      typeof value === 'string'
        ? value
        : { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
  return result;
}
function mockFetch(t: test.TestContext, respond: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const body = init?.body instanceof FormData ? await fields(init.body) : JSON.parse(String(init?.body));
    const call = { url: String(input), headers: new Headers(init?.headers), body };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  t.after(() => (globalThis.fetch = original));
  return calls;
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const signal = () => new AbortController().signal;

/** Loud samples, quiet for half a second from each of `pauses` seconds. */
function speechLike(sampleRate: number, seconds: number, pauses: number[]) {
  const samples = new Int16Array(sampleRate * seconds);
  for (let index = 0; index < samples.length; index++) {
    const second = index / sampleRate;
    if (!pauses.some((at) => second >= at && second < at + 0.5)) samples[index] = index % 2 ? 8000 : -8000;
  }
  return samples;
}

test('a provider without a chosen speech protocol gets the one its address names', () => {
  assert.equal(defaultSpeechProtocol('https://api.deepseek.com'), 'deepseek-tools');
  assert.equal(defaultSpeechProtocol('https://api.deepseek.com/v1'), 'deepseek-tools');
  assert.equal(defaultSpeechProtocol('https://api.xiaomimimo.com/v1'), 'chat-audio');
  assert.equal(defaultSpeechProtocol('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'chat-audio');
  assert.equal(defaultSpeechProtocol('https://api.openai.com/v1'), 'openai-audio');
  assert.equal(defaultSpeechProtocol('https://api.siliconflow.cn/v1'), 'openai-audio');
  assert.equal(defaultSpeechProtocol('not a url'), 'openai-audio');
});

test('replies are read the way a person would say them, in pieces that end at sentences', () => {
  assert.equal(
    spokenText(
      '# 结果\n**完成**了，见[文档](https://x.dev/a)和 https://x.dev/b 。\n```js\nlet a = 1;\n```\n| 名称 | 数量 |\n|---|---|\n| 苹果 | 3 |',
    ),
    '结果\n完成了，见文档和 （链接） 。\n\n（代码略）\n\n名称，数量\n\n苹果，3',
  );
  assert.equal(spokenText('snake_case_name 保留下划线'), 'snake_case_name 保留下划线');
  const chunks = speechChunks('第一句话。第二句话比较长，有逗号。第三句。', 12, 6);
  assert.deepEqual(chunks, ['第一句话。', '第二句话比较长，有逗号。', '第三句。']);
  // Without a sentence end in reach, a piece ends at a comma.
  assert.deepEqual(speechChunks('第二句话比较长，有逗号还有很多字。', 12), ['第二句话比较长，', '有逗号还有很多字。']);
  assert.ok(speechChunks('x'.repeat(25), 10).every((chunk) => chunk.length <= 10));
  assert.equal(speechChunks('x'.repeat(25), 10).join(''), 'x'.repeat(25));
});

test('audio helpers read, cut, close and count like the services expect', () => {
  const stereo = Buffer.alloc(44 + 8);
  wavFile(new Int16Array(4), 16000).copy(stereo);
  stereo.writeUInt16LE(2, 22);
  stereo.writeInt16LE(100, 44);
  stereo.writeInt16LE(300, 46);
  stereo.writeInt16LE(-50, 48);
  stereo.writeInt16LE(-150, 50);
  assert.deepEqual([...readWav(stereo)!.samples], [200, -100]);
  assert.equal(readWav(wavFile(new Int16Array(4), 11025)), undefined);
  assert.equal(readWav(Buffer.from('OggS')), undefined);

  assert.deepEqual(speechPieces(new Int16Array(50), 10, 10), [[0, 50]]);
  const pieces = speechPieces(speechLike(100, 30, [9]), 100, 10);
  assert.ok(pieces[0][1] >= 900 && pieces[0][1] < 950, 'the cut falls in the pause');
  assert.equal(pieces.at(-1)![1], 3000);
  for (let index = 1; index < pieces.length; index++) assert.equal(pieces[index][0], pieces[index - 1][1]);

  const streamed = wavFile(new Int16Array(24000), 24000);
  streamed.writeUInt32LE(0xffffffff, 4);
  streamed.writeUInt32LE(0xffffffff, 40);
  assert.equal(closeWav(streamed), 1);
  assert.equal(streamed.readUInt32LE(40), streamed.length - 44);
  assert.equal(closeWav(Buffer.from('not audio')), undefined);
  assert.equal(billedCharacters('你好, AI'), 8);
});

test('voice messages are valid Ogg Opus: checksummed pages, a closing page and the true length', () => {
  const packets = Array.from({ length: 300 }, (_, index) => ({
    data: Buffer.alloc(index % 7 ? 80 : 300, index),
    samples: 960,
  }));
  const file = oggOpus({ packets, preSkip: 312, length: 300 * 960 - 500 });
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
    return value >>> 0;
  });
  const pages: Array<{ flags: number; granule: bigint; data: Buffer }> = [];
  let total = 0;
  for (let at = 0; at < file.length;) {
    assert.equal(file.toString('ascii', at, at + 4), 'OggS');
    const count = file[at + 26],
      size = file.subarray(at + 27, at + 27 + count).reduce((sum, value) => sum + value, 0),
      page = Buffer.from(file.subarray(at, at + 27 + count + size)),
      stored = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    let crc = 0;
    for (const byte of page) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
    assert.equal(crc, stored, 'page checksum');
    assert.equal(page.readUInt32LE(18), pages.length, 'page sequence');
    pages.push({ flags: page[5], granule: page.readBigInt64LE(6), data: page.subarray(27 + count) });
    if (pages.length > 2) total += page.subarray(27 + count).length;
    at += page.length;
  }
  assert.equal(pages[0].flags, 0x02);
  assert.equal(pages[0].data.toString('ascii', 0, 8), 'OpusHead');
  assert.equal(pages[0].data.readUInt16LE(10), 312);
  assert.equal(pages[1].data.toString('ascii', 0, 8), 'OpusTags');
  assert.equal(pages.at(-1)!.flags, 0x04);
  assert.equal(pages.at(-1)!.granule, BigInt(312 + 300 * 960 - 500));
  assert.equal(
    total,
    packets.reduce((sum, packet) => sum + packet.data.length, 0),
  );
});

test('each protocol sends recognition and synthesis the way its service documents', async (t) => {
  const wav = wavFile(new Int16Array(160), 16000),
    mp3 = Buffer.from('ID3 mp3 bytes');
  const calls = mockFetch(t, ({ url }) => {
    if (url.endsWith('/v1/tools/asr') || url.endsWith('/audio/transcriptions')) return json({ text: ' 你好 ' });
    if (url.endsWith('/v1/tools/tts')) return new Response(wavFile(new Int16Array(10), 24000));
    if (url.endsWith('/audio/speech')) return new Response(mp3);
    return json({ choices: [{ message: { content: '识别结果', audio: { data: mp3.toString('base64') } } }] });
  });
  const access = (protocol: SpeechAccess['protocol'], baseUrl: string, model = 'm'): SpeechAccess => ({
    protocol,
    baseUrl,
    key: 'sk',
    model,
    voice: 'v',
  });
  const deepseek = access('deepseek-tools', 'https://api.deepseek.com/v1', ''),
    openai = access('openai-audio', 'https://api.openai.com/v1/', 'gpt-transcribe'),
    mimo = access('chat-audio', 'https://api.xiaomimimo.com/v1', 'mimo-v2.5-asr');

  assert.equal(await recognize(deepseek, wav, signal()), '你好');
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/asr');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer sk');
  assert.deepEqual(Object.keys(calls[0].body), ['file']);
  assert.equal(calls[0].body.file.type, 'audio/wav');

  assert.equal(await recognize(openai, wav, signal()), '你好');
  assert.equal(calls[1].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(calls[1].body.model, 'gpt-transcribe');
  assert.deepEqual(calls[1].body.file.bytes, wav);

  assert.equal(await recognize(mimo, wav, signal()), '识别结果');
  assert.equal(calls[2].url, 'https://api.xiaomimimo.com/v1/chat/completions');
  const audio = calls[2].body.messages[0].content[0];
  assert.equal(audio.type, 'input_audio');
  assert.equal(audio.input_audio.data, 'data:audio/wav;base64,' + wav.toString('base64'));

  const tts = await speak(deepseek, '你好', signal());
  assert.equal(tts.mime, 'audio/wav');
  assert.deepEqual(calls[3].body, { text: '你好', voice_id: 'v', format: 'wav' });
  assert.deepEqual((await speak(openai, 'hi', signal())).bytes, mp3);
  assert.deepEqual(calls[4].body, { model: 'gpt-transcribe', input: 'hi', voice: 'v', response_format: 'mp3' });
  assert.deepEqual((await speak(mimo, '读这句', signal())).bytes, mp3);
  assert.deepEqual(calls[5].body, {
    model: 'mimo-v2.5-asr',
    messages: [{ role: 'assistant', content: '读这句' }],
    audio: { format: 'mp3', voice: 'v' },
  });
});

test('speech service errors carry stable codes', async (t) => {
  mockFetch(t, () => json({ error: { message: 'Insufficient Balance' } }, 402));
  const service = new SpeechService({
    speechAccess: (kind) =>
      kind === 'input' ? { protocol: 'openai-audio', baseUrl: 'https://x/v1', key: '', model: 'w' } : undefined,
  });
  await assert.rejects(service.transcribe(wavFile(new Int16Array(160), 16000), signal()), {
    code: 'speech.balance',
    message: /余额不足.*Insufficient Balance/,
  });
  await assert.rejects(service.synthesize('hi', signal()), { code: 'speech.output_unset' });
  await assert.rejects(service.transcribe(Buffer.from('ID3'), signal()), { code: 'speech.format_unsupported' });
});

test('long recordings are recognized in pieces cut at pauses, with the time each starts', async (t) => {
  const rate = 8000;
  const calls = mockFetch(t, ({ body }) => {
    const piece = readWav(body.file.bytes)!;
    return json({ text: `${Math.round(piece.samples.length / rate)} 秒` });
  });
  const decoded: number[] = [];
  const codecs: AudioCodecs = {
    decode: async (bytes) => {
      decoded.push(bytes.length);
      return { sampleRate: rate, samples: speechLike(rate, 250, [100, 205]) };
    },
    encodeOpus: async () => ({ packets: [], preSkip: 312, length: 0 }),
  };
  const service = new SpeechService(
    { speechAccess: () => ({ protocol: 'deepseek-tools', baseUrl: 'https://api.deepseek.com', key: 'k', model: '' }) },
    codecs,
  );
  const { text, seconds } = await service.transcribe(Buffer.from('m4a bytes'), signal());
  assert.deepEqual(decoded, [9]);
  assert.equal(seconds, 250);
  assert.equal(calls.length, 3);
  assert.deepEqual(text.split('\n'), ['[0:00] 100 秒', '[1:40] 105 秒', '[3:25] 45 秒']);
});

test('long text is read in pieces and the WAV audio joined into one file', async (t) => {
  const calls = mockFetch(t, ({ body }) => {
    const audio = wavFile(new Int16Array(body.text.length * 10).fill(1), 24000);
    audio.writeUInt32LE(0xffffffff, 40);
    return new Response(audio);
  });
  const service = new SpeechService({
    speechAccess: () => ({ protocol: 'deepseek-tools', baseUrl: 'https://api.deepseek.com', key: 'k', model: '' }),
  });
  const text = '这是一句话。'.repeat(500);
  const audio = await service.synthesize(text, signal());
  assert.ok(calls.length > 1);
  assert.ok(calls.every((call) => call.body.text.length <= 2000));
  assert.equal(audio.mime, 'audio/wav');
  assert.equal(readWav(audio.bytes)!.samples.length, text.length * 10);
  // Too long to listen to as a chat message: no voice message.
  assert.equal(await service.voiceMessage(text, signal()), undefined);
});

function codec() {
  const key = randomBytes(32);
  return {
    encrypt: (value: string) => {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv),
        data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    decrypt: () => 'sk-speech',
  };
}

test('speech settings name a provider and model; a Bot can have its own voice', (t) => {
  const store = new Store(tempDir(t, 'aelion-speech-')),
    providers = new ModelProviders(store, codec());
  t.after(() => {
    providers.dispose();
    store.close();
  });
  const deepseek = providers.save({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-speech' }),
    openai = providers.save({ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-speech' });
  assert.throws(() => providers.setSpeech({ input: { providerId: openai.id, model: '' } }), {
    code: 'speech.model_required',
  });
  providers.setSpeech({
    input: { providerId: deepseek.id, model: 'ignored' },
    output: { providerId: openai.id, model: 'gpt-4o-mini-tts', voice: 'marin' },
    connectorVoiceReplies: true,
  });
  assert.deepEqual(store.data.speech, {
    input: { providerId: deepseek.id, model: '' },
    output: { providerId: openai.id, model: 'gpt-4o-mini-tts', voice: 'marin' },
    connectorVoiceReplies: true,
  });
  assert.deepEqual(providers.speechAccess('input'), {
    protocol: 'deepseek-tools',
    baseUrl: deepseek.baseUrl,
    key: 'sk-speech',
    model: '',
  });
  const bot = store.data.bots[0];
  assert.equal(providers.speechAccess('output', bot.id)?.voice, 'marin');
  bot.voice = 'cedar';
  assert.equal(providers.speechAccess('output', bot.id)?.voice, 'cedar');
  // A provider in use for speech cannot be removed.
  assert.throws(() => providers.remove(deepseek.id), { code: 'provider.in_use' });
  // The protocol chosen on the provider wins over its address.
  providers.save({ id: openai.id, name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', speechProtocol: 'chat-audio' });
  assert.equal(providers.speechAccess('output')?.protocol, 'chat-audio');
  assert.throws(
    () => providers.save({ id: openai.id, name: 'OpenAI', baseUrl: 'https://x', speechProtocol: 'nope' as never }),
    { code: 'provider.speech_protocol_invalid' },
  );
});

test('Bots get the speech tools only once speech is set up; speech made by a Bot is attached to its reply', async (t) => {
  const store = new Store(tempDir(t, 'aelion-speech-tools-'));
  t.after(() => store.close());
  const bot = store.data.bots[0],
    recording = new Attachments(store).importForBot(bot.id, 'memo.wav', wavFile(new Int16Array(1600), 16000));
  let output = false;
  mockFetch(t, ({ url }) =>
    url.endsWith('/audio/transcriptions') ? json({ text: '记得买牛奶' }) : new Response(Buffer.from('ID3 voice')),
  );
  const service = new SpeechService({
    speechAccess: (kind) =>
      kind === 'input' || output
        ? { protocol: 'openai-audio', baseUrl: 'https://api.openai.com/v1', key: 'k', model: 'm', voice: 'alloy' }
        : undefined,
  });
  const offered: string[][] = [];
  const outputs: string[] = [];
  let turn = 0;
  const call = (id: string, name: string, args: unknown) => ({
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  const model = {
    complete: async (
      messages: Array<{ role: string; content?: string }>,
      tools: Array<{ function: { name: string } }>,
    ) => {
      offered.push(tools.map((tool) => tool.function.name));
      const last = messages.at(-1)!;
      if (last.role === 'tool') outputs.push(last.content || '');
      if (turn++ % 2) return { content: '好了', finishReason: 'stop', calls: [] };
      return {
        content: '',
        finishReason: 'tool_calls',
        calls: [
          output
            ? call('say', 'text_to_speech', { text: '**记得**买牛奶', filename: '提醒' })
            : call('hear', 'transcribe_audio', { file: { attachmentId: recording.id } }),
        ],
      };
    },
  } as unknown as ModelClient;
  const harness = new Harness(store, {} as VmController, model, () => {});
  harness.setSpeech(service);
  await harness.run(bot.id, '听一下录音');
  assert.ok(offered[0].includes('transcribe_audio'));
  assert.ok(!offered[0].includes('text_to_speech'));
  assert.match(outputs[0], /记得买牛奶/);

  output = true;
  await harness.run(bot.id, '读给我听');
  await until(() => store.data.runs.length === 2 && store.data.runs[1].status === 'completed');
  assert.ok(offered.at(-1)!.includes('text_to_speech'));
  assert.deepEqual(
    store.data.runs[1].attachments?.map((file) => [file.name, file.mime]),
    [['提醒.mp3', 'audio/mpeg']],
  );
});

test('a voice message from a connector reaches the Bot as text, and the answer comes back by voice too', async (t) => {
  const dir = tempDir(t, 'aelion-speech-im-'),
    store = new Store(dir),
    bot = store.data.bots[0];
  store.data.model.model = 'fixture';
  store.data.speech = { connectorVoiceReplies: true };
  const texts: string[] = [],
    voices: Array<{ bytes: Buffer; durationMs: number }> = [];
  let handlers: AdapterHandlers | undefined;
  const adapter: ConnectorAdapter = {
    platform: 'feishu',
    start: (value) => {
      handlers = value;
      value.status('connected');
    },
    stop: async () => {},
    sendText: async (_chat, text) => void texts.push(text),
    sendFile: async () => {},
    sendVoice: async (_chat, voice) => void voices.push(voice),
  };
  const heard: string[] = [];
  const speech = {
    available: () => true,
    transcribe: async (bytes: Buffer) => ({ text: bytes.toString() === 'opus' ? '明天几点开会' : '', seconds: 2 }),
    voiceMessage: async (text: string) => (heard.push(text), { bytes: Buffer.from('OggS'), durationMs: 1200 }),
  };
  const prompts: string[] = [];
  const model = {
    complete: async (messages: unknown) => (prompts.push(JSON.stringify(messages)), answer('上午十点。')),
  } as unknown as ModelClient;
  const harness = new Harness(store, {} as VmController, model, () => {});
  let connectors: Connectors | undefined;
  const queue = new ChatPinQueue(
    store,
    {
      isRunning: (id, sessionId) => harness.isRunning(id, sessionId),
      run: (id, input, options) => connectors!.wrapRun(id, options, (wrapped) => harness.run(id, input, wrapped)),
    },
    () => {},
  );
  connectors = new Connectors({
    store,
    dataDir: dir,
    codec: { encrypt: (value) => value, decrypt: (value) => value },
    version: 'test',
    attachments: new Attachments(store),
    speech,
    send: ({ connector, ...input }) => queue.send(input, connector),
    cancel: () => {},
    isRunning: (botId, sessionId) => harness.isRunning(botId, sessionId),
    setPermission: () => {},
    interactions: new Interactions(() => {}),
    changed: () => queue.wake(),
    lark: () => ({}) as LarkSdk,
    createAdapter: () => adapter,
  });
  t.after(async () => {
    queue.dispose();
    await until(() => !harness.busy);
    await connectors!.dispose();
    store.close();
  });
  const id = connectors.add({
    botId: bot.id,
    permissionMode: 'auto',
    credentials: { platform: 'wecom', botId: 'bot-1', secret: 'test-secret' },
  });
  connectors.saved.get(id)!.owner = { id: 'owner' };
  handlers!.message({
    messageId: 'voice-1',
    chatId: 'chat-owner',
    isGroup: false,
    sender: { id: 'owner' },
    text: '',
    resources: [{ kind: 'audio', fetch: async () => ({ name: 'audio-1.opus', bytes: Buffer.from('opus') }) }],
    sentAt: Date.now(),
  });
  await until(() => voices.length === 1);
  const input = store.data.messages.find((message) => message.connector?.messageId === 'voice-1')!;
  assert.equal(input.content, '（语音）明天几点开会');
  assert.equal(input.connector?.voice, true);
  assert.ok(!input.attachments?.length, 'the recording itself is not kept once understood');
  assert.match(prompts[0], /明天几点开会/);
  assert.deepEqual(texts, ['上午十点。']);
  assert.deepEqual(heard, ['上午十点。']);
  assert.equal(voices[0].durationMs, 1200);

  // Typed messages get text only.
  handlers!.message({
    messageId: 'text-1',
    chatId: 'chat-owner',
    isGroup: false,
    sender: { id: 'owner' },
    text: '谢谢',
    resources: [],
    sentAt: Date.now(),
  });
  await until(() => texts.length === 2 && !harness.busy);
  assert.equal(voices.length, 1);
});
