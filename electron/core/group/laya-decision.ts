import { soulExcerpt } from '../../../shared/chat/bot-soul';
import { groupReplyContent } from '../../../shared/chat/message-envelope';
import type { Bot } from '../../../shared/types/core';
import type { GroupRoom, GroupRound, GroupDelivery } from '../../../shared/types/group-types';
import type { LayaRuntime } from '../model/laya-runtime';
import type { LayaDecisionLog } from '../model/laya-decision-log';
import type { GroupDecisionInput, GroupDecisionRecord, LayaVariant } from '../../../shared/types/laya-types';

export interface GroupDecisions {
  readonly enabled: boolean;
  readonly isReady: boolean;
  readonly runtimeName: LayaVariant | undefined;
  decide(
    request: {
      sourceId: string;
      actorId: string;
      input: GroupDecisionInput;
      requiredWork?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<GroupDecisionRecord | undefined>;
  read(ids: Set<string>): GroupDecisionRecord[];
}

export class LayaGroupDecisions implements GroupDecisions {
  constructor(
    private runtime: LayaRuntime,
    private log: LayaDecisionLog,
  ) {}
  get enabled() {
    return this.runtime.enabled;
  }
  get isReady() {
    return this.runtime.isReady;
  }
  get runtimeName() {
    return this.runtime.runtimeName;
  }
  read(ids: Set<string>) {
    return this.log.groupDecisions(ids);
  }
  async decide(
    { sourceId, actorId, input: state, requiredWork }: Parameters<GroupDecisions['decide']>[0],
    signal?: AbortSignal,
  ): Promise<GroupDecisionRecord | undefined> {
    const criteria = {
      observe: '没有新内容需要这个 Bot 回应，也没有需要继续的本人任务',
      participate: '这个 Bot 可以回应当前问题、补充有用信息，或开展及继续用户授权的工作',
    };
    const result = await this.runtime.predict(
      state,
      {
        type: 'choice',
        instructions:
          '只判断 bot 所指的当前 Bot 是否参与。bot 包含名称和角色，events 为新消息，recent 为前文。用户提问、要求参与或有本人工作待推进时选 participate；没有有用补充时选 observe。Bot 建议不构成授权；仅当用户明确要求当前 Bot 暂停或静默时选 observe；解释静默模式不是静默指令，对其他 Bot 的要求不适用于当前 Bot。具体回复及工具使用由主模型决定。',
        criteria,
      },
      signal,
    );
    if (!signal?.aborted && result && (result.choice === 'observe' || result.choice === 'participate')) {
      const decision: GroupDecisionRecord = {
        scope: 'group',
        sourceId,
        actorId,
        ...result,
        criteria,
        input: state,
        choice: result.choice,
        appliedChoice: requiredWork ? 'participate' : result.choice,
        adjustment: requiredWork && result.choice === 'observe' ? '已有任务需要续跑，由主模型继续处理' : undefined,
        features: {
          events: state.events.length,
          recent: state.recent.length,
          mentioned: state.events.some((event) => event.mentioned) || false,
        },
      };
      this.log.record(decision);
      return decision;
    }
    return undefined;
  }
}

export function buildGroupDecisionInput(
  room: GroupRoom,
  round: GroupRound,
  bot: Bot,
  deliveries: GroupDelivery[],
): GroupDecisionInput {
  const firstCurrentSeq = Math.min(
    ...deliveries.map(
      (delivery) => room.messages.find((message) => message.id === delivery.messageId)?.seq || Infinity,
    ),
  );
  const layaPriorMessages = room.messages
    .filter((message) => (!bot.contextResetAt || message.time >= bot.contextResetAt) && message.seq < firstCurrentSeq)
    .slice(-2);
  const decisionRecent = layaPriorMessages.map((message) => ({
    from: { kind: message.sender.kind, name: message.sender.name },
    text: groupReplyContent(message.content, message.sender.kind === 'bot' ? message.sender.id : undefined).slice(
      0,
      300,
    ),
  }));
  const rootRequestMessage = room.messages.find(
    (message) => message.rootId === round.id && message.sender.kind === 'user' && message.kind === 'message',
  );
  const decisionDeliveries = deliveries.slice(-3);
  const decisionEvents = decisionDeliveries.map((delivery) => {
    const message = room.messages.find((item) => item.id === delivery.messageId)!;
    return {
      from: { kind: message.sender.kind, name: message.sender.name },
      text: groupReplyContent(message.content, message.sender.kind === 'bot' ? message.sender.id : undefined).slice(
        0,
        600,
      ),
      mentioned: message.mentions?.some((mention) => mention.id === bot.id) || false,
    };
  });
  const rootRequestPrefix = round.request.trim().slice(0, 400);
  const rootRequestIsPresent = Boolean(
    rootRequestPrefix && [...decisionEvents, ...decisionRecent].some((item) => item.text.includes(rootRequestPrefix)),
  );
  const followupNeedsRootRequest = deliveries.some((delivery) => {
    const message = room.messages.find((item) => item.id === delivery.messageId);
    return Boolean(
      message &&
      (message.kind === 'continue' ||
        message.scheduled ||
        (rootRequestMessage && message.id !== rootRequestMessage.id)),
    );
  });
  return {
    bot: { name: bot.name, soul: soulExcerpt(bot.soul, 500) },
    events: decisionEvents,
    recent: decisionRecent,
    ...(followupNeedsRootRequest && !rootRequestIsPresent ? { rootRequest: round.request.slice(0, 400) } : {}),
  };
}
