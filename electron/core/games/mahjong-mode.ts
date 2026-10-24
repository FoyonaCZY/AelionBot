import type { GameMode } from './game-mode';
import {
  acceptMahjong,
  checkMahjongSeats,
  createMahjong,
  mahjongFacts,
  validateMahjong,
  viewMahjong,
  type MahjongState,
} from './mahjong';
import { mahjongInstructions, mahjongPrompt } from './mahjong-prompt';

export const mahjongMode: GameMode<MahjongState> = {
  id: 'mahjong',
  checkSeats: checkMahjongSeats,
  create: ({ groupId, players, tableTalk }) => createMahjong(groupId, players, { tableTalk }),
  describe: (s) =>
    `规则 mahjong-tuidaohu-v1；AI 牌桌闲聊${s.tableTalk ? '开' : '关'}；136 张无花，不吃，可碰杠和；限时出牌真人30秒、AI 60秒（超时摸切），碰杠和真人15秒、AI 30秒（超时过）；AI 多次给不出可用行动也按超时处理`,
  validate: validateMahjong,
  accept: acceptMahjong,
  // Your own turn discards the tile just drawn; a claim passes.
  timeoutAction: (r) => (r.canPass ? { skip: true } : { target: r.targets.find((t) => t.startsWith('d:')) }),
  timesModels: true,
  view: viewMahjong,
  instructions: mahjongInstructions,
  prompt: mahjongPrompt,
  skills: () => [],
  facts: mahjongFacts,
};
