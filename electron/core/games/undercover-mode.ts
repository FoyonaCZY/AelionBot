import type { Plan } from '../../../shared/persona/persona-model';
import type { GameMode } from './game-mode';
import { assignSeatPersonas, personaPick, type PickRules } from './persona-play';
import {
  acceptUndercover,
  checkUndercoverSeats,
  createUndercover,
  undercoverFacts,
  validateUndercover,
  viewUndercover,
  type UndercoverState,
} from './undercover';
import { undercoverInstructions, undercoverPrompt } from './undercover-prompt';

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

export const undercoverMode: GameMode<UndercoverState> = {
  id: 'undercover',
  checkSeats: checkUndercoverSeats,
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
