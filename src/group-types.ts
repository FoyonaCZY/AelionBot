import type {Attachment} from './attachment-types';
import type {MessagePin,PinEvent} from './reactions';
import type {BotIdentity,BotMention} from './peer-types';
import type {ScheduledTrigger} from './scheduled-types';
export const GROUP_LIMITS={bots:8,repetitions:3,groupsPerTask:2} as const;
const conversationTools=new Set(['plan_update','goal_set','goal_read','goal_update','task_read','task_update','execution_list','execution_resolve','attachment_read','read_result','scheduled_tasks_list','scheduled_task_create','scheduled_task_update','scheduled_task_delete','groups_list','group_read','group_create','group_invite','group_send_message','bots_list','bot_read_messages','bot_send_message','history_search','history_read','group_pin','chat_pin']);
export const isGroupWorkTool=(name:string|undefined)=>Boolean(name&&!conversationTools.has(name));
export type GroupSender={kind:'user';id:'user';name:string}|({kind:'bot'}&BotIdentity)|{kind:'system';id:'system';name:string};
export interface GroupMember extends BotIdentity {joinedAt:string;leftAt?:string;}
export interface GroupLifecycleEvent {type:'created'|'members_changed';actor:GroupSender;joined:BotIdentity[];left:BotIdentity[];members:BotIdentity[];}
export interface GroupMessage {workItemId?:string;workspaceDir?:string|null;scheduled?:ScheduledTrigger;attachments?:Attachment[];pins?:MessagePin[];reaction?:PinEvent;event?:GroupLifecycleEvent;id:string;seq:number;groupId:string;sender:GroupSender;kind:'message'|'system'|'continue'|'reaction'|'progress';content:string;time:string;rootId?:string;replyTo?:string;runIds?:string[];mentions?:BotMention[];}
export interface GroupRoom {id:string;name:string;members:GroupMember[];createdBy:GroupSender;createdAt:string;updatedAt:string;messages:GroupMessage[];lastReadSeq:number;activeRootId?:string;}
export interface GroupRound {id:string;originKey?:string;groupId:string;request:string;status:'active'|'limited'|'stopped';createdAt:string;botMessages:number;botCounts:Record<string,number>;decisions:number;createdGroups:number;reason?:string;repetitions?:number;}
export type GroupDeliveryStatus='queued'|'deciding'|'running'|'ignored'|'replied'|'limited'|'failed'|'cancelled'|'interrupted'|'delivered'|'read';
export interface GroupDelivery {retryRunId?:string;id:string;groupId:string;messageId:string;recipientId:string;rootId:string;status:GroupDeliveryStatus;createdAt:string;reason?:string;runId?:string;replyMessageId?:string;}
export interface GroupRunOrigin {groupId:string;rootId:string;deliveryId:string;}
export interface GroupSummary {id:string;name:string;members:GroupMember[];createdBy:GroupSender;updatedAt:string;preview:string;unread:number;lastSeq:number;pending:number;round?:{id:string;status:GroupRound['status'];botMessages:number;reason?:string};activities?:Array<{botId:string;phase:'deciding'|'running'|'updating'}>;activity?:{botId:string;phase:'deciding'|'running'};}
export interface GroupPage {pins?:Record<string,MessagePin[]>;group:GroupSummary;messages:GroupMessage[];deliveries:GroupDelivery[];before?:string;}
export interface GroupsView {revision:number;rooms:GroupSummary[];limits:typeof GROUP_LIMITS;}
export interface GroupLink {groupId:string;action:'created'|'invited';}
export const groupPending=(status:GroupDeliveryStatus)=>['queued','deciding','running'].includes(status);
export function groupDeliveryLabel(status:GroupDeliveryStatus){return ({queued:'已收到，等待处理',deciding:'正在判断是否需要回复',running:'正在处理',ignored:'已查看，无需回复',replied:'已回复',limited:'已收到，本轮已静默',failed:'暂未处理',cancelled:'已停止',interrupted:'应用中断，未重新执行',delivered:'已送达',read:'已读'} as const)[status];}
