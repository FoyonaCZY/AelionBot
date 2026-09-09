import {createHash} from 'node:crypto';
import type {RequestCacheDiagnostics} from '../../src/runtime-types';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)??'null').digest('hex');
const hashBytes=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
export const promptCacheKey=(provider:string,scope:string,purpose:string)=>'aelion-'+hash([provider,scope,purpose]).slice(0,48);
const CHUNK=1024,MAX_CHUNKS=4096,MAX_MESSAGES=4096,MAX_SCOPES=64;
interface Fingerprint {config:string;tools:string;toolSchemas:Record<string,string>;system:string;inputHash:string;messageCount:number;messages:string[];blocks:string[];bytes:number;}
function toolSchemas(tools:unknown){
 if(!Array.isArray(tools))return {};
 return Object.fromEntries(tools.filter(tool=>tool&&typeof tool==='object').flatMap(tool=>Array.isArray(tool.functionDeclarations)?tool.functionDeclarations:[tool]).filter(tool=>tool&&typeof tool==='object').flatMap(tool=>{
  const name=tool.function?.name??tool.name;return typeof name==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(name)?[[name,hash(tool)]]:[];
 }).slice(0,256));
}

// Retain hashes and sizes only: no prompt text, credentials, image data or tool output.
export class PromptCacheDiagnostics {
 private previous=new Map<string,Fingerprint>();
 record(scope:string,body:Record<string,any>):RequestCacheDiagnostics{
  const {input,messages,contents,tools,system,systemInstruction,...config}=body;
  const payload=input??messages??contents??[],history=Array.isArray(payload)?payload:[payload],wire=Buffer.from(JSON.stringify(history));
  const current:Fingerprint={config:hash(config),tools:hash(tools),toolSchemas:toolSchemas(tools),system:hash(system??systemInstruction),inputHash:hashBytes(wire),messageCount:history.length,messages:history.slice(0,MAX_MESSAGES).map((item:unknown)=>hash(item)),blocks:[],bytes:wire.length};
  for(let start=0;start<wire.length&&current.blocks.length<MAX_CHUNKS;start+=CHUNK)current.blocks.push(hashBytes(wire.subarray(start,start+CHUNK)));
  const previous=this.previous.get(scope);this.previous.delete(scope);this.previous.set(scope,current);
  if(this.previous.size>MAX_SCOPES)this.previous.delete(this.previous.keys().next().value!);
  let sameMessages=0,blocks=0;
  if(previous){while(sameMessages<Math.min(previous.messages.length,current.messages.length)&&previous.messages[sameMessages]===current.messages[sameMessages])sameMessages++;while(blocks<Math.min(previous.blocks.length,current.blocks.length)&&previous.blocks[blocks]===current.blocks[blocks])blocks++;}
  const difference=!previous?'first-request':previous.config!==current.config?'request-options':previous.tools!==current.tools?'tools':previous.system!==current.system?'system':sameMessages<Math.min(previous.messages.length,current.messages.length)?'message':current.inputHash!==previous.inputHash&&sameMessages===MAX_MESSAGES?'input-beyond-scan':previous.messageCount!==current.messageCount?'message-count':current.inputHash!==previous.inputHash?'message':'none';
  const names=Object.keys(current.toolSchemas),priorNames=Object.keys(previous?.toolSchemas||{});
  return {version:1,scopeFingerprint:hash(scope),optionsFingerprint:current.config,toolsFingerprint:current.tools,inputFingerprint:current.inputHash,inputBytes:wire.length,inputMessages:history.length,compared:Boolean(previous),firstDifference:difference,...(difference==='message'?{firstDifferentMessage:sameMessages,firstDifferentRole:history[sameMessages]?.role||history[sameMessages]?.type}:{}),toolCount:names.length,...(previous?{toolsAdded:names.filter(name=>!Object.hasOwn(previous.toolSchemas,name)),toolsRemoved:priorNames.filter(name=>!Object.hasOwn(current.toolSchemas,name)),toolsChanged:names.filter(name=>Object.hasOwn(previous.toolSchemas,name)&&previous.toolSchemas[name]!==current.toolSchemas[name])}:{}),matchingPrefixMessages:sameMessages,matchingInputPrefixBytes:previous?Math.min(blocks*CHUNK,current.bytes,previous.bytes):0,prefixScanTruncated:wire.length>CHUNK*MAX_CHUNKS||history.length>MAX_MESSAGES,promptCacheKeySent:typeof body.prompt_cache_key==='string'};
 }
}

export function rejectsPromptCacheKey(body:string){
 try{const error=JSON.parse(body)?.error;if(error?.param==='prompt_cache_key'&&/unknown|unsupported|unrecognized|extra|not.allowed/i.test(String(error.code)+' '+String(error.message)))return true;}catch{}
 return /prompt_cache_key/i.test(body)&&/unknown|unsupported|not supported|unrecognized|extra (?:field|input|parameter)|not permitted|不支持|未知参数/i.test(body);
}
