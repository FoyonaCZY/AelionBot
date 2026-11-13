// Speech recognition and synthesis: which provider and model the app uses, and the wire protocols they speak.
// Providers do not share one: OpenAI and the services that copy it have /audio endpoints, Xiaomi MiMo and Qwen put
// audio into chat completions, and DeepSeek has tool endpoints of its own.

const SPEECH_PROTOCOLS = ['openai-audio', 'chat-audio', 'deepseek-tools'] as const;
export type SpeechProtocol = (typeof SPEECH_PROTOCOLS)[number];

export interface SpeechProtocolInfo {
  id: SpeechProtocol;
  label: string;
  /** Request paths for recognition and synthesis, shown in settings. */
  endpoints: { input: string; output: string };
  hint: string;
  /** Known model names, offered in the model field; any other name can be typed. */
  inputModels: string[];
  outputModels: string[];
  voices: Array<{ id: string; label: string }>;
  /** DeepSeek's tool endpoints take no model name. */
  modelless?: boolean;
}

export const SPEECH_PROTOCOL_CATALOG: SpeechProtocolInfo[] = [
  {
    id: 'openai-audio',
    label: 'OpenAI Audio',
    endpoints: { input: 'POST /audio/transcriptions', output: 'POST /audio/speech' },
    hint: 'OpenAI，以及硅基流动、Groq、本地 Whisper 服务等兼容 /audio 接口的服务。',
    inputModels: ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1', 'FunAudioLLM/SenseVoiceSmall'],
    outputModels: ['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1', 'FunAudioLLM/CosyVoice2-0.5B'],
    voices: [
      'marin',
      'cedar',
      'alloy',
      'ash',
      'ballad',
      'coral',
      'echo',
      'fable',
      'nova',
      'onyx',
      'sage',
      'shimmer',
      'verse',
    ].map((id) => ({ id, label: id })),
  },
  {
    id: 'chat-audio',
    label: 'Chat Completions 音频',
    endpoints: { input: 'POST /chat/completions（input_audio）', output: 'POST /chat/completions（audio）' },
    hint: '小米 MiMo、阿里云百炼 Qwen3-ASR 等把音频放在对话请求里的服务。',
    inputModels: ['mimo-v2.5-asr', 'qwen3-asr-flash'],
    outputModels: ['mimo-v2.5-tts'],
    voices: [
      { id: 'mimo_default', label: 'mimo_default' },
      { id: '冰糖', label: '冰糖' },
      { id: '茉莉', label: '茉莉' },
      { id: '苏打', label: '苏打' },
      { id: '白桦', label: '白桦' },
      { id: 'Mia', label: 'Mia' },
      { id: 'Chloe', label: 'Chloe' },
      { id: 'Milo', label: 'Milo' },
      { id: 'Dean', label: 'Dean' },
    ],
  },
  {
    id: 'deepseek-tools',
    label: 'DeepSeek 工具接口',
    endpoints: { input: 'POST /v1/tools/asr', output: 'POST /v1/tools/tts' },
    hint: 'DeepSeek 的语音识别和语音合成，不需要填写模型。',
    inputModels: [],
    outputModels: [],
    voices: [
      { id: 'stella', label: 'stella（女声）' },
      { id: 'tide', label: 'tide（男声）' },
    ],
    modelless: true,
  },
];

export function asSpeechProtocol(value: unknown): SpeechProtocol | undefined {
  return typeof value === 'string' && (SPEECH_PROTOCOLS as readonly string[]).includes(value)
    ? (value as SpeechProtocol)
    : undefined;
}
export const speechProtocolInfo = (protocol: SpeechProtocol) =>
  SPEECH_PROTOCOL_CATALOG.find((info) => info.id === protocol)!;

/** The protocol of a provider that has not chosen one, from the service its address names. */
export function defaultSpeechProtocol(baseUrl = ''): SpeechProtocol {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    /* an unfinished address in the form */
  }
  if (host === 'deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek-tools';
  if (host.endsWith('xiaomimimo.com') || host.endsWith('aliyuncs.com')) return 'chat-audio';
  return 'openai-audio';
}

export interface SpeechSelection {
  providerId: string;
  /** Empty for DeepSeek, whose endpoints take no model. */
  model: string;
  /** The default voice for synthesis; a Bot can choose its own. */
  voice?: string;
}
export interface SpeechSettings {
  input?: SpeechSelection;
  output?: SpeechSelection;
  /** Answer a voice message from a connector with a voice message as well as text. */
  connectorVoiceReplies?: boolean;
}

/** Recognition takes one recording at a time, as WAV or another common format. */
export const SPEECH_RECORDING_LIMIT = { seconds: 60 * 60, bytes: 25 * 1024 * 1024 } as const;
