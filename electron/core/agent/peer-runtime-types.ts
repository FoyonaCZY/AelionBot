import type { BotMention, PeerRunOrigin } from '../../../shared/types/peer-types';
import type { GroupRunOrigin } from '../../../shared/types/group-types';
export interface HarnessRunOptions {
  designSessionId?: string;
  /** The design task on the conversation's canvas; the Bot continues it with design_use only for design work. */
  openDesignSessionId?: string;
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
  /** The group's standing rules; kept in its own system message so an unchanged copy is never sent twice. */
  groupContext?: string;
  /** This member's personality and its feelings about the people in this wake. */
  groupPersona?: string;
  /** What only this wake carries, such as the user requests handed to the member. */
  groupTurn?: string;
  groupTaskFrom?: string;
  privateSessionId?: string;
  peerContext?: string;
  onStarted?: (runId: string) => void;
  /** Live assistant text updates during a run (cleaned of reasoning tags and internal markers). */
  onAssistantStream?: (event: { runId: string; messageId: string; content: string; reset?: boolean }) => void;
  /** An assistant turn whose text is finalized before tools run or the next turn begins. */
  onAssistantMessage?: (event: {
    runId: string;
    messageId: string;
    content: string;
    presentation: 'progress' | 'answer';
  }) => void;
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
