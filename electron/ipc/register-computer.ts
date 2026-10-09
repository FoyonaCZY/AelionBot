import { changeManualControl } from '../core/agent/interactions';
import type { IpcContext } from './context';

export function registerComputer(ctx: IpcContext) {
  const { handle } = ctx;
  handle('vmAction', async (action) => {
    if (!['prepare', 'start', 'stop', 'restart', 'repair-tools'].includes(action)) throw new Error('不支持的维护操作');
    if (ctx.harness.busy && action !== 'prepare') throw new Error('Bot 正在工作，请先停止任务再维护电脑');
    if (action === 'prepare') await ctx.vm.prepare();
    if (action === 'start') await ctx.vm.start();
    if (action === 'stop') await ctx.vm.stop();
    if (action === 'restart') await ctx.vm.restart();
    if (action === 'repair-tools') await ctx.vm.repairTools();
    ctx.changed();
  });
  handle('saveVmStorageSettings', async (value) => {
    await ctx.vm.saveStorageSettings(value);
    ctx.changed();
  });
  handle('reclaimVmStorage', async () => {
    if (
      ctx.harness.busy ||
      ctx.groupChats?.busy ||
      ctx.greetings?.botIds.length ||
      ctx.chatPins?.anyPending(ctx.store.data.bots.map((bot) => bot.id)) ||
      ctx.interactions.snapshot().length ||
      ctx.previewDirty ||
      ctx.previewWrites ||
      Object.values(ctx.computer.state.desktops).some((desktop) => desktop.manualControl)
    )
      throw Error('请先结束任务、保存修改并交还电脑控制，再回收空间');
    await ctx.vm.reclaimStorage();
    ctx.changed();
  });
  handle('vmTerminal', (command) => {
    if (typeof command !== 'string') throw new Error('无效命令');
    return ctx.vm.execute(command, 'manual');
  });
  handle('screenshot', (id) => {
    if (
      ![...ctx.store.data.messages, ...ctx.store.data.peerMessages, ...ctx.store.data.groupRunMessages].some(
        (message) => message.screenshotId === id,
      )
    )
      throw new Error('截图不存在');
    return ctx.computer.image(String(id));
  });
  handle('ensureComputerDesktop', (id) => {
    const bot = ctx.store.bot(String(id));
    return ctx.computer.ensure(bot.id);
  });
  handle('setComputerControl', async (input) => {
    const bot = ctx.store.bot(String(input?.botId));
    if (typeof input?.enabled !== 'boolean') throw new Error('无效控制状态');
    await ctx.computer.ensure(bot.id);
    // Taking over stops the chat driving the desktop, not the Bot's other chats.
    return changeManualControl(ctx.interactions, ctx.computer, bot.id, input.enabled, (id) => {
      const lane = ctx.generalHarness.desktopSession(id);
      ctx.harness.cancel(id, lane === undefined ? undefined : lane);
    });
  });
  handle('openComputerApp', async (input) => {
    const bot = ctx.store.bot(String(input?.botId));
    if (ctx.computer.stateFor(bot.id).ownerBotId) throw new Error('Bot 正在操作桌面，请先接管电脑');
    await ctx.computer.openApp(bot.id, input.app);
  });
}
