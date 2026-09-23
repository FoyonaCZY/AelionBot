import type {HarnessRunOptions} from './peer-runtime-types';
import type {BotMention} from '../../src/peer-types';
import type {GroupMessage} from '../../src/group-types';
export interface GroupGateway {
  receive?(botId:string,runId:string):GroupMessage[];
  taskFrame?(botId:string,runId:string):string;
  unfinished?(botId:string,runId:string):boolean;
  blockUnfinished?(botId:string,runId:string,reason:string):boolean;
  prepareReply(botId:string,runId:string,content:string):{content:string;mentions:BotMention[]};
  publishProgress(botId:string,runId:string,content:string):void;
  invoke(botId:string,runId:string,name:string,args:Record<string,unknown>,signal:AbortSignal,options:HarnessRunOptions):unknown|Promise<unknown>;
}
