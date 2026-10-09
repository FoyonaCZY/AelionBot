import type { IpcContext } from './context';
import type { GamePlayer } from '../../shared/types/game-types';
export function registerGames(ctx: IpcContext) {
  const { handle } = ctx;
  handle('games.create', (input) => {
    const group = ctx.store.data.groups.find((g) => g.id === input.groupId);
    if (!group) throw Error('群聊不存在');
    // A seat whose id is a current member Bot is that Bot; other AI seats are temporary guests.
    // The renderer cannot claim a Bot identity: any botId it sends is dropped and derived here.
    const members = new Set(group.members.filter((m) => !m.leftAt).map((m) => m.id));
    const players = Array.isArray(input.players)
      ? input.players.map((p: GamePlayer) => {
          if (!p || typeof p !== 'object') return p;
          const seat = { ...p };
          delete seat.botId;
          return !seat.human && members.has(seat.id) ? { ...seat, botId: seat.id } : seat;
        })
      : input.players;
    return ctx.games!.create({ ...input, players });
  });
  handle('games.inspect', (input) => ctx.games!.inspect(input.id));
  handle('games.read', (input) => ctx.games!.read(input.groupId, input.omniscient === true));
  handle('games.act', (input) => ctx.games!.act(input.id, input.requestId, input.action));
  handle('games.control', (input) => ctx.games!.control(input.id, input.action));
}
