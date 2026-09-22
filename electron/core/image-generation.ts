import type {ModelConfig,WireMessage} from '../../src/shared';
import type {ModelClient} from './model';
import {validateModelEndpoint} from './model';
import {modelFetch} from './model-http';
import {asImageProtocol,probesNextProtocol,retryableImageFailure,type ImageProtocol} from '../../src/image-types';
import {autoProtocolOrder,geminiImageUrl,imageAdapter,openAiSize,type ImageJob,type ImagePlan} from './image-protocols';
import {ImageGenerationError,classifyImageResponse,classifyImageTransport} from './image-errors';

export {geminiImageUrl,openAiSize};
export type {ImageJob};

const MAX_IMAGE_BYTES=24*1024*1024;

/** Routes are remembered per provider+endpoint+model so `auto` probes once, not on every call. */
export type ImageRouteStore={get(key:string):ImageProtocol|undefined;set(key:string,protocol:ImageProtocol):void};
const remembered=new Map<string,ImageProtocol>();

/** Accepts the pre-0.28 route values so an existing install keeps its learned protocol. */
const LEGACY_ROUTES:Record<string,ImageProtocol>={openai:'openai-images',gemini:'gemini-images',responses:'responses-images'};
export function migrateImageRoute(value:unknown):ImageProtocol|undefined{
  if(typeof value==='string'&&LEGACY_ROUTES[value])return LEGACY_ROUTES[value];
  return asImageProtocol(value);
}
export function imageRouteKey(config:Pick<ModelConfig,'providerId'|'baseUrl'|'model'>){
  return `${config.providerId||''}|${(config.baseUrl||'').replace(/\/$/,'')}|${config.model}`;
}
export function storeImageRoutes(store:{data:{imageGenerationRoutes?:Record<string,string>};save():void}):ImageRouteStore{
  return {
    get:key=>migrateImageRoute(store.data.imageGenerationRoutes?.[key]),
    set:(key,protocol)=>{store.data.imageGenerationRoutes={...store.data.imageGenerationRoutes,[key]:protocol};store.save();},
  };
}

