import type {BotMention,PeerRunOrigin} from '../../src/peer-types';
import type {GroupRunOrigin} from '../../src/group-types';
export interface HarnessRunOptions {attachments?:import('../../src/attachment-types').Attachment[];inputMessageIds?:string[];supersedesRunId?:string;reactionMessageId?:string;mentions?:BotMention[];peerOrigin?:PeerRunOrigin;groupOrigin?:GroupRunOrigin;groupContext?:string;groupTaskFrom?:string;privateSessionId?:string;peerContext?:string;onStarted?:(runId:string)=>void;}
export interface PeerGateway {
  directory(botId:string):unknown;
  send(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,options:HarnessRunOptions):unknown;
  readForBot(botId:string,args:Record<string,unknown>):unknown;
}
