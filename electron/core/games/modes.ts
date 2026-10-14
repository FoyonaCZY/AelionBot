import type { GameModeId } from '../../../shared/types/game-types';
import { AppError } from '../../../shared/errors';
import type { GameMode } from './game-mode';
import { assignPersonas, personaPick } from './persona-play';
import { gameInstructions, gamePrompt } from './model-player';
import { gameSkills } from './skills';
import { werewolfFacts } from './werewolf-facts';
import { acceptAction, createWerewolf, validateAction, view, type WerewolfState } from './werewolf';

const werewolf: GameMode<WerewolfState> = {
  id: 'werewolf',
  checkSeats: (count) => {
    if (![7, 12].includes(count)) throw Error('需要七位或十二位玩家');
  },
  create: ({ groupId, players, board }) => createWerewolf(groupId, players, undefined, board),
  describe: (s, aiTimeoutMs) =>
    `规则 ${s.twelve ? s.twelve.board + '-sheriff-v1' : 'seven-player-v1'}；真人发言120秒、行动45秒；AI响应${aiTimeoutMs / 1000}秒，超时暂停且保留行动`,
  validate: validateAction,
  accept: acceptAction,
  timeoutAction: (r) => (r.kind === 'speak' ? { text: '（发言超时）' } : {}),
  view,
  instructions: gameInstructions,
  prompt: gamePrompt,
  skills: gameSkills,
  facts: (s) => werewolfFacts({ ...s, events: s.events || [] }),
  persona: { assign: assignPersonas, pick: personaPick },
};

/** A saved match of any game; post-match effects narrow it by `mode`. */
export type AnyMatch = WerewolfState;

const MODES: Record<GameModeId, GameMode<any>> = { werewolf };

/** The game mode of a saved match or a view; matches from before game modes existed are Werewolf. */
export function gameMode(id: GameModeId | undefined = 'werewolf'): GameMode<AnyMatch> {
  if (!Object.hasOwn(MODES, id)) throw new AppError('game.unknown_mode', '未知的游戏');
  return MODES[id];
}
