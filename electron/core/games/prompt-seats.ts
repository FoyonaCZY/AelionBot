import { createHash } from 'node:crypto';
import type { GameRequest, GameView } from '../../../shared/types/game-types';

/**
 * Models see seats as "N号玩家", never members' names, and texts are rewritten to match. Longest names are
 * replaced first so a name inside another name is not split.
 */
export function seatAliases(seats: GameView['seats']) {
  const aliases = seats.map((p, i) => ({ id: p.id, name: `${i + 1}号玩家`, original: p.name }));
  const alias = (text: string) => {
    for (const p of [...aliases].sort((a, b) => b.original.length - a.original.length))
      if (p.original && p.original !== '你') text = text.split(p.original).join(p.name);
    return text;
  };
  return { aliases, alias };
}

/** A request-stable permutation, so the first seat is not always presented as the first target. */
export function shuffledTargets(request: GameRequest) {
  const rank = (id: string) =>
    createHash('sha256')
      .update(request.id + ':' + id)
      .digest('hex');
  return [...request.targets].sort((a, b) => rank(a).localeCompare(rank(b)));
}
