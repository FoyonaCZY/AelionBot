import type { IpcContext } from './context';

export function registerGames(ctx: IpcContext) {
  const { handle } = ctx;
  handle('games.create', (input) => {
    if (!ctx.store.data.groups.some((g) => g.id === input.groupId)) throw Error('群聊不存在');
    return ctx.games!.create(input);
  });
  handle('games.inspect', (input) => ctx.games!.inspect(input.id));
  handle('games.read', (input) => ctx.games!.read(input.groupId, input.omniscient === true));
  handle('games.act', (input) => ctx.games!.act(input.id, input.requestId, input.action));
  handle('games.control', (input) => ctx.games!.control(input.id, input.action));
}
