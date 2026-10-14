import type { GameModeId } from '../../../shared/types/game-types';
import { AppError } from '../../../shared/errors';
import type { GameMode } from './game-mode';
import type { WerewolfState } from './werewolf';
import type { UndercoverState } from './undercover';
import { werewolfMode } from './werewolf-mode';
import { undercoverMode } from './undercover-mode';

/** A saved match of any game; post-match effects narrow it by `mode`. */
export type AnyMatch = WerewolfState | UndercoverState;

const MODES: Record<GameModeId, GameMode<any>> = { werewolf: werewolfMode, undercover: undercoverMode };

/** The game mode of a saved match or a view; matches from before game modes existed are Werewolf. */
export function gameMode(id: GameModeId | undefined = 'werewolf'): GameMode<AnyMatch> {
  if (!Object.hasOwn(MODES, id)) throw new AppError('game.unknown_mode', '未知的游戏');
  return MODES[id];
}
