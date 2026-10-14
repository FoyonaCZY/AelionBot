import type { GameModeId } from '../../../shared/types/game-types';
import { AppError } from '../../../shared/errors';
import type { GameMode } from './game-mode';
import { assignPersonas, assignSeatPersonas, personaPick, type PickRules } from './persona-play';
import { gameInstructions, gamePrompt } from './model-player';
import { gameSkills } from './skills';
import { werewolfFacts } from './werewolf-facts';
import { acceptAction, createWerewolf, validateAction, view, type WerewolfState } from './werewolf';
import {
  UNDERCOVER_SEATS,
  acceptUndercover,
  createUndercover,
  undercoverFacts,
  validateUndercover,
  viewUndercover,
  type UndercoverState,
} from './undercover';
import { undercoverInstructions, undercoverPrompt } from './undercover-prompt';
import type { Plan } from '../../../shared/persona/persona-model';

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

/** Players do not know whether they are spies, so every seat draws from the same plans. */
const UNDERCOVER_PLANS: Plan[] = [
  {
    id: 'undercover_direct',
    role: 'undercover:player',
    name: '直白描述',
    detail: '描述贴近词的核心特征，让同伴尽快认出你',
    f: { risk: 1, assert: 1 },
  },
  {
    id: 'undercover_vague',
    role: 'undercover:player',
    name: '含糊描述',
    detail: '先只说边缘特征，听完别人再决定说多少',
    f: { risk: -1, assert: -1 },
  },
];
const UNDERCOVER_PICK: PickRules<UndercoverState> = { key: ['vote'], strong: (_, r) => r.targets.length === 1 };

const undercover: GameMode<UndercoverState> = {
  id: 'undercover',
  checkSeats: (count) => {
    if (count < UNDERCOVER_SEATS.min || count > UNDERCOVER_SEATS.max) throw Error('谁是卧底需要 4–10 位玩家');
  },
  create: ({ groupId, players, blank }) => createUndercover(groupId, players, { blank }),
  describe: (s, aiTimeoutMs) =>
    `规则 undercover-v1；词库 ${s.words.version}（${s.words.pairId}）；真人描述90秒、投票45秒；AI响应${aiTimeoutMs / 1000}秒，超时暂停且保留行动`,
  validate: validateUndercover,
  accept: acceptUndercover,
  timeoutAction: (r) => (r.kind === 'vote' ? { skip: true } : {}),
  view: viewUndercover,
  instructions: undercoverInstructions,
  prompt: undercoverPrompt,
  skills: () => [],
  facts: undercoverFacts,
  persona: {
    assign: (s, seeds) => assignSeatPersonas(s, seeds, () => ({ key: 'undercover:player', plans: UNDERCOVER_PLANS })),
    pick: (s, r, action, valid, input) => personaPick(s, r, action, valid, input, UNDERCOVER_PICK),
  },
};

/** A saved match of any game; post-match effects narrow it by `mode`. */
export type AnyMatch = WerewolfState | UndercoverState;

const MODES: Record<GameModeId, GameMode<any>> = { werewolf, undercover };

/** The game mode of a saved match or a view; matches from before game modes existed are Werewolf. */
export function gameMode(id: GameModeId | undefined = 'werewolf'): GameMode<AnyMatch> {
  if (!Object.hasOwn(MODES, id)) throw new AppError('game.unknown_mode', '未知的游戏');
  return MODES[id];
}
