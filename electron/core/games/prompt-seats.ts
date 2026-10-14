import { createHash } from 'node:crypto';
import type { GameRequest, GameView } from '../../../shared/types/game-types';

/**
 * Models see seats as "N号玩家", never members' names, and texts are rewritten to match. Longest names are
 * replaced first so a name inside another name is not split.
 *
 * Names are plain substrings, so a short name also matches inside ordinary words: a seat named 月 would turn
 * 赏月 into 赏2号玩家. Quoted words (「…」) are never rewritten, and in what players wrote (`speech`) only names
 * of two or more characters are; the rules engine's own lines always name seats exactly.
 */
export function seatAliases(seats: GameView['seats']) {
  const aliases = seats.map((p, i) => ({ id: p.id, name: `${i + 1}号玩家`, original: p.name }));
  const longestFirst = [...aliases].sort((a, b) => b.original.length - a.original.length);
  const replace = (text: string, speech: boolean) => {
    for (const p of longestFirst)
      if (p.original && p.original !== '你' && !(speech && p.original.length < 2))
        text = text.split(p.original).join(p.name);
    return text;
  };
  const alias = (text: string, speech = false) =>
    text
      .split(/(「[^」]*」)/)
      .map((part) => (part.startsWith('「') && part.endsWith('」') ? part : replace(part, speech)))
      .join('');
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
