import { botType } from '../../shared/types/designer-types';
import { updateBotProfile } from '../core/agent/bot-profile';
import { reasoningEffort as cleanReasoning } from '../../shared/chat/reasoning';
import type { IpcContext } from './context';

export function registerBots(ctx: IpcContext) {
  const { handle } = ctx;
  handle('createBot', (input) => {
    if (
      !input ||
      typeof input.name !== 'string' ||
      typeof input.soul !== 'string' ||
      (input.color !== undefined && typeof input.color !== 'string')
    )
      throw new Error('无效 Bot 参数');
    const model = input.model ? ctx.providers.selection(input.model) : undefined,
      imageModel = input.imageModel ? ctx.providers.selection(input.imageModel) : undefined,
      reasoningEffort = cleanReasoning(
        input.reasoningEffort === undefined ? ctx.store.data.defaultModel?.reasoningEffort : input.reasoningEffort,
      );
    const bot = ctx.store.createBot(input.name, input.soul, input.color, input.avatarStyle, {
      model,
      imageModel,
      reasoningEffort,
      type: botType(input.type),
    });
    ctx.changed();
    if (bot.type !== 'designer') void ctx.greetings?.greet(bot.id);
    return bot;
  });
  handle('deleteBot', async (id) => {
    if (typeof id !== 'string') throw new Error('无效 Bot 参数');
    if (ctx.harness.isRunning(id)) throw new Error('请先停止这个 Bot 的任务并等待结束，再删除');
    await ctx.harness.stopBotProcesses(id);
    ctx.greetings?.cancel(id);
    ctx.chatPins?.cancel(id);
    ctx.peerChats?.deletingBot(id);
    ctx.groupChats?.deletingBot(id);
    ctx.store.deleteBot(id);
    ctx.integrations.skills.forgetBot(id);
    ctx.scheduler?.removeTarget({ kind: 'bot', id });
    ctx.cognition.deleteBot(id);
    ctx.computer.forget(id);
    ctx.changed();
  });
  handle('updateBot', (input) => {
    if (input.defaultDesignSystemId) ctx.designSystems.get(input.defaultDesignSystemId);
    const typeChanged = input.type !== undefined && botType(input.type) !== botType(ctx.store.bot(input.id).type);
    if (typeChanged && (ctx.updatePreparing || ctx.harness.isRunning(input.id)))
      throw Error('请先结束当前任务，再切换 Bot 类型');
    const modelChanged = updateBotProfile(ctx.store, ctx.providers, input, (id) => ctx.beforeModelChange([id]));
    if (typeChanged) {
      ctx.greetings?.cancel(input.id);
      ctx.chatPins?.cancel(input.id);
      ctx.cognition.deleteBot(input.id);
      ctx.designStore.clearBot(input.id);
      ctx.changed();
      return;
    }
    if (modelChanged) ctx.afterModelChange();
    else {
      ctx.greetings?.cancel(input.id);
      ctx.changed();
      void ctx.greetings?.greet(input.id);
    }
  });
}