/** Sniffs the container so the asset is saved with a truthful extension instead of a guessed one. */
export function imageMediaType(bytes:Buffer){
  if(bytes.length>8&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47)return 'image/png';
  if(bytes.length>3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(bytes.length>12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  if(bytes.length>5&&bytes.toString('ascii',0,5)==='<?xml')return 'image/svg+xml';
  if(bytes.length>6&&bytes.toString('ascii',0,6)==='GIF89a')return 'image/gif';
  return 'image/png';
}
export function imageExtension(mediaType:string){
  return mediaType==='image/jpeg'?'jpg':mediaType==='image/webp'?'webp':mediaType==='image/gif'?'gif':mediaType==='image/svg+xml'?'svg':'png';
}

/** Kept for the Responses hosted path and for reading a stray provider payload shape. */
export function imageBytesFromGeneration(body:unknown){
  for(const protocol of ['responses-images','openai-images','gemini-images','sd-webui'] as ImageProtocol[]){
    const bytes=imageAdapter(protocol).parse(body);
    if(bytes)return bytes;
  }
}

async function bytesFromUrl(url:string,signal:AbortSignal){
  if(!/^https?:\/\//i.test(url))return;
  const response=await modelFetch(url,{method:'GET',redirect:'error',signal});
  if(!response.ok){await response.body?.cancel();throw new ImageGenerationError('retry-later',{status:response.status,detail:'下载生成图片失败'});}
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>MAX_IMAGE_BYTES)throw new ImageGenerationError('revise-request',{detail:'生成图片超过 24 MB'});
  return bytes.length?bytes:undefined;
}

async function runHttpPlan(plan:Extract<ImagePlan,{kind:'http'}>,protocol:ImageProtocol,hasKey:boolean,signal:AbortSignal){
  let response:Response;
  try{response=await modelFetch(plan.url,{method:plan.method,headers:plan.headers,body:plan.body,redirect:'error',signal});}
  catch(error){
    if(signal.aborted)throw error;
    throw new ImageGenerationError(classifyImageTransport(error),{protocol,detail:(error as Error).message});
  }
  const type=response.headers.get('content-type')||'';
  if(!response.ok){
    const text=await response.text().catch(()=>'');
    const {nextStep,subject}=classifyImageResponse(response.status,text,hasKey);
    throw new ImageGenerationError(nextStep,{subject,protocol,status:response.status,detail:text});
  }
  // Some compatible endpoints answer with the raw image instead of JSON.
  if(type.startsWith('image/')){
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>MAX_IMAGE_BYTES)throw new ImageGenerationError('revise-request',{protocol,detail:'生成图片超过 24 MB'});
    if(bytes.length)return bytes;
    throw new ImageGenerationError('switch-model',{protocol,detail:'返回了空的图片响应'});
  }
  const text=await response.text();
  let parsed:unknown;
  try{parsed=JSON.parse(text);}
  catch{throw new ImageGenerationError('switch-model',{protocol,detail:'生图接口返回了无法解析的内容：'+text.slice(0,200)});}
  const bytes=imageAdapter(protocol).parse(parsed);
  if(bytes){
    if(bytes.length>MAX_IMAGE_BYTES)throw new ImageGenerationError('revise-request',{protocol,detail:'生成图片超过 24 MB'});
    return bytes;
  }
  const remote=(parsed as any)?.data?.[0]?.url||(parsed as any)?.images?.[0]?.url||(parsed as any)?.output?.[0];
  const downloaded=typeof remote==='string'?await bytesFromUrl(remote,signal):undefined;
  if(downloaded)return downloaded;
  throw new ImageGenerationError('switch-model',{protocol,status:response.status,detail:'响应里没有图片数据：'+text.slice(0,200)});
}

async function runPlan(protocol:ImageProtocol,job:ImageJob,input:GenerateImageInput,signal:AbortSignal){
  const adapter=imageAdapter(protocol);
  if(!adapter.capabilities.reference&&job.reference?.length)
    throw new ImageGenerationError('unsupported',{protocol,detail:'当前生图协议不支持参考图'});
  const plan=adapter.plan(job,{baseUrl:validateModelEndpoint(input.config.baseUrl),model:input.config.model},input.key);
  if(plan.kind==='hosted'){
    const result=await input.model.complete(
      [{role:'user',content:'Generate one image. Do not claim success without image bytes.\nPrompt: '+job.prompt} as WireMessage],
      [],signal,()=>{},
      {botId:input.botId,runId:input.runId,purpose:'image',maxOutputTokens:1024,retries:0,
        config:{...input.config,hostedWebSearch:undefined,hostedImageGeneration:true,reasoningEffort:undefined,
          hostedImageSize:plan.size,hostedImageQuality:plan.quality},
        key:input.key,hostedImageGeneration:true});
    const bytes=adapter.parse(result.native?.data);
    if(!bytes)throw new ImageGenerationError('switch-model',{protocol,detail:'Responses 没有返回图片数据'});
    return bytes;
  }
  return runHttpPlan(plan,protocol,Boolean(input.key),signal);
}

export interface GenerateImageInput {
  model:ModelClient;
  config:ModelConfig;
  key:string;
  signal:AbortSignal;
  botId?:string;
  runId?:string;
  routes?:ImageRouteStore;
}
export interface GenerateImageResult {bytes:Buffer;protocol:ImageProtocol;mediaType:string}

/**
 * Resolves the protocol, generates once, and remembers what worked.
 * `auto` probes the adapter list; a configured protocol never probes.
 * Only a protocol mismatch advances the probe — auth, billing and policy failures stop immediately
 * so a failed attempt is never repeated against another endpoint that would bill again.
 */
export async function generateModelImage(input:GenerateImageInput&{job:ImageJob}):Promise<GenerateImageResult>{
  const job={...input.job,prompt:input.job.prompt.trim()};
  if(!job.prompt)throw new ImageGenerationError('revise-request',{subject:'prompt',detail:'请填写生图提示'});
  const configured=asImageProtocol(input.config.imageProtocol)||'auto';
  const key=imageRouteKey(input.config);
  const known=input.routes?.get(key)||remembered.get(key);
  const order=configured==='auto'?autoProtocolOrder(input.config.model,input.config.protocol,known):[configured];
  let last:ImageGenerationError|undefined;
  for(const protocol of order){
    input.signal.throwIfAborted();
    for(let attempt=0;;attempt++){
      try{
        const bytes=await runPlan(protocol,job,input,input.signal);
        remembered.set(key,protocol);input.routes?.set(key,protocol);
        return {bytes,protocol,mediaType:imageMediaType(bytes)};
      }catch(error){
        if(input.signal.aborted)throw error;
        const failure=error instanceof ImageGenerationError?error.withProtocol(protocol):new ImageGenerationError('contact-support',{protocol,detail:(error as Error).message});
        if(retryableImageFailure(failure.nextStep)&&attempt===0)continue;
        last=failure;
        if(!probesNextProtocol(failure.nextStep))throw failure;
        break;
      }
    }
  }
  throw last||new ImageGenerationError('switch-model',{detail:'没有可用的生图协议'});
}

/** Settings-time connection check: generates one small image so the resolved protocol is proven, not guessed. */
export async function probeImageModel(input:GenerateImageInput){
  const result=await generateModelImage({...input,job:{prompt:'A single small flat-color circle centered on a plain light background. Minimal connection test image.',aspect:'1:1'}});
  return {protocol:result.protocol,mediaType:result.mediaType,bytes:result.bytes.length};
}
