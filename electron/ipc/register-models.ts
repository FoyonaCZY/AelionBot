import { videoSourceUrl, type VideoSource } from '../core/video/video-protocols';
import { generateVideo } from '../core/video/video-generation';
import { ATTACHMENT_LIMITS } from '../../shared/types/attachment-types';
import { AppError } from '../../shared/errors';
import { usesModel } from '../../shared/types/media-types';
import { validateModelEndpoint } from '../core/model/model';
import { probeImageModel, storeImageRoutes } from '../core/image/image-generation';
import { imageProtocolCatalog } from '../core/image/image-protocols';
import { isImageGenerationError } from '../core/image/image-errors';
import { usageReport } from '../core/app/usage-report';
import type { IpcContext } from './context';

export function registerModels(ctx: IpcContext) {
  const { handle } = ctx;
  handle('imageProtocols', () => imageProtocolCatalog());
  handle('testImageModel', async (input) => {
    const selection = ctx.providers.selection(input?.selection, 'image');
    if (!selection) throw new Error('请先选择生图 Provider 和模型');
    const access = ctx.providers.imageAccessFor(selection);
    if (access.config.issue) throw new Error(access.config.issue);
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(new Error('生图连接测试超时')), 120000);
    try {
      return await probeImageModel({
        model: ctx.model,
        config: access.config,
        key: access.key,
        signal: controller.signal,
        routes: storeImageRoutes(ctx.store),
      });
    } catch (error) {
      if (isImageGenerationError(error))
        throw new Error(`${error.message}${error.detail ? `（${error.detail}）` : ''}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
  let videoTest: { id: string; controller: AbortController } | undefined;
  handle('cancelVideoTest', (id) => {
    if (videoTest?.id === id) videoTest.controller.abort();
  });
  handle('testVideoModel', async (input) => {
    if (videoTest) throw new AppError('video.test_busy', '测试视频正在生成');
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 100 ||
      !input.id ||
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      input.prompt.length > 32000
    )
      throw new AppError('video.test_invalid', '请填写有效的视频提示词');
    const asset = input.source;
    let source: VideoSource | undefined;
    if (asset) {
      if (typeof asset !== 'object') throw new AppError('video.input_invalid', '素材格式或大小无效');
      if ('url' in asset) {
        if (asset.kind !== 'image' && asset.kind !== 'video') throw new AppError('video.input_invalid', '素材类型无效');
        source = videoSourceUrl(asset.kind, asset.url);
      } else {
        if (
          !(asset.bytes instanceof Uint8Array) ||
          !asset.bytes.length ||
          asset.bytes.length > ATTACHMENT_LIMITS.fileBytes ||
          !/^(image|video)\/[a-z0-9.+-]+$/i.test(asset.mime)
        )
          throw new AppError('video.input_invalid', '素材格式或大小无效');
        source = {
          kind: asset.mime.startsWith('image/') ? 'image' : 'video',
          mime: asset.mime,
          bytes: Buffer.from(asset.bytes),
        };
      }
    }
    const access = ctx.providers.videoAccess();
    if (!access) throw new AppError('media.video_unavailable', '请先保存视频模型');
    const controller = new AbortController();
    videoTest = { id: input.id, controller };
    try {
      const result = await generateVideo(
        access,
        {
          prompt: input.prompt,
          source,
        },
        controller.signal,
      );
      return { bytes: new Uint8Array(result.bytes), mime: 'video/' + result.extension };
    } finally {
      videoTest = undefined;
    }
  });
  handle('setMediaDefault', (kind, selection) => {
    ctx.providers.setMediaDefault(kind, selection);
  });
  handle('setSpeech', (settings) => {
    ctx.providers.setSpeech(settings);
  });
  handle('transcribeSpeech', async (input) => {
    const audio = input?.audio;
    if (!(audio instanceof Uint8Array) || !audio.length) throw new Error('没有录到声音');
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(new Error('语音识别超时')), 5 * 60000);
    try {
      return { text: (await ctx.speech.transcribe(Buffer.from(audio), controller.signal)).text };
    } finally {
      clearTimeout(timer);
    }
  });
  handle('synthesizeSpeech', async (input) => {
    const text = typeof input?.text === 'string' ? input.text : '';
    if (text.length > 20000) throw new Error('一次朗读的文字太长');
    const botId = typeof input?.botId === 'string' ? ctx.store.bot(input.botId).id : undefined;
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(new Error('语音合成超时')), 3 * 60000);
    try {
      const audio = await ctx.speech.synthesize(text, controller.signal, botId);
      return { audio: new Uint8Array(audio.bytes), mime: audio.mime };
    } finally {
      clearTimeout(timer);
    }
  });
  handle('queryUsage', (input) =>
    usageReport(ctx.store.data.modelUsage || [], ctx.providers.list(), input, {
      currency: ctx.spending.settings().currency,
      cost: (record) => ctx.spending.cost(record),
      priceOf: (providerId, model) => ctx.spending.priceOf(providerId, model),
    }),
  );
  handle('saveSpending', (input) => ctx.spending.save(input));
  handle('setModelPrice', (input) => ctx.spending.setPrice(input));
  handle('listModelPrices', () => ctx.spending.prices());
  handle('refreshModelPrices', () => ctx.spending.refreshPrices());
  handle('saveProvider', async (input) => {
    ctx.beforeModelChange(input?.id ? ctx.providers.using(String(input.id)) : []);
    try {
      const provider = ctx.providers.save(input);
      if (!usesModel(provider, 'chat')) return provider;
      const refreshed = await ctx.providers.refresh(provider.id);
      void ctx.providers.prewarm(provider.id);
      return refreshed;
    } finally {
      ctx.afterModelChange();
    }
  });
  handle('refreshProviderModels', async (id) => {
    const provider = await ctx.providers.refresh(String(id));
    void ctx.providers.prewarm(String(id));
    return provider;
  });
  handle('updateProviderModel', (input) => {
    ctx.beforeModelChange(ctx.providers.using(String(input?.providerId)));
    const provider = ctx.providers.updateModel(String(input?.providerId), input?.model);
    ctx.afterModelChange();
    return provider;
  });
  handle('removeProvider', (id) => {
    ctx.providers.remove(String(id));
    ctx.afterModelChange();
  });
  handle('setApprovalModel', (selection) => {
    ctx.providers.setApproval(selection);
  });
  handle('setDefaultModel', (selection) => {
    ctx.providers.selection(selection);
    ctx.beforeModelChange(ctx.store.data.bots.filter((bot) => !bot.model).map((bot) => bot.id));
    ctx.providers.setDefault(selection);
    ctx.afterModelChange();
  });
  handle('setBotModel', (input) => {
    const id = ctx.store.bot(String(input?.botId)).id;
    ctx.providers.selection(input?.selection);
    ctx.beforeModelChange([id]);
    ctx.providers.setBot(id, input.selection);
    ctx.afterModelChange();
  });
  handle('saveModel', async (input) => {
    const baseUrl = validateModelEndpoint(String(input?.baseUrl || ''));
    const name = String(input?.model || '').trim();
    if (!name || name.length > 150) throw new Error('请输入模型名称');
    const contextTokens = Number(input.contextTokens);
    if (!Number.isInteger(contextTokens) || contextTokens < 8000 || contextTokens > 1000000)
      throw new Error('上下文容量应为 8000–1000000');
    const existing = ctx.providers.list().find((provider) => provider.id === ctx.store.data.defaultModel?.providerId);
    ctx.beforeModelChange([
      ...new Set([
        ...ctx.store.data.bots.filter((bot) => !bot.model).map((bot) => bot.id),
        ...(existing ? ctx.providers.using(existing.id) : []),
      ]),
    ]);
    try {
      const provider = ctx.providers.save({
        id: existing?.id,
        name: existing?.name || `默认 Provider ${ctx.providers.list().length + 1}`,
        baseUrl,
        apiKey: input.apiKey,
      });
      ctx.providers.setDefault({ providerId: provider.id, model: name, contextTokens });
      await ctx.providers.refresh(provider.id);
    } finally {
      ctx.afterModelChange();
    }
  });
  handle('testModel', async () => {
    const result = await ctx.model.complete(
      [{ role: 'user', content: 'Reply with READY only.' }],
      [],
      new AbortController().signal,
    );
    return result.content.slice(0, 200);
  });
}
