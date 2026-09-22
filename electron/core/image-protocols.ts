/**
 * Image protocol adapters. Each entry fully describes one wire format: where it posts,
 * what it accepts, and how to read bytes back. Adding a protocol means adding one
 * descriptor to ADAPTERS — no heuristics elsewhere in the app change.
 */
import {aspectDimensions,type ImageAspect,type ImageProtocol,type ImageProtocolInfo,type ImageQuality} from '../../src/image-types';

export interface ImageReference {bytes:Buffer;mediaType:string;name?:string}
export interface ImageJob {prompt:string;aspect?:ImageAspect;quality?:ImageQuality;negativePrompt?:string;seed?:number;reference?:ImageReference[]}
export interface ImageEndpoint {baseUrl:string;model:string}
export type ImagePlan=
  |{kind:'http';url:string;method:string;headers:Record<string,string>;body:BodyInit}
  |{kind:'hosted';size?:string;quality?:ImageQuality};
export interface ImageAdapter extends ImageProtocolInfo {plan(job:ImageJob,endpoint:ImageEndpoint,key:string):ImagePlan;parse(body:unknown):Buffer|undefined}

function decode(raw:unknown){
  if(typeof raw!=='string'||!raw)return;
  const base64=raw.startsWith('data:')?raw.replace(/^data:[^;,]*;base64,/,''):raw;
  try{const bytes=Buffer.from(base64,'base64');return bytes.length?bytes:undefined;}catch{return;}
}
function bearer(key:string):Record<string,string>{return key?{Authorization:`Bearer ${key}`}:{};}

