import type { IpcContext } from './context';

export function registerGroups(ctx: IpcContext) {
  const { handle } = ctx;
  handle('pinGroup', (input) => ctx.groupChats!.pinUser(input));
  handle('createGroup', (input) => ctx.groupChats!.create(input));
  handle('updateGroup', (input) => ctx.groupChats!.update(input));
  handle('deleteGroup', (id) => {
    ctx.groupChats!.delete(id);
    ctx.scheduler?.removeTarget({ kind: 'group', id });
  });
  handle('readGroup', (input) => ctx.groupChats!.read(input));
  handle('sendGroup', (input) => {
    const room = ctx.store.data.groups.find((room) => room.id === input?.id);
    if (
      room &&
      !room.members.some(
        (member) =>
          !member.leftAt &&
          ctx.store.data.bots.some((bot) => bot.id === member.id) &&
          ctx.store.modelFor(member.id).model,
      )
    )
      throw new Error('请先为群内 Bot 选择模型');
    ctx.groupChats!.send(input);
  });
  handle('markGroupRead', (input) => ctx.groupChats!.markRead(input));
  handle('stopGroup', (id) => ctx.groupChats!.stop(id));
  handle('continueGroup', (id) => ctx.groupChats!.continue(id));
}
