import {createHash} from 'node:crypto';
import type {RequestCacheDiagnostics} from '../../src/runtime-types';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)??'null').digest('hex');
export const promptCacheKey=(provider:string,scope:string,purpose:string)=>'aelion-'+hash([provider,scope,purpose]).slice(0,48);
const CHUNK=1024,MAX_CHUNKS=4096,MAX_SCOPES=64;
interface Fingerprint {config:string;tools:string;system:string;messages:string[];blocks:string[];bytes:number;}

// Retain hashes and sizes only: no prompt text, credentials, image data or tool output.
export class PromptCacheDiagnostics {
 private previous=new Map<string,Fingerprint>();
 record(scope:string,body:Record<string,any>):RequestCacheDiagnostics{
  const {input,messages,contents,tools,system,systemInstruction,...config}=body;
  const history=input??messages??contents??[],wire=Buffer.from(JSON.stringify(history));
  const current:Fingerprint={config:hash(config),tools:hash(tools),system:hash(system??systemInstruction),messages:history.slice(0,4096).map((item:unknown)=>hash(item)),blocks:[],bytes:wire.length};
  for(let start=0;start<wire.length&&current.blocks.length<MAX_CHUNKS;start+=CHUNK)current.blocks.push(hash(wire.subarray(start,start+CHUNK).toString('base64')));
  const previous=this.previous.get(scope);this.previous.delete(scope);this.previous.set(scope,current);
  if(this.previous.size>MAX_SCOPES)this.previous.delete(this.previous.keys().next().value!);
  let sameMessages=0,blocks=0;
  if(previous){while(sameMessages<Math.min(previous.messages.length,current.messages.length)&&previous.messages[sameMessages]===current.messages[sameMessages])sameMessages++;while(blocks<Math.min(previous.blocks.length,current.blocks.length)&&previous.blocks[blocks]===current.blocks[blocks])blocks++;}
  const difference=!previous?'first-request':previous.config!==current.config?'request-options':previous.tools!==current.tools?'tools':previous.system!==current.system?'system':sameMessages<Math.min(previous.messages.length,current.messages.length)?'message':previous.messages.length!==current.messages.length?'message-count':'none';
  return {version:1,scopeFingerprint:hash(scope),optionsFingerprint:current.config,toolsFingerprint:current.tools,inputFingerprint:hash(history),inputBytes:wire.length,inputMessages:history.length,compared:Boolean(previous),firstDifference:difference,...(difference==='message'?{firstDifferentMessage:sameMessages}:{}),matchingPrefixMessages:sameMessages,matchingInputPrefixBytes:previous?Math.min(blocks*CHUNK,current.bytes,previous.bytes):0,prefixScanTruncated:wire.length>CHUNK*MAX_CHUNKS,promptCacheKeySent:typeof body.prompt_cache_key==='string'};
 }
}

export function rejectsPromptCacheKey(body:string){
 try{const error=JSON.parse(body)?.error;if(error?.param==='prompt_cache_key'&&/unknown|unsupported|unrecognized|extra|not.allowed/i.test(String(error.code)+' '+String(error.message)))return true;}catch{}
 return /prompt_cache_key/i.test(body)&&/unknown|unsupported|not supported|unrecognized|extra (?:field|input|parameter)|not permitted|不支持|未知参数/i.test(body);
}
