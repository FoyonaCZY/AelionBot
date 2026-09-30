import type { GroupDecisionRecord, LayaVariant } from './laya-types';
import type { MessageReply } from '../chat/message-replies';
import type { Attachment } from './attachment-types';
import type { MessagePin, PinEvent } from '../chat/reactions';
import type { BotIdentity, BotMention } from './peer-types';
import type { ScheduledTrigger } from './scheduled-types';
export const GROUP_LIMITS = {
  bots: 8,
  repetitions: 3,
  groupsPerTask: 2,
  /** Bot-to-bot messages since the user's last message before Bots stop waking each other. */
  botStreak: 10,
  /** Messages exchanged by one pair of Bots since the user's last message before they stop waking each other. */
  pairStreak: 4,
  /** Seconds others wait for an addressed Bot, or for replies still being written, before continuing. */
  holdSeconds: 20,
} as const;
const conversationTools = new Set([
  'open_preview',
  'code_exec',
  'request_user_input',
  'user_input_wait',
  'view_image',
  'tool_search',
  'web_search',
  'web_read',
  'mcp_list_resource_templates',
  'terminal_read',
  'plan_update',
  'goal_set',
  'goal_read',
  'goal_update',
  'task_read',
  'task_update',
  'execution_list',
  'execution_resolve',
  'attachment_read',
  'read_result',
  'scheduled_tasks_list',
  'scheduled_task_create',
  'scheduled_task_update',
  'scheduled_task_delete',
  'groups_list',
  'group_read',
  'group_create',
  'group_invite',
  'group_send_message',
  'bots_list',
  'bot_read_messages',
  'bot_send_message',
  'history_search',
  'history_read',
  'group_react',
  'chat_pin',
  'group_outbox',
  // Legacy tool names that may still appear in stored execution records.
  'group_pin',
  'group_tasks',
  'group_task_claim',
  'group_task_update',
]);
export const isGroupWorkTool = (name: string | undefined) => Boolean(name && !conversationTools.has(name));
export type GroupSender =
  | { kind: 'user'; id: 'user'; name: string }
  | ({ kind: 'bot' } & BotIdentity)
  | { kind: 'system'; id: 'system'; name: string };
interface GroupMember extends BotIdentity {
  joinedAt: string;
  leftAt?: string;
}
export interface GroupLifecycleEvent {
  type: 'created' | 'members_changed';
  actor: GroupSender;
  joined: BotIdentity[];
  left: BotIdentity[];
  members: BotIdentity[];
}
export interface GroupMessage {
  designSessionId?: string;
  previewPrompt?: string;
  reply?: MessageReply;
  workItemId?: string;
  workspaceDir?: string | null;
  scheduled?: ScheduledTrigger;
  attachments?: Attachment[];
  pins?: MessagePin[];
  reaction?: PinEvent;
  event?: GroupLifecycleEvent;
  id: string;
  seq: number;
  groupId: string;
  sender: GroupSender;
  kind: 'message' | 'system' | 'continue' | 'reaction' | 'progress';
  content: string;
  time: string;
  rootId?: string;
  replyTo?: string;
  runIds?: string[];
  mentions?: BotMention[];
  /** The message whose delivery woke the Bot that sent this message. */
  answers?: string;
  /** A system notice about the discussion itself; it is posted at most once per user message. */
  notice?: 'pair_limit' | 'bot_limit' | 'unanswered';
}
export interface GroupOutbox {
  id: string;
  botId: string;
  groupId: string;
  rootId: string;
  runId: string;
  key: string;
  content: string;
  mentions: BotMention[];
  attachments?: Attachment[];
  kind: 'message' | 'progress';
  replyTo?: string;
  answers?: string;
  status: 'pending' | 'sent';
  createdAt: string;
  messageId?: string;
  designSessionId?: string;
}
export interface GroupRoom {
  id: string;
  name: string;
  members: GroupMember[];
  createdBy: GroupSender;
  createdAt: string;
  updatedAt: string;
  messages: GroupMessage[];
  lastReadSeq: number;
  activeRootId?: string;
  /** Legacy group task records. They are kept untouched and no longer read or written. */
  tasks?: unknown[];
}
export interface GroupRound {
  id: string;
  originKey?: string;
  groupId: string;
  request: string;
  status: 'active' | 'limited' | 'stopped';
  createdAt: string;
  botMessages: number;
  botCounts: Record<string, number>;
  decisions: number;
  createdGroups: number;
  reason?: string;
  repetitions?: number;
}
export type GroupDeliveryStatus =
  | 'queued'
  | 'deciding'
  | 'running'
  | 'ignored'
  | 'replied'
  | 'limited'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'delivered'
  | 'read';
export interface GroupDelivery {
  retryRunId?: string;
  layaDecisionId?: string;
  id: string;
  groupId: string;
  messageId: string;
  recipientId: string;
  rootId: string;
  status: GroupDeliveryStatus;
  createdAt: string;
  reason?: string;
  runId?: string;
  replyMessageId?: string;
  /** Result of triage: wake the recipient, or leave the message read without waking it. */
  triage?: 'wake' | 'skip';
  /** The recipient was addressed and must answer, at least with a reaction. */
  must?: boolean;
}
interface GroupLayaDecision extends GroupDecisionRecord {
  messageId: string;
  deliveryStatus: GroupDeliveryStatus;
  replyMessageId?: string;
  runId?: string;
  reason?: string;
}
export interface GroupRunOrigin {
  groupId: string;
  rootId: string;
  deliveryId: string;
}
export interface GroupSummary {
  id: string;
  name: string;
  members: GroupMember[];
  createdBy: GroupSender;
  updatedAt: string;
  preview: string;
  unread: number;
  lastSeq: number;
  pending: number;
  round?: { id: string; status: GroupRound['status']; botMessages: number; reason?: string };
  activities?: Array<{ botId: string; phase: 'deciding' | 'running' | 'updating' }>;
  activity?: { botId: string; phase: 'deciding' | 'running' };
}
export interface GroupPage {
  pins?: Record<string, MessagePin[]>;
  group: GroupSummary;
  messages: GroupMessage[];
  deliveries: GroupDelivery[];
  laya?: { runtime?: LayaVariant; enabled: boolean; ready?: boolean; decisions: GroupLayaDecision[] };
  before?: string;
}
export interface GroupsView {
  revision: number;
  rooms: GroupSummary[];
  limits: typeof GROUP_LIMITS;
}
export interface GroupLink {
  groupId: string;
  action: 'created' | 'invited';
}
export const groupPending = (status: GroupDeliveryStatus) => ['queued', 'deciding', 'running'].includes(status);
