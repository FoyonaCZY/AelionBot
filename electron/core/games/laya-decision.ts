import type { GameRequest, GameView } from '../../../shared/types/game-types';
import type { LayaRuntime } from '../model/laya-runtime';
import type { LayaDecisionLog } from '../model/laya-decision-log';

export class LayaGameDecisions {
  constructor(
    private runtime: LayaRuntime,
    private log: LayaDecisionLog,
  ) {}
  get isReady() {
    return this.runtime.isReady;
  }
  async game(sourceId: string, actorId: string, view: GameView, request: GameRequest) {
    const options =
      request.kind === 'speak' ||
      request.kind === 'campaign' ||
      request.kind === 'pk_speak' ||
      request.kind === 'last_words'
        ? {
            claim: '主要是身份声明或查验宣称',
            accuse: '主要是指控或推动投票',
            defend: '主要是辩护或回应质疑',
            probe: '主要是试探、提问或分析',
            other: '其他发言',
          }
        : Object.fromEntries(
            request.targets
              .slice(0, 12)
              .map((id, i) => ['seat_' + i, view.seats.find((p) => p.id === id)?.name || String(i + 1)]),
          );
    if (Object.keys(options).length < 2) return;
    const result = await this.runtime.predict(
      {
        day: view.day,
        phase: view.phase,
        kind: request.kind,
        seats: view.seats.map((p) => ({ name: p.name, alive: p.alive, role: p.role })),
        visibleLogs: view.logs.slice(-6).map((log) => log.text.slice(0, 250)),
        selfRole: view.seats.find((p) => p.id === actorId)?.role,
      },
      {
        type: 'choice',
        instructions: '根据该玩家可见信息选择最值得考虑的候选。发言时选择话语类型，行动时选择目标。',
        criteria: options,
      },
    );
    if (result) this.log.record({ scope: 'game', sourceId, actorId, ...result });
  }
  async speech(sourceId: string, actorId: string, text: string) {
    const result = await this.runtime.predict(text.slice(0, 800), {
      type: 'choice',
      instructions: '这段狼人杀公开发言主要在做什么？只识别说话行为，不判断身份真假。',
      criteria: {
        claim: '声明身份或声称获得查验结果',
        accuse: '指控他人或推动投票',
        defend: '为自己或他人辩护',
        probe: '提问、试探或分析线索',
        other: '其他发言',
      },
    });
    if (result) this.log.record({ scope: 'game_speech', sourceId, actorId, ...result });
  }
}
