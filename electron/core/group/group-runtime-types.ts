import type { HarnessRunOptions } from '../agent/peer-runtime-types';
import type { BotMention } from '../../../shared/types/peer-types';
import type { GroupMessage } from '../../../shared/types/group-types';
export interface GroupGateway {
  receive?(botId: string, runId: string): GroupMessage[];
  prepareReply(botId: string, runId: string, content: string): { content: string; mentions: BotMention[] };
  publishProgress(botId: string, runId: string, content: string): void;
  invoke(
    botId: string,
    runId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    options: HarnessRunOptions,
  ): unknown | Promise<unknown>;
}
