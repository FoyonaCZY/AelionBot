import type { BotMention, PeerRunOrigin } from '../../../shared/types/peer-types';
import type { GroupRunOrigin } from '../../../shared/types/group-types';
export interface HarnessRunOptions {
  designSessionId?: string;
  /** A work session of the Bot (see WorkSession); absent for its main chat. */
  sessionId?: string;
  resumeRunId?: string;
  workItemId?: string;
  workspaceDir?: string | null;
  attachments?: import('../../../shared/types/attachment-types').Attachment[];
  inputMessageIds?: string[];
  supersedesRunId?: string;
  reactionMessageId?: string;
  mentions?: BotMention[];
  peerOrigin?: PeerRunOrigin;
  groupOrigin?: GroupRunOrigin;
  groupContext?: string;
  groupTaskFrom?: string;
  privateSessionId?: string;
  peerContext?: string;
  onStarted?: (runId: string) => void;
}
export interface PeerGateway {
  waitResult?: (
    botId: string,
    runId: string,
    exchangeId: string,
    signal: AbortSignal,
  ) => Promise<{
    content: string;
    attachments?: import('../../../shared/types/attachment-types').Attachment[];
    receipt?: unknown;
  }>;
  directory(botId: string): unknown;
  send(
    botId: string,
    runId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    options: HarnessRunOptions,
  ): unknown;
  readForBot(botId: string, args: Record<string, unknown>): unknown;
}
