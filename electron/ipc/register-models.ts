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
    const selection = ctx.providers.selection(input?.selection);
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
  handle('queryUsage', (input) => usageReport(ctx.store.data.modelUsage || [], ctx.providers.list(), input));
  handle('saveProvider', async (input) => {
    ctx.beforeModelChange(input?.id ? ctx.providers.using(String(input.id)) : []);
    try {
      const provider = ctx.providers.save(input);
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