/** Gemini exposes generateContent under /v1beta regardless of the chat base path the user configured. */
export function geminiImageUrl(baseUrl:string,model:string){
  const id=encodeURIComponent(model.replace(/^models\//,''));
  const trimmed=baseUrl.replace(/\/$/,'');
  if(/\/v1beta(?:\/|$)/.test(trimmed)||trimmed.endsWith('/models'))return `${trimmed.replace(/\/models$/,'')}/models/${id}:generateContent`;
  try{return `${new URL(trimmed).origin}/v1beta/models/${id}:generateContent`;}catch{return `${trimmed}/models/${id}:generateContent`;}
}

/** OpenAI image models accept a fixed size menu that differs per family; anything else gets the standard bucket. */
export function openAiSize(model:string,aspect?:ImageAspect){
  if(!aspect)return undefined;
  const name=(model||'').toLowerCase(),landscape=['16:9','4:3','3:2'].includes(aspect),portrait=['9:16','3:4','2:3'].includes(aspect);
  if(name.includes('dall-e-3'))return landscape?'1792x1024':portrait?'1024x1792':'1024x1024';
  if(name.includes('dall-e-2'))return '1024x1024';
  if(name.includes('gpt-image'))return landscape?'1536x1024':portrait?'1024x1536':'1024x1024';
  const {width,height}=aspectDimensions(aspect);return `${width}x${height}`;
}
/** dall-e-3 predates the low/medium/high tiers and only knows standard|hd. */
function openAiQuality(model:string,quality?:ImageQuality){
  if(!quality||quality==='auto')return undefined;
  const name=(model||'').toLowerCase();
  if(name.includes('dall-e-3'))return quality==='high'?'hd':'standard';
  if(name.includes('dall-e-2'))return undefined;
  return quality;
}

const openAiImages:ImageAdapter={
  id:'openai-images',label:'OpenAI Images',hint:'POST /images/generations，多数聚合服务与本地兼容层都用这个格式。',endpoint:'/images/generations',
  capabilities:{aspect:true,size:true,quality:true,reference:true,negativePrompt:false,seed:false},
  plan(job,endpoint,key){
    const base=endpoint.baseUrl.replace(/\/$/,''),size=openAiSize(endpoint.model,job.aspect),quality=openAiQuality(endpoint.model,job.quality);
    // gpt-image-* always returns base64 and rejects response_format; the older families require it.
    const legacyFormat=!/gpt-image/i.test(endpoint.model);
    if(job.reference?.length){
      const form=new FormData();
      form.append('model',endpoint.model);form.append('prompt',job.prompt);form.append('n','1');
      if(size)form.append('size',size);
      if(quality)form.append('quality',String(quality));
      job.reference.forEach((item,index)=>form.append('image[]',new Blob([new Uint8Array(item.bytes)],{type:item.mediaType}),item.name||`reference-${index}.png`));
      return {kind:'http',url:`${base}/images/edits`,method:'POST',headers:{...bearer(key)},body:form};
    }
    return {kind:'http',url:`${base}/images/generations`,method:'POST',headers:{'content-type':'application/json',...bearer(key)},body:JSON.stringify({
      model:endpoint.model,prompt:job.prompt,n:1,
      ...(size?{size}:{}),...(quality?{quality}:{}),...(legacyFormat?{response_format:'b64_json'}:{}),
    })};
  },
  parse(body){
    const rows=Array.isArray(body)?body:Array.isArray((body as any)?.data)?(body as any).data:Array.isArray((body as any)?.images)?(body as any).images:[];
    for(const item of rows){
      const bytes=decode(typeof item==='string'?item:item?.b64_json??item?.result??item?.image??(typeof item?.url==='string'&&item.url.startsWith('data:')?item.url:undefined));
      if(bytes)return bytes;
    }
  },
};

const geminiImages:ImageAdapter={
  id:'gemini-images',label:'Gemini generateContent',hint:'POST /v1beta/models/{model}:generateContent，用于 Gemini 与 Imagen。',endpoint:':generateContent',
  capabilities:{aspect:true,size:false,quality:false,reference:true,negativePrompt:false,seed:false},
  plan(job,endpoint,key){
    const parts=[
      ...(job.reference||[]).map(item=>({inlineData:{mimeType:item.mediaType,data:item.bytes.toString('base64')}})),
      {text:job.negativePrompt?`${job.prompt}\n\nAvoid: ${job.negativePrompt}`:job.prompt},
    ];
    return {kind:'http',url:geminiImageUrl(endpoint.baseUrl,endpoint.model),method:'POST',
      headers:{'content-type':'application/json',...(key?{'x-goog-api-key':key,Authorization:`Bearer ${key}`}:{})} as Record<string,string>,
      body:JSON.stringify({contents:[{role:'user',parts}],generationConfig:{responseModalities:['TEXT','IMAGE'],...(job.aspect?{imageConfig:{aspectRatio:job.aspect}}:{})}})};
  },
  parse(body){
    for(const candidate of (body as any)?.candidates||[]){
      for(const part of candidate?.content?.parts||[]){
        const bytes=decode(part?.inlineData?.data||part?.inline_data?.data);
        if(bytes)return bytes;
      }
    }
  },
};

const responsesImages:ImageAdapter={
  id:'responses-images',label:'OpenAI Responses 托管生图',hint:'走 Responses 的 image_generation 工具，由对话请求直接返回图片。',endpoint:'/responses',
  capabilities:{aspect:true,size:true,quality:true,reference:false,negativePrompt:false,seed:false},
  plan(job,endpoint){return {kind:'hosted',size:openAiSize(endpoint.model,job.aspect),quality:job.quality&&job.quality!=='auto'?job.quality:undefined};},
  parse(body){
    if(!Array.isArray(body))return;
    for(const item of body){
      if(item?.type!=='image_generation_call')continue;
      const bytes=decode(typeof item.result==='string'?item.result:item.result?.b64_json);
      if(bytes)return bytes;
    }
  },
};

const sdWebui:ImageAdapter={
  id:'sd-webui',label:'Stable Diffusion WebUI',hint:'POST /sdapi/v1/txt2img，适用于本机 Automatic1111 / Forge。',endpoint:'/sdapi/v1/txt2img',
  capabilities:{aspect:true,size:true,quality:false,reference:true,negativePrompt:true,seed:true},
  plan(job,endpoint,key){
    const {width,height}=aspectDimensions(job.aspect);
    let origin=endpoint.baseUrl.replace(/\/$/,'');
    try{origin=new URL(origin).origin;}catch{/* keep the configured value */}
    const img2img=Boolean(job.reference?.length);
    return {kind:'http',url:`${origin}/sdapi/v1/${img2img?'img2img':'txt2img'}`,method:'POST',
      headers:{'content-type':'application/json',...bearer(key)},
      body:JSON.stringify({
        prompt:job.prompt,negative_prompt:job.negativePrompt||'',width,height,steps:28,batch_size:1,
        ...(endpoint.model?{override_settings:{sd_model_checkpoint:endpoint.model}}:{}),
        ...(job.seed!==undefined?{seed:job.seed}:{}),
        ...(img2img?{init_images:job.reference!.map(item=>item.bytes.toString('base64')),denoising_strength:0.65}:{}),
      })};
  },
  parse(body){
    for(const item of (body as any)?.images||[]){const bytes=decode(item);if(bytes)return bytes;}
  },
};

const ADAPTERS:ImageAdapter[]=[openAiImages,geminiImages,responsesImages,sdWebui];
const BY_ID=new Map(ADAPTERS.map(adapter=>[adapter.id,adapter]));

export function imageAdapter(protocol:ImageProtocol){const adapter=BY_ID.get(protocol);if(!adapter)throw Error('未知的生图协议');return adapter;}
export function imageAdapters(){return ADAPTERS;}
/** Descriptors for the settings UI, including the `auto` entry that has no wire format of its own. */
export function imageProtocolCatalog():ImageProtocolInfo[]{
  return [{id:'auto',label:'自动检测',hint:'首次生图时依次尝试并记住可用的协议。明确选择协议可以省去这次探测。',endpoint:'',
    capabilities:{aspect:true,size:true,quality:true,reference:true,negativePrompt:true,seed:true}},
    ...ADAPTERS.map(({id,label,hint,endpoint,capabilities})=>({id,label,hint,endpoint,capabilities}))];
}
/** Probe order for `auto`. A configured chat protocol is the best first guess; the model name only breaks ties. */
export function autoProtocolOrder(model:string,chatProtocol?:string,known?:ImageProtocol):ImageProtocol[]{
  const name=(model||'').trim().toLowerCase(),ordered:ImageProtocol[]=[];
  const looksGemini=(name.startsWith('gemini')||name.startsWith('imagen')||name.includes('nano-banana'))&&!name.includes('embedding');
  const guesses:Array<ImageProtocol|undefined>=[
    known,
    looksGemini?'gemini-images':undefined,
    chatProtocol==='gemini'?'gemini-images':undefined,
    chatProtocol==='responses'?'responses-images':undefined,
    'openai-images','gemini-images','responses-images',
  ];
  for(const guess of guesses){
    if(!guess||ordered.includes(guess))continue;
    // Hosted Responses generation only exists on a Responses provider.
    if(guess==='responses-images'&&chatProtocol!=='responses')continue;
    ordered.push(guess);
  }
  return ordered;
}
