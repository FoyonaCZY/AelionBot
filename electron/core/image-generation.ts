import type {ModelConfig,WireMessage} from '../../src/shared';
import type {ModelClient} from './model';
import {validateModelEndpoint} from './model';
import {modelFetch} from './model-http';
import {hostedGeneratedImages} from './hosted-tools';

export function imageBytesFromGeneration(body:unknown){
  const hosted=hostedGeneratedImages(body);
  if(hosted[0])return hosted[0];
  const rows=Array.isArray(body)?body:Array.isArray((body as any)?.data)?(body as any).data:Array.isArray((body as any)?.images)?(body as any).images:[];
  for(const item of rows){
    const raw=typeof item?.b64_json==='string'?item.b64_json:typeof item?.result==='string'?item.result:typeof item?.url==='string'&&item.url.startsWith('data:image/')?item.url.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/,''):undefined;
    if(!raw)continue;
    try{const bytes=Buffer.from(raw,'base64');if(bytes.length)return bytes;}catch{}
  }
}

export async function generateModelImage(input:{
  model:ModelClient;
  config:ModelConfig;
  key:string;
  prompt:string;
  signal:AbortSignal;
  botId?:string;
  runId?:string;
}){
  const prompt=input.prompt.trim();if(!prompt)throw Error('请填写生图提示');
  if((input.config.protocol||'chat')==='responses'){
    const result=await input.model.complete([{role:'user',content:'Generate one image. Do not claim success without image bytes.\nPrompt: '+prompt} as WireMessage],[],input.signal,()=>{},{botId:input.botId,runId:input.runId,purpose:'image',maxOutputTokens:1024,retries:0,config:{...input.config,hostedWebSearch:undefined,hostedImageGeneration:true},key:input.key,hostedImageGeneration:true});
    const bytes=imageBytesFromGeneration(result.native?.data);if(!bytes)throw Error('生图未返回图像。请确认所选生图模型支持图片生成。');
    return bytes;
  }
  const url=validateModelEndpoint(input.config.baseUrl)+'/images/generations';
  const headers:Record<string,string>={'content-type':'application/json'};if(input.key)headers.Authorization=`Bearer ${input.key}`;
  const response=await modelFetch(url,{method:'POST',redirect:'error',headers,body:JSON.stringify({model:input.config.model,prompt,n:1,response_format:'b64_json'}),signal:input.signal});
  const text=await response.text();
  if(!response.ok)throw Error(`生图请求失败 HTTP ${response.status}: ${text.slice(0,800)}`);
  let parsed:unknown;try{parsed=JSON.parse(text);}catch{throw Error('生图接口返回了无法解析的内容');}
  const bytes=imageBytesFromGeneration(parsed);if(!bytes)throw Error('生图未返回图像。请改用支持 /images/generations 或 Responses 图片生成的模型。');
  return bytes;
}
