import {
  MODEL_USES,
  VIDEO_PROTOCOLS,
  usesModel,
  type ModelUse,
  type VideoSelection,
  type VideoSpecs,
} from '../../../shared/types/media-types';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelProvider, ModelSelection, ProviderInput, ProviderModel } from '../../../shared/types/core';
import { Store, atomicJson, type StoredProvider } from '../storage/store';
import { catalogSources, catalogMatches, officialHiggsfield } from '../../../shared/model-catalog';
import { loadProviderCatalog } from './provider-catalog';
import { modelEndpoint, validateModelEndpoint } from './model';
import { redactHost } from '../host/host';
import { hostedSearchProtocol, type ModelParameters } from '../../../shared/types/model-types';
import { asImageAspect, asImageProtocol, asImageQuality } from '../../../shared/types/image-types';
import {
  asSpeechProtocol,
  speechProtocolFor,
  type SpeechSelection,
  type SpeechSettings,
} from '../../../shared/types/speech-types';
import { reasoningEffort as cleanReasoning } from '../../../shared/chat/reasoning';
import { prewarmModelEndpoint, disposeModelHttp } from './model-http';
import { AppError } from '../../../shared/errors';
import { isOpenCodeEndpoint } from './opencode';

export function modelParameters(input: ModelParameters): ModelParameters {
  const {
    protocol,
    responsesTransport,
    temperature,
    reasoningEffort,
    thinkingBudget,
    fallbackModel,
    hostedWebSearch,
    hostedImageGeneration,
    imageProtocol,
    imageAspect,
    imageQuality,
    speechProtocol,
    asrProtocol,
    ttsProtocol,
    uses,
    videoProtocol,
  } = input;
  if (
    uses !== undefined &&
    (!Array.isArray(uses) || !uses.length || uses.some((use) => !Object.hasOwn(MODEL_USES, use)))
  )
    throw new AppError('provider.uses_invalid', '请选择有效的模型用途');
  if (videoProtocol !== undefined && !Object.hasOwn(VIDEO_PROTOCOLS, videoProtocol))
    throw new AppError('provider.video_protocol_invalid', '视频协议无效');
  if (uses?.includes('video') && !videoProtocol)
    throw new AppError('provider.video_protocol_required', '请选择视频协议');
  if ([speechProtocol, asrProtocol, ttsProtocol].some((p) => p !== undefined && !asSpeechProtocol(p)))
    throw new AppError('provider.speech_protocol_invalid', '语音协议无效');
  if (responsesTransport !== undefined && !['auto', 'http', 'websocket'].includes(responsesTransport))
    throw Error('Responses 连接方式无效');
  if (protocol !== undefined && !['chat', 'responses', 'anthropic', 'gemini'].includes(protocol))
    throw Error('模型协议无效');
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2))
    throw Error('温度应为 0–2');
  cleanReasoning(reasoningEffort);
  if (
    thinkingBudget !== undefined &&
    (!Number.isInteger(thinkingBudget) || thinkingBudget < 1024 || thinkingBudget > 64000)
  )
    throw Error('思考预算应为 1024–64000');
  if (
    fallbackModel !== undefined &&
    (typeof fallbackModel !== 'string' || fallbackModel.length > 256 || /[\u0000-\u001f]/.test(fallbackModel))
  )
    throw Error('备用模型无效');
  if (hostedWebSearch !== undefined && typeof hostedWebSearch !== 'boolean') throw Error('服务端网页搜索设置无效');
  if (hostedImageGeneration !== undefined && typeof hostedImageGeneration !== 'boolean')
    throw Error('服务端图片生成设置无效');
  if (imageProtocol !== undefined && !asImageProtocol(imageProtocol))
    throw new AppError('provider.image_protocol_invalid', '生图协议无效');
  if (imageAspect !== undefined && !asImageAspect(imageAspect)) throw Error('生图画幅无效');
  if (imageQuality !== undefined && !asImageQuality(imageQuality)) throw Error('生图质量无效');
  const responses = (protocol || 'chat') === 'responses';
  // Hosted Responses generation is only reachable on a Responses provider; keep the stored protocol consistent with that.
  const image = asImageProtocol(imageProtocol) || 'auto';
  if (image === 'responses-images' && !responses)
    throw new AppError('provider.image_protocol_unsupported', '托管生图协议只能用于 Responses Provider');
  return {
    protocol,
    responsesTransport,
    temperature,
    reasoningEffort,
    thinkingBudget,
    fallbackModel: fallbackModel?.trim() || undefined,
    ...(hostedSearchProtocol(protocol) && hostedWebSearch ? { hostedWebSearch: true } : {}),
    ...(responses && hostedImageGeneration && (!uses || uses.includes('image')) ? { hostedImageGeneration: true } : {}),
    ...(image !== 'auto' ? { imageProtocol: image } : {}),
    ...(asImageAspect(imageAspect) ? { imageAspect: asImageAspect(imageAspect) } : {}),
    ...(asImageQuality(imageQuality) && imageQuality !== 'auto' ? { imageQuality: asImageQuality(imageQuality) } : {}),
    ...(speechProtocol ? { speechProtocol } : {}),
    ...(asrProtocol ? { asrProtocol } : {}),
    ...(ttsProtocol ? { ttsProtocol } : {}),
    ...(uses ? { uses: [...new Set(uses)] } : {}),
    ...(videoProtocol ? { videoProtocol } : {}),
  };
}
function providerModelEntry(input: unknown): ProviderModel {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('模型配置无效');
  const value = input as ProviderModel,
    id = text(value.id, '模型 ID', 256);
  const contextTokens = value.contextTokens;
  if (
    contextTokens !== undefined &&
    (!Number.isInteger(contextTokens) || contextTokens < 8000 || contextTokens > 1000000)
  )
    throw Error('上下文容量应为 8000–1000000');
  const effort = cleanReasoning(value.reasoningEffort);
  if (
    value.thinkingBudget !== undefined &&
    (!Number.isInteger(value.thinkingBudget) || value.thinkingBudget < 1024 || value.thinkingBudget > 64000)
  )
    throw Error('思考预算应为 1024–64000');
  if (value.imageOutput !== undefined && typeof value.imageOutput !== 'boolean') throw Error('生图能力标记无效');
  if (value.imageAspect !== undefined && !asImageAspect(value.imageAspect)) throw Error('生图画幅无效');
  if (value.imageQuality !== undefined && !asImageQuality(value.imageQuality)) throw Error('生图质量无效');
  return {
    id,
    ...(contextTokens ? { contextTokens } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(value.thinkingBudget ? { thinkingBudget: value.thinkingBudget } : {}),
    ...(value.imageOutput ? { imageOutput: true } : {}),
    ...(asImageAspect(value.imageAspect) ? { imageAspect: value.imageAspect } : {}),
    ...(asImageQuality(value.imageQuality) && value.imageQuality !== 'auto'
      ? { imageQuality: value.imageQuality }
      : {}),
  };
}

export interface CredentialCodec {
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
}
function text(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
    throw new Error(`${label}无效`);
  return value.trim();
}
function catalogRevision(p: StoredProvider) {
  return JSON.stringify([
    p.baseUrl,
    p.encryptedKey,
    p.protocol,
    p.uses,
    p.imageProtocol,
    p.videoProtocol,
    p.asrProtocol,
    p.ttsProtocol,
    p.speechProtocol,
  ]);
}
export function videoSpecs(input: { aspect?: unknown; resolution?: unknown; duration?: unknown }): VideoSpecs {
  const result: VideoSpecs = {};
  for (const k of ['aspect', 'resolution', 'duration'] as const) {
    const value = input[k];
    if (value !== undefined && value !== null && value !== '')
      result[k] = text(typeof value === 'number' ? String(value) : value, k, 256);
  }
  return result;
}
export class ModelProviders {
  private requests = new Map<
    string,
    { revision: string; controller: AbortController; promise: Promise<ModelProvider> }
  >();
  private decrypted = new Map<string, string>();
  constructor(
    readonly store: Store,
    private codec: CredentialCodec,
    private changed: () => void = () => {},
  ) {
    if (store.data.providers !== undefined) {
      this.migrateReasoning();
      this.migrateHostedTools();
      this.migrateMedia();
      this.migrateProviderBaseUrls();
      return;
    }
    const legacy = store.data.model,
      providers: StoredProvider[] = [];
    let defaultModel: ModelSelection | undefined;
    if (legacy.model || legacy.encryptedKey || legacy.baseUrl !== 'https://api.openai.com/v1') {
      const backup = join(store.dir, 'providers-migration-backup.json');
      if (!existsSync(backup)) atomicJson(backup, store.data);
      const provider: StoredProvider = {
        id: randomUUID(),
        name: '默认 Provider',
        baseUrl: legacy.baseUrl,
        models: legacy.model ? [{ id: legacy.model }] : [],
        ...(legacy.encryptedKey ? { encryptedKey: legacy.encryptedKey } : {}),
      };
      providers.push(provider);
      if (legacy.model)
        defaultModel = {
          providerId: provider.id,
          model: legacy.model,
          contextTokens: legacy.contextTokens,
          ...(legacy.reasoningEffort ? { reasoningEffort: cleanReasoning(legacy.reasoningEffort) } : {}),
        };
    }
    this.commit({
      providers,
      providerBaseUrlVersion: 1,
      defaultModel,
      ...(legacy.reasoningEffort
        ? {
            bots: store.data.bots.map((bot) => ({
              ...bot,
              reasoningEffort: bot.reasoningEffort ?? cleanReasoning(legacy.reasoningEffort),
            })),
          }
        : {}),
    });
  }
  /** v0.57.1 stored the chat suffix and default OpenAI Images protocol on native connections. */
  private migrateProviderBaseUrls() {
    if (this.store.data.providerBaseUrlVersion === 1) return;
    const providers = this.store.data.providers!.map((p) => {
      // Old media-only native connections on these service roots used a synthetic /v1 that the adapter stripped.
      const oldRoot = /^https:\/\/([^/:?#]+)\/v1\/?$/i.exec(p.baseUrl);
      if (
        oldRoot &&
        !usesModel(p, 'chat') &&
        !usesModel(p, 'asr') &&
        !usesModel(p, 'tts') &&
        ((p.videoProtocol === 'fal' && oldRoot[1] === 'queue.fal.run') ||
          (p.videoProtocol === 'dashscope' &&
            /^(?:dashscope(?:-intl|-us)?\.aliyuncs\.com|[a-z0-9.-]+\.maas\.aliyuncs\.com)$/.test(oldRoot[1])) ||
          (p.videoProtocol === 'seedance' && /^ark\.[a-z0-9-]+\.(?:volces|bytepluses)\.com$/.test(oldRoot[1])) ||
          (p.videoProtocol === 'vidu' && ['api.vidu.com', 'api.vidu.cn'].includes(oldRoot[1])) ||
          (p.videoProtocol === 'luma' && oldRoot[1] === 'api.lumalabs.ai') ||
          (p.videoProtocol === 'minimax-v2' && ['api.minimax.io', 'api.minimaxi.com'].includes(oldRoot[1])) ||
          ((p.videoProtocol === 'gemini' || p.imageProtocol === 'gemini-images') &&
            oldRoot[1] === 'generativelanguage.googleapis.com'))
      )
        return { ...p, baseUrl: new URL(p.baseUrl).origin, modelsCheckedAt: undefined, modelsError: undefined };
      if (
        !/^https:\/\/api\.higgsfield\.ai(?:\/v1)?\/?$/i.test(p.baseUrl) ||
        (!usesModel(p, 'image') && !usesModel(p, 'video'))
      )
        return p;
      const baseUrl = 'https://api.higgsfield.ai';
      const imageProtocol =
        usesModel(p, 'image') && (!p.imageProtocol || p.imageProtocol === 'openai-images')
          ? 'higgsfield-images'
          : p.imageProtocol;
      const videoProtocol =
        usesModel(p, 'video') && (!p.videoProtocol || p.videoProtocol === 'dashscope') ? 'higgsfield' : p.videoProtocol;
      if (p.baseUrl === baseUrl && p.imageProtocol === imageProtocol && p.videoProtocol === videoProtocol) return p;
      return {
        ...p,
        baseUrl,
        imageProtocol,
        videoProtocol,
        modelsCheckedAt: undefined,
        modelsError: undefined,
      } satisfies StoredProvider;
    });
    this.commit({ providers, providerBaseUrlVersion: 1 });
  }
  private migrateMedia() {
    const { bots, providers, mediaDefaults, speech } = this.store.data;
    if (!bots.some((bot) => bot.imageModel || bot.voice)) return;
    const legacy = bots
      .map((bot) => bot.imageModel)
      .filter((item): item is ModelSelection => Boolean(item && providers?.some((p) => p.id === item.providerId)));
    const first = legacy[0];
    const voice = bots.find((bot) => bot.voice)?.voice;
    this.commit({
      bots: bots.map(({ imageModel: _image, voice: _voice, ...bot }) => bot),
      mediaDefaults: mediaDefaults ?? (first ? { image: { providerId: first.providerId, model: first.model } } : {}),
      ...(speech?.output && !speech.output.voice && voice
        ? { speech: { ...speech, output: { ...speech.output, voice } } }
        : {}),
      providers: providers?.map((p) => {
        const ids = new Set(legacy.filter((s) => s.providerId === p.id).map((s) => s.model));
        const models = p.models.map((model) => (ids.delete(model.id) ? { ...model, imageOutput: true } : model));
        return { ...p, models: [...models, ...Array.from(ids, (id) => ({ id, imageOutput: true }))] };
      }),
    });
  }
  private migrateReasoning() {
    const providers = this.store.data.providers!;
    if (!providers.some((provider) => provider.reasoningEffort !== undefined)) return;
    const backup = join(this.store.dir, 'reasoning-migration-backup.json');
    if (!existsSync(backup))
      atomicJson(backup, {
        version: 1,
        providers: providers
          .filter((provider) => provider.reasoningEffort !== undefined)
          .map((provider) => ({ id: provider.id, reasoningEffort: provider.reasoningEffort })),
      });
    const inherited = (selection?: ModelSelection) =>
      selection?.reasoningEffort ??
      providers.find((provider) => provider.id === selection?.providerId)?.reasoningEffort;
    const bots = this.store.data.bots.map((bot) => {
      const effort = bot.reasoningEffort ?? inherited(bot.model || this.store.data.defaultModel);
      return effort ? { ...bot, reasoningEffort: cleanReasoning(effort) } : bot;
    });
    const selection = this.store.data.defaultModel,
      effort = inherited(selection),
      defaultModel = selection && effort ? { ...selection, reasoningEffort: cleanReasoning(effort) } : selection;
    this.commit({
      bots,
      defaultModel,
      providers: providers.map(({ reasoningEffort: _reasoningEffort, ...provider }) => provider),
    });
  }
  private migrateHostedTools() {
    type LegacyModel = ProviderModel & { hostedWebSearch?: boolean; hostedImageGeneration?: boolean };
    const providers = this.store.data.providers;
    if (
      !providers?.some((provider) =>
        provider.models.some((model) => {
          const entry = model as LegacyModel;
          return entry.hostedWebSearch || entry.hostedImageGeneration;
        }),
      )
    )
      return;
    this.commit({
      providers: providers.map((provider) => {
        const models = provider.models as LegacyModel[];
        const hostedWebSearch = Boolean(provider.hostedWebSearch || models.some((model) => model.hostedWebSearch));
        const hostedImageGeneration = Boolean(
          provider.hostedImageGeneration || models.some((model) => model.hostedImageGeneration),
        );
        return {
          ...provider,
          models: models.map(({ hostedWebSearch: _search, hostedImageGeneration: _image, ...model }) => model),
          ...(hostedWebSearch ? { hostedWebSearch: true } : {}),
          ...(hostedImageGeneration ? { hostedImageGeneration: true } : {}),
        };
      }),
    });
  }
  private commit(patch: Partial<Store['data']>) {
    const next = { ...this.store.data, ...patch },
      selection = next.defaultModel,
      provider = next.providers?.find((item) => item.id === selection?.providerId);
    // Retain an encrypted default-config mirror for older clients and rollback.
    next.model =
      provider && selection
        ? {
            baseUrl: provider.baseUrl,
            model: selection.model,
            contextTokens: selection.contextTokens,
            ...(provider.encryptedKey ? { encryptedKey: provider.encryptedKey } : {}),
          }
        : { baseUrl: 'https://api.openai.com/v1', model: '', contextTokens: 32000 };
    this.store.replaceData(next);
    this.changed();
  }
  private provider(id: string) {
    const provider = this.store.data.providers?.find((provider) => provider.id === id);
    if (!provider) throw new AppError('provider.not_found', 'Provider 不存在');
    return provider;
  }
  private keyFor(provider: StoredProvider) {
    const cipher = provider.encryptedKey;
    if (!cipher) return '';
    if (this.decrypted.has(cipher)) return this.decrypted.get(cipher)!;
    try {
      const key = this.codec.decrypt(cipher);
      this.decrypted.set(cipher, key);
      return key;
    } catch {
      return '';
    }
  }
  private public(provider: StoredProvider): ModelProvider {
    const { encryptedKey: _encryptedKey, ...rest } = provider;
    return { ...structuredClone(rest), hasKey: Boolean(this.keyFor(provider)) };
  }
  list() {
    return (this.store.data.providers || []).map((provider) => this.public(provider));
  }
  key(botId?: string, selection?: ModelSelection) {
    const id = this.store.modelFor(botId, selection).providerId;
    return id ? this.keyFor(this.provider(id)) : '';
  }
  config(botId?: string, selection?: ModelSelection) {
    const config = this.store.modelFor(botId, selection);
    const workspace = this.store.data.defaultModel;
    const dedicated = this.store.data.mediaDefaults?.image;
    const inheritHosted =
      !dedicated && workspace?.providerId === config.providerId && workspace?.model === config.model;
    return {
      ...config,
      ...(botId && !selection && !inheritHosted ? { hostedImageGeneration: undefined } : {}),
      hasKey: !config.issue && Boolean(this.key(botId, selection)),
    };
  }
  approvalKey() {
    const config = this.store.modelFor(undefined, this.store.data.approvalModel);
    return config.providerId && !config.issue ? this.keyFor(this.provider(config.providerId)) : '';
  }
  approvalConfig() {
    const config = this.store.modelFor(undefined, this.store.data.approvalModel);
    return { ...config, hasKey: !config.issue && Boolean(this.approvalKey()) };
  }
  private mediaSelection(kind: 'image' | 'video', args: { providerId?: unknown; model?: unknown } = {}) {
    const fallback = this.store.data.mediaDefaults?.[kind];
    if (args.providerId === undefined && args.model === undefined) return fallback;
    const providerId = args.providerId === undefined ? fallback?.providerId : text(args.providerId, 'Provider', 80);
    if (!providerId) throw new AppError('media.provider_required', '请选择 Provider');
    const provider = this.provider(providerId);
    if (!usesModel(provider, kind)) throw new AppError('media.use_disabled', '此连接未启用所选用途');
    const model =
      args.model === undefined && fallback?.providerId === providerId
        ? fallback.model
        : text(args.model, '模型名称', 256);
    return { providerId, model };
  }
  setMediaDefault(kind: 'image' | 'video', value: VideoSelection | null) {
    if (kind !== 'image' && kind !== 'video') throw new AppError('media.kind_invalid', '模型用途无效');
    if (value !== null && (!value || typeof value.providerId !== 'string' || !value.providerId || !value.model))
      throw new AppError('media.selection_invalid', '请选择 Provider 和模型');
    const selection = value && this.mediaSelection(kind, value);
    const mediaDefaults = { ...this.store.data.mediaDefaults };
    if (!selection) delete mediaDefaults[kind];
    else mediaDefaults[kind] = { ...selection, ...videoSpecs(value!) };
    this.commit({ mediaDefaults });
  }
  hasMedia(kind: 'image' | 'video') {
    return this.store.data.providers?.some((p) => usesModel(p, kind)) ?? false;
  }
  mediaCatalog(kind: 'image' | 'video') {
    return (this.store.data.providers || [])
      .filter((p) => usesModel(p, kind))
      .map((p) => ({
        providerId: p.id,
        name: p.name,
        protocol: kind === 'video' ? p.videoProtocol : p.imageProtocol,
        models: p.models.filter((m) => catalogMatches(m, kind)).map((m) => m.id),
        defaultModel:
          this.store.data.mediaDefaults?.[kind]?.providerId === p.id
            ? this.store.data.mediaDefaults[kind]?.model
            : undefined,
      }));
  }
  imageAccess(_botId: string, args: { providerId?: unknown; model?: unknown } = {}) {
    const selection = this.mediaSelection('image', args);
    if (selection) {
      const access = this.imageAccessFor({ ...selection, contextTokens: 32000 });
      const defaults = this.store.data.mediaDefaults?.image;
      if (defaults?.providerId === selection.providerId && defaults.model === selection.model) {
        access.config.imageAspect = defaults.aspect || access.config.imageAspect;
        access.config.imageResolution = defaults.resolution;
      }
      return access;
    }
    // Older workspaces may use the workspace's Responses model for hosted generation.
    const chat = this.config();
    if (chat.protocol !== 'responses' || !chat.hostedImageGeneration || chat.issue) return;
    return {
      config: {
        ...chat,
        reasoningEffort: undefined,
        thinkingBudget: undefined,
        imageProtocol: 'responses-images' as const,
      },
      key: this.key(),
    };
  }
  videoAccess(args: { providerId?: unknown; model?: unknown } = {}) {
    const selection = this.mediaSelection('video', args);
    if (!selection) return;
    const provider = this.provider(selection.providerId);
    if (!provider.videoProtocol || !usesModel(provider, 'video'))
      throw new AppError('media.video_unavailable', '请为此连接选择视频协议');
    const defaults = this.store.data.mediaDefaults?.video;
    return {
      baseUrl: provider.baseUrl,
      key: this.keyFor(provider),
      model: selection.model,
      protocol: provider.videoProtocol,
      defaults:
        defaults?.providerId === selection.providerId && defaults.model === selection.model ? videoSpecs(defaults) : {},
    };
  }
  /** Image access for an arbitrary selection, used by the settings connection test before anything is assigned to a Bot. */
  imageAccessFor(selection: ModelSelection) {
    const config: import('../../../shared/types/core').ModelConfig = this.config(undefined, selection);
    return {
      config: { ...config, reasoningEffort: undefined, thinkingBudget: undefined },
      key: this.key(undefined, selection),
    };
  }
  setApproval(value: unknown) {
    this.commit({ approvalModel: this.selection(value) });
  }
  setMemoryModel(value: unknown) {
    this.commit({ memoryModel: this.selection(value) });
  }
  /** The model chosen for memory's background work, without the reasoning settings of chat models. */
  memoryAccess() {
    const selection = this.store.data.memoryModel;
    if (!selection) return undefined;
    return {
      config: { ...this.config(undefined, selection), reasoningEffort: undefined, thinkingBudget: undefined },
      key: this.key(undefined, selection),
    };
  }
  private speechSelection(value: unknown, kind: 'input' | 'output'): SpeechSelection | undefined {
    const label = kind === 'input' ? '语音识别' : '语音合成';
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'object') throw new AppError('speech.selection_invalid', `${label}设置无效`);
    const input = value as SpeechSelection,
      providerId = text(input.providerId, 'Provider', 80),
      provider = this.provider(providerId),
      protocol = speechProtocolFor(provider, kind),
      model = typeof input.model === 'string' ? input.model.trim() : '',
      voice = typeof input.voice === 'string' ? input.voice.trim() : '';
    if (!usesModel(provider, kind === 'input' ? 'asr' : 'tts'))
      throw new AppError('media.use_disabled', '此连接未启用所选用途');
    if (protocol !== 'deepseek-tools' && !model) throw new AppError('speech.model_required', `请填写${label}模型`);
    if (model.length > 256 || /[\u0000-\u001f]/.test(model) || voice.length > 120 || /[\u0000-\u001f]/.test(voice))
      throw new AppError('speech.selection_invalid', `${label}设置无效`);
    return { providerId, model: protocol === 'deepseek-tools' ? '' : model, ...(voice ? { voice } : {}) };
  }
  setSpeech(value: unknown) {
    const input = (value && typeof value === 'object' ? value : {}) as SpeechSettings,
      recognition = this.speechSelection(input.input, 'input'),
      synthesis = this.speechSelection(input.output, 'output');
    this.commit({
      speech: {
        ...(recognition ? { input: recognition } : {}),
        ...(synthesis ? { output: synthesis } : {}),
        ...(input.connectorVoiceReplies ? { connectorVoiceReplies: true } : {}),
      },
    });
  }
  /**
   * All synthesis callers, including Bot and connector replies, use the workspace voice.
   */
  speechAccess(kind: 'input' | 'output', _botId?: string) {
    const selection = this.store.data.speech?.[kind];
    const provider = selection && this.store.data.providers?.find((item) => item.id === selection.providerId);
    if (!selection || !provider) return undefined;
    const voice = selection.voice;
    return {
      protocol: speechProtocolFor(provider, kind),
      baseUrl: modelEndpoint(provider.baseUrl, 'chat'),
      key: this.keyFor(provider),
      model: selection.model,
      ...(voice ? { voice } : {}),
    };
  }
  secrets() {
    return (this.store.data.providers || []).map((provider) => this.keyFor(provider)).filter(Boolean);
  }
  using(id: string) {
    return this.store.data.bots
      .filter((bot) => this.store.modelSelection(bot.id)?.providerId === id)
      .map((bot) => bot.id);
  }
  catalog(providerId: string, modelId: string) {
    return this.provider(providerId).models.find((model) => model.id === modelId);
  }
  updateModel(providerId: string, input: unknown) {
    const entry = providerModelEntry(input),
      provider = this.provider(providerId);
    const models = [...provider.models];
    const index = models.findIndex((model) => model.id === entry.id),
      prior = index >= 0 ? models[index] : undefined;
    const next = {
      ...entry,
      ...(prior?.catalogOutput ? { catalogOutput: prior.catalogOutput } : {}),
      ...(prior?.supportsImages !== undefined ? { supportsImages: prior.supportsImages } : {}),
    };
    if (index >= 0) models[index] = next;
    else models.push(next);
    models.sort((a, b) => a.id.localeCompare(b.id));
    this.commit({
      providers: this.store.data.providers!.map((item) => (item.id === provider.id ? { ...item, models } : item)),
    });
    return this.public(this.provider(provider.id));
  }
  async prewarm(id: string) {
    const provider = this.provider(id);
    if (!usesModel(provider, 'chat')) return;
    const headers: Record<string, string> = { Accept: 'application/json' };
    const key = this.keyFor(provider);
    if (provider.protocol === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      if (key) headers['x-api-key'] = key;
    } else if (provider.protocol === 'gemini') {
      if (key) headers['x-goog-api-key'] = key;
    } else if (key) headers.Authorization = `Bearer ${key}`;
    await prewarmModelEndpoint(modelEndpoint(provider.baseUrl, provider.protocol), headers);
  }
  selection(value: unknown, use: 'chat' | 'image' = 'chat'): ModelSelection | undefined {
    if (value === null) return undefined;
    if (!value || typeof value !== 'object') throw new Error('请选择 Provider 和模型');
    const input = value as ModelSelection,
      providerId = text(input.providerId, 'Provider', 80),
      model = text(input.model, '模型名称', 256),
      contextTokens = input.contextTokens;
    if (!usesModel(this.provider(providerId), use)) throw new AppError('media.use_disabled', '此连接未启用对话模型');
    if (!Number.isInteger(contextTokens) || contextTokens < 8000 || contextTokens > 1000000)
      throw new AppError('model.context_tokens_invalid', '上下文容量应为 8000–1000000');
    const effort = cleanReasoning(input.reasoningEffort);
    return { providerId, model, contextTokens, ...(effort ? { reasoningEffort: effort } : {}) };
  }
  setDefault(value: unknown) {
    this.commit({ defaultModel: this.selection(value) });
  }
  setBot(botId: string, value: unknown) {
    this.store.bot(botId);
    const selection = this.selection(value);
    this.commit({ bots: this.store.data.bots.map((bot) => (bot.id === botId ? { ...bot, model: selection } : bot)) });
  }
  save(input: ProviderInput) {
    const name = text(input?.name, 'Provider 名称', 80);
    const previous = input.id ? this.provider(text(input.id, 'Provider', 80)) : undefined;
    const baseUrl = validateModelEndpoint(text(input.baseUrl, 'Base URL', 2000));
    const fields = { ...previous, ...input };
    if (officialHiggsfield(baseUrl)) {
      if (usesModel(fields, 'image')) fields.imageProtocol ??= 'higgsfield-images';
      if (usesModel(fields, 'video')) fields.videoProtocol ??= 'higgsfield';
    }
    const parameters = modelParameters(fields);
    if (previous) {
      const id = previous.id,
        data = this.store.data;
      const assigned: [ModelUse, boolean][] = [
        [
          'chat',
          [data.defaultModel, data.approvalModel, data.memoryModel, ...data.bots.map((b) => b.model)].some(
            (s) => s?.providerId === id,
          ),
        ],
        ['image', data.mediaDefaults?.image?.providerId === id],
        ['video', data.mediaDefaults?.video?.providerId === id],
        ['asr', data.speech?.input?.providerId === id],
        ['tts', data.speech?.output?.providerId === id],
      ];
      if (assigned.some(([kind, used]) => used && !usesModel(parameters, kind)))
        throw new AppError('provider.in_use', '请先切换使用此连接的模型');
    }
    delete parameters.reasoningEffort;
    if (this.store.data.providers?.some((provider) => provider.id !== previous?.id && provider.name === name))
      throw new Error('已有同名 Provider，请使用不同名称');
    if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== 'string')
      throw new Error('API Key 无效');
    if (input.apiKey && input.apiKey.length > 4000) throw new Error('API Key 过长');
    const changedOrigin = previous && new URL(previous.baseUrl).origin !== new URL(baseUrl).origin;
    const supplied = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (/[\u0000-\u001f\u007f]/.test(supplied)) throw new Error('API Key 不能包含换行或控制字符');
    if (changedOrigin && previous.encryptedKey && !supplied && input.apiKey !== null)
      throw new AppError('provider.api_key_required', '更换服务地址后请重新填写 API Key');
    const encryptedKey = supplied
      ? this.codec.encrypt(supplied)
      : input.apiKey === null
        ? undefined
        : previous?.encryptedKey;
    const connectionChanged =
      !previous ||
      previous.baseUrl !== baseUrl ||
      previous.encryptedKey !== encryptedKey ||
      previous.protocol !== parameters.protocol;
    const catalogChanged =
      previous &&
      (JSON.stringify(catalogSources(previous)) !== JSON.stringify(catalogSources({ ...parameters, baseUrl })) ||
        JSON.stringify(previous.uses) !== JSON.stringify(parameters.uses));
    const provider: StoredProvider = {
      id: previous?.id || randomUUID(),
      name,
      baseUrl,
      ...(isOpenCodeEndpoint(baseUrl) ? { opencode: true } : {}),
      models: connectionChanged ? [] : previous.models,
      ...(!connectionChanged && !catalogChanged
        ? {
            modelsUpdatedAt: previous.modelsUpdatedAt,
            modelsCheckedAt: previous.modelsCheckedAt,
            modelsError: previous.modelsError,
          }
        : {}),
      ...(encryptedKey ? { encryptedKey } : {}),
    };
    Object.assign(provider, parameters);
    this.requests.get(provider.id)?.controller.abort();
    this.requests.delete(provider.id);
    if (previous?.encryptedKey && previous.encryptedKey !== encryptedKey) this.decrypted.delete(previous.encryptedKey);
    this.commit({
      providers: previous
        ? this.store.data.providers!.map((item) => (item.id === provider.id ? provider : item))
        : [...this.store.data.providers!, provider],
    });
    return this.public(provider);
  }
  remove(id: string) {
    const previous = this.provider(id);
    if (
      this.store.data.mediaDefaults?.image?.providerId === id ||
      this.store.data.mediaDefaults?.video?.providerId === id ||
      this.store.data.defaultModel?.providerId === id ||
      this.store.data.approvalModel?.providerId === id ||
      this.store.data.memoryModel?.providerId === id ||
      this.store.data.speech?.input?.providerId === id ||
      this.store.data.speech?.output?.providerId === id ||
      this.using(id).length
    )
      throw new AppError(
        'provider.in_use',
        '此 Provider 仍被默认模型、自动审核模型、记忆模型、语音或 Bot 使用，请先切换模型',
      );
    this.requests.get(id)?.controller.abort();
    this.requests.delete(id);
    this.commit({ providers: this.store.data.providers!.filter((provider) => provider.id !== id) });
    if (previous.encryptedKey) this.decrypted.delete(previous.encryptedKey);
  }
  refresh(id: string): Promise<ModelProvider> {
    const provider = this.provider(id);
    const sources = catalogSources(provider);
    if (!sources.length) return Promise.resolve(this.public(provider));
    const revision = catalogRevision(provider);
    const existing = this.requests.get(id);
    if (existing?.revision === revision) return existing.promise;
    existing?.controller.abort();
    const controller = new AbortController();
    const pending = (async () => {
      const found = new Map<string, ProviderModel>(),
        problems: string[] = [];
      const results = await Promise.allSettled(
        sources.map((source) =>
          loadProviderCatalog(
            source,
            provider,
            source === 'higgsfield' || source === 'fal' ? '' : this.keyFor(provider),
            controller.signal,
          ),
        ),
      );
      const secrets = this.secrets();
      let successful = false;
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          problems.push(redactHost(String(result.reason?.message || result.reason), secrets).slice(0, 400));
          continue;
        }
        if (
          !['higgsfield', 'fal'].includes(sources[index]) &&
          result.value.some((m) => secrets.some((secret) => m.id.includes(secret)))
        ) {
          problems.push('模型列表包含凭据信息');
          continue;
        }
        successful = true;
        for (const model of result.value) found.set(model.id, { ...found.get(model.id), ...model });
      }
      const current = this.store.data.providers?.find((provider) => provider.id === id);
      if (!current) throw new AppError('provider.deleted', 'Provider 已删除');
      if (controller.signal.aborted || catalogRevision(current) !== revision) return this.public(current);
      const previous = new Map(current.models.map((model) => [model.id, model]));
      const models = [...found.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((model) => ({ ...previous.get(model.id), ...model }));
      for (const model of current.models)
        if (
          !found.has(model.id) &&
          (!model.catalogOutput ||
            problems.length ||
            Object.keys(model).some((field) => field !== 'id' && field !== 'catalogOutput'))
        )
          models.push(model);
      const stamp = new Date().toISOString(),
        next = {
          ...current,
          models: successful ? models : current.models,
          modelsCheckedAt: stamp,
          modelsUpdatedAt: successful ? stamp : current.modelsUpdatedAt,
          modelsError: problems.length ? problems.join(' · ').slice(0, 400) : undefined,
        };
      this.commit({ providers: this.store.data.providers!.map((provider) => (provider.id === id ? next : provider)) });
      return this.public(next);
    })();
    this.requests.set(id, { revision, controller, promise: pending });
    void pending
      .finally(() => {
        if (this.requests.get(id)?.promise === pending) this.requests.delete(id);
      })
      .catch(() => {});
    return pending;
  }
  dispose() {
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    this.decrypted.clear();
    disposeModelHttp();
  }
}
