import type {HarnessRunOptions} from './peer-runtime-types';
import type {BotMention} from '../../src/peer-types';
export interface GroupGateway {
  prepareReply(botId:string,runId:string,content:string):{content:string;mentions:BotMention[]};
  publishProgress(botId:string,runId:string,content:string):void;
  invoke(botId:string,runId:string,name:string,args:Record<string,unknown>,signal:AbortSignal,options:HarnessRunOptions):unknown|Promise<unknown>;
}
