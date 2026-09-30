import { soulExcerpt } from '../../../shared/chat/bot-soul';
import { groupReplyContent } from '../../../shared/chat/message-envelope';
import type { Bot } from '../../../shared/types/core';
import type { GroupMessage, GroupRoom } from '../../../shared/types/group-types';
import type { LayaRuntime } from '../model/laya-runtime';
import type { LayaDecisionLog } from '../model/laya-decision-log';
import type { GroupDecisionInput, GroupDecisionRecord, LayaVariant } from '../../../shared/types/laya-types';

export interface GroupDecisions {
  readonly enabled: boolean;
  readonly isReady: boolean;
  readonly runtimeName: LayaVariant | undefined;
  decide(
    request: { sourceId: string; actorId: string; input: GroupDecisionInput },
    signal?: AbortSignal,
  ): Promise<GroupDecisionRecord | undefined>;
  read(ids: Set<string>): GroupDecisionRecord[];
}

/**
 * Laya answers one relevance question for messages nobody addressed to this Bot. Whether and how to
 * speak is left to the main model once the Bot is woken; addressed messages never reach Laya.
 */
const GROUP_DECISION_CRITERIA = {
  observe: '不回应：这条消息和当前 Bot 的职责、手上的事都无关',
  participate: '回应：这条消息和当前 Bot 的职责或手上的事有关',
};

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
    { sourceId, actorId, input: state }: Parameters<GroupDecisions['decide']>[0],
    signal?: AbortSignal,
  ): Promise<GroupDecisionRecord | undefined> {
    const criteria = GROUP_DECISION_CRITERIA;
    const result = await this.runtime.predict(
      state,
      {
        type: 'choice',
        instructions:
          '判断 bot 所指的当前 Bot 要不要回应 message。bot.role 是它的职责，work 是它手上的事，repliedTo 是 message 回复的消息，answer 是被点名成员已给出的答复。只判断 message 和它的职责或手上的事是否相关。',
        criteria,
      },
      signal,
    );
    if (signal?.aborted || !result || (result.choice !== 'observe' && result.choice !== 'participate'))
      return undefined;
    const decision: GroupDecisionRecord = {
      scope: 'group',
      sourceId,
      actorId,
      ...result,
      criteria,
      input: state,
      choice: result.choice,
      appliedChoice: result.choice,
      features: {
        repliedTo: Boolean(state.repliedTo),
        answered: Boolean(state.answer),
        working: state.work !== '空闲',
      },
    };
    this.log.record(decision);
    return decision;
  }
}

const decisionMessage = (message: GroupMessage, max: number) => ({
  from: { kind: message.sender.kind, name: message.sender.name },
  text: groupReplyContent(message.content, message.sender.kind === 'bot' ? message.sender.id : undefined).slice(0, max),
});
export function buildGroupDecisionInput(
  room: GroupRoom,
  bot: Bot,
  message: GroupMessage,
  work: string,
  answer?: GroupMessage,
): GroupDecisionInput {
  const targetId = message.reply?.messageId || message.replyTo,
    repliedTo = targetId ? room.messages.find((item) => item.id === targetId) : undefined;
  return {
    bot: { name: bot.name, role: soulExcerpt(bot.soul, 300) },
    work,
    message: decisionMessage(message, 600),
    ...(repliedTo ? { repliedTo: decisionMessage(repliedTo, 300) } : {}),
    ...(answer ? { answer: decisionMessage(answer, 300) } : {}),
  };
}
