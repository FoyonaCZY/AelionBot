import type { GameMode } from './game-mode';
import {
  acceptDoudizhu,
  checkDoudizhuSeats,
  createDoudizhu,
  doudizhuFacts,
  validateDoudizhu,
  viewDoudizhu,
  type DoudizhuState,
} from './doudizhu';
import { doudizhuInstructions, doudizhuPrompt } from './doudizhu-prompt';

export const doudizhuMode: GameMode<DoudizhuState> = {
  id: 'doudizhu',
  checkSeats: checkDoudizhuSeats,
  create: ({ groupId, players, tableTalk }) => createDoudizhu(groupId, players, { tableTalk }),
  describe: (s) =>
    `规则 doudizhu-v1；AI 牌桌闲聊${s.tableTalk ? '开' : '关'}；三人叫分（1–3 分），炸弹、王炸、春天翻倍；限时叫分真人30秒、AI 60秒，出牌真人45秒、AI 90秒，超时不叫或不要（先出时出最小的牌）；AI 多次给不出可用行动也按超时处理`,
  validate: validateDoudizhu,
  accept: acceptDoudizhu,
  // Leading cannot pass: the lowest play (the first option) goes out instead.
  timeoutAction: (r) => (r.canPass || !r.options?.length ? { skip: true } : { target: r.options[0].id }),
  timesModels: true,
  view: viewDoudizhu,
  instructions: doudizhuInstructions,
  prompt: doudizhuPrompt,
  skills: () => [],
  facts: doudizhuFacts,
};
