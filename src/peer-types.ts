import type {DelegationContract,DelegationReceipt} from '../electron/core/delegation';
import type {Attachment} from './attachment-types';
import {translate} from './i18n';
export interface BotIdentity {id:string;name:string;color:string;avatarStyle?:import('./bot-colors').BotAvatarStyle;}
export interface BotMention extends BotIdentity {start:number;end:number;}
export type PeerStatus='queued'|'working'|'waiting'|'reply_queued'|'relaying'|'completed'|'cancelled'|'failed'|'interrupted';
export interface PeerMessage {attachments?:Attachment[];id:string;exchangeId:string;sender:BotIdentity;content:string;time:string;kind:'request'|'reply'|'progress';}
export interface PeerThread {id:string;members:[BotIdentity,BotIdentity];createdAt:string;updatedAt:string;messages:PeerMessage[];}
export interface PeerExchange {retryRunId?:string;task?:DelegationContract;receipt?:DelegationReceipt;
  id:string;threadId:string;fromBotId:string;toBotId:string;rootRunId:string;rootBotId:string;rootRequest:string;parentId?:string;
  status:PeerStatus;createdAt:string;updatedAt:string;requestMessageId:string;replyMessageId?:string;userSummaryMessageId?:string;activeRunId?:string;error?:string;
}
export type PeerExchangeView=Pick<PeerExchange,'id'|'threadId'|'fromBotId'|'toBotId'|'parentId'|'status'|'createdAt'|'updatedAt'|'error'>;
export interface PeerThreadSummary {id:string;members:[BotIdentity,BotIdentity];updatedAt:string;preview:string;messageCount:number;pending:number;}
export interface PeerChatPage {thread:PeerThreadSummary;messages:PeerMessage[];exchanges:PeerExchangeView[];before?:string;}
export interface PeerView {revision:number;threads:PeerThreadSummary[];exchanges:PeerExchangeView[];}
export interface PeerRunOrigin {kind:'peer_request'|'peer_result'|'peer_summary'|'peer_task';exchangeId:string;sessionId?:string;}
export const isPrivatePeerOrigin=(origin?:PeerRunOrigin)=>Boolean(origin&&origin.kind!=='peer_task');
export interface PeerNotice {exchangeId:string;direction:'sent'|'received'|'failed';}
export const peerPending=(status:PeerStatus)=>!['completed','cancelled','failed','interrupted'].includes(status);
export function peerStatusLabel(status:PeerStatus){return translate(({queued:'等待处理',working:'等待回复',waiting:'等待回复',reply_queued:'等待整理',relaying:'正在整理回复',completed:'已回复',cancelled:'已取消',failed:'未能完成',interrupted:'已中断'} as const)[status]);}
