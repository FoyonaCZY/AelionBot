import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import type {ModelProvider,ModelSelection,ProviderInput} from '../../src/shared';
import {Store,atomicJson,type StoredProvider} from './store';
import {validateModelEndpoint} from './model';
import {redactHost} from './host';
import type {ModelParameters} from '../../src/model-types';

export function modelParameters(input:ModelParameters):ModelParameters{
 const {protocol,temperature,reasoningEffort,thinkingBudget,fallbackModel}=input;
 if(protocol!==undefined&&!['chat','responses','anthropic','gemini'].includes(protocol))throw Error('模型协议无效');
 if(temperature!==undefined&&(!Number.isFinite(temperature)||temperature<0||temperature>2))throw Error('温度应为 0–2');
 if(reasoningEffort!==undefined&&!['none','minimal','low','medium','high','xhigh'].includes(reasoningEffort))throw Error('推理强度无效');
 if(thinkingBudget!==undefined&&(!Number.isInteger(thinkingBudget)||thinkingBudget<1024||thinkingBudget>64000))throw Error('思考预算应为 1024–64000');
 if(fallbackModel!==undefined&&(typeof fallbackModel!=='string'||fallbackModel.length>256||/[\u0000-\u001f]/.test(fallbackModel)))throw Error('备用模型无效');
 return {protocol,temperature,reasoningEffort,thinkingBudget,fallbackModel:fallbackModel?.trim()||undefined};
}

export interface CredentialCodec {encrypt:(value:string)=>string;decrypt:(value:string)=>string;}
function text(value:unknown,label:string,max:number){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))throw new Error(`${label}无效`);return value.trim();}
async function jsonBody(response:Response){
  if(!response.body)throw new Error('Provider 返回空响应');const reader=response.body.getReader();let length=0;const chunks:Uint8Array[]=[];
  try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>2*1024*1024)throw new Error('模型列表超过 2 MB');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});}
}
export class ModelProviders {
  private requests=new Map<string,{revision:string;controller:AbortController;promise:Promise<ModelProvider>}>();
  private decrypted=new Map<string,string>();
  constructor(readonly store:Store,private codec:CredentialCodec,private changed:()=>void=()=>{}){
    if(store.data.providers!==undefined)return;
    const legacy=store.data.model,providers:StoredProvider[]=[];let defaultModel:ModelSelection|undefined;
    if(legacy.model||legacy.encryptedKey||legacy.baseUrl!=='https://api.openai.com/v1'){
      const backup=join(store.dir,'providers-migration-backup.json');if(!existsSync(backup))atomicJson(backup,store.data);
      const provider:StoredProvider={id:randomUUID(),name:'默认 Provider',baseUrl:legacy.baseUrl,models:legacy.model?[{id:legacy.model}]:[],...(legacy.encryptedKey?{encryptedKey:legacy.encryptedKey}:{})};providers.push(provider);
      if(legacy.model)defaultModel={providerId:provider.id,model:legacy.model,contextTokens:legacy.contextTokens};
    }
    this.commit({providers,defaultModel});
  }
  private commit(patch:Partial<Store['data']>){
    const next={...this.store.data,...patch},selection=next.defaultModel,provider=next.providers?.find(item=>item.id===selection?.providerId);
    // Retain an encrypted default-config mirror for older clients and rollback.
    next.model=provider&&selection?{baseUrl:provider.baseUrl,model:selection.model,contextTokens:selection.contextTokens,...(provider.encryptedKey?{encryptedKey:provider.encryptedKey}:{})}:{baseUrl:'https://api.openai.com/v1',model:'',contextTokens:32000};
    this.store.replaceData(next);this.changed();
  }
  private provider(id:string){const provider=this.store.data.providers?.find(provider=>provider.id===id);if(!provider)throw new Error('Provider 不存在');return provider;}
  private keyFor(provider:StoredProvider){const cipher=provider.encryptedKey;if(!cipher)return '';if(this.decrypted.has(cipher))return this.decrypted.get(cipher)!;try{const key=this.codec.decrypt(cipher);this.decrypted.set(cipher,key);return key;}catch{return '';}}
  private public(provider:StoredProvider):ModelProvider{const {encryptedKey,...rest}=provider;return {...structuredClone(rest),hasKey:Boolean(this.keyFor(provider))};}
  list(){return (this.store.data.providers||[]).map(provider=>this.public(provider));}
  key(botId?:string){const id=this.store.modelFor(botId).providerId;return id?this.keyFor(this.provider(id)):'';}
  config(botId?:string){const config=this.store.modelFor(botId);return {...config,hasKey:!config.issue&&Boolean(this.key(botId))};}
  secrets(){return (this.store.data.providers||[]).map(provider=>this.keyFor(provider)).filter(Boolean);}
  using(id:string){return this.store.data.bots.filter(bot=>this.store.modelSelection(bot.id)?.providerId===id).map(bot=>bot.id);}
  selection(value:unknown):ModelSelection|undefined{
    if(value===null)return undefined;
    if(!value||typeof value!=='object')throw new Error('请选择 Provider 和模型');
    const input=value as ModelSelection,providerId=text(input.providerId,'Provider',80),model=text(input.model,'模型名称',256),contextTokens=input.contextTokens;
    this.provider(providerId);if(!Number.isInteger(contextTokens)||contextTokens<8000||contextTokens>1000000)throw new Error('上下文容量应为 8000–1000000');
    return {providerId,model,contextTokens};
  }
  setDefault(value:unknown){this.commit({defaultModel:this.selection(value)});}
  setBot(botId:string,value:unknown){this.store.bot(botId);const selection=this.selection(value);this.commit({bots:this.store.data.bots.map(bot=>bot.id===botId?{...bot,model:selection}:bot)});}
  save(input:ProviderInput){
    const name=text(input?.name,'Provider 名称',80),baseUrl=validateModelEndpoint(text(input.baseUrl,'Base URL',2000));
    const previous=input.id?this.provider(text(input.id,'Provider',80)):undefined;
    if(this.store.data.providers?.some(provider=>provider.id!==previous?.id&&provider.name===name))throw new Error('已有同名 Provider，请使用不同名称');
    if(input.apiKey!==undefined&&input.apiKey!==null&&typeof input.apiKey!=='string')throw new Error('API Key 无效');
    if(input.apiKey&&input.apiKey.length>4000)throw new Error('API Key 过长');
    const changedOrigin=previous&&new URL(previous.baseUrl).origin!==new URL(baseUrl).origin;
    const supplied=typeof input.apiKey==='string'?input.apiKey.trim():'';
    if(/[\u0000-\u001f\u007f]/.test(supplied))throw new Error('API Key 不能包含换行或控制字符');
    if(changedOrigin&&previous.encryptedKey&&!supplied&&input.apiKey!==null)throw new Error('更换服务地址后请重新填写 API Key');
    const encryptedKey=supplied?this.codec.encrypt(supplied):input.apiKey===null?undefined:previous?.encryptedKey;
    const parameters=modelParameters({...previous,...input});
    const connectionChanged=!previous||previous.baseUrl!==baseUrl||previous.encryptedKey!==encryptedKey||previous.protocol!==parameters.protocol;
    const provider:StoredProvider={id:previous?.id||randomUUID(),name,baseUrl,models:connectionChanged?[]:previous.models,...(!connectionChanged?{modelsUpdatedAt:previous.modelsUpdatedAt,modelsCheckedAt:previous.modelsCheckedAt,modelsError:previous.modelsError}:{}),...(encryptedKey?{encryptedKey}:{})};
    Object.assign(provider,parameters);
    this.requests.get(provider.id)?.controller.abort();this.requests.delete(provider.id);if(previous?.encryptedKey&&previous.encryptedKey!==encryptedKey)this.decrypted.delete(previous.encryptedKey);
    this.commit({providers:previous?this.store.data.providers!.map(item=>item.id===provider.id?provider:item):[...this.store.data.providers!,provider]});return this.public(provider);
  }
  remove(id:string){
    const previous=this.provider(id);if(this.store.data.defaultModel?.providerId===id||this.using(id).length)throw new Error('此 Provider 仍被默认模型或 Bot 使用，请先切换模型');
    this.requests.get(id)?.controller.abort();this.requests.delete(id);this.commit({providers:this.store.data.providers!.filter(provider=>provider.id!==id)});if(previous.encryptedKey)this.decrypted.delete(previous.encryptedKey);
  }
  refresh(id:string):Promise<ModelProvider>{
    const provider=this.provider(id),revision=JSON.stringify([provider.baseUrl,provider.encryptedKey,provider.protocol]);
    const existing=this.requests.get(id);if(existing?.revision===revision)return existing.promise;
    existing?.controller.abort();const controller=new AbortController();
    const pending=(async()=>{
      let models:ModelProvider['models']|undefined,error:string|undefined;
      try{
        const key=this.keyFor(provider),headers:Record<string,string>={Accept:'application/json'};
        if(provider.protocol==='anthropic'){headers['anthropic-version']='2023-06-01';if(key)headers['x-api-key']=key;}else if(provider.protocol==='gemini'){if(key)headers['x-goog-api-key']=key;}else if(key)headers.Authorization=`Bearer ${key}`;
        const response=await fetch(`${validateModelEndpoint(provider.baseUrl)}/models`,{headers,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
        if(!response.ok){await response.body?.cancel();throw new Error(`获取模型列表失败 HTTP ${response.status}`);}
        let body=await jsonBody(response);const all:any[]=[],cursors=new Set<string>();
        for(let page=0;;page++){
          if(provider.protocol==='gemini'&&Array.isArray(body.models))body.data=body.models.filter((m:any)=>!m.supportedGenerationMethods||m.supportedGenerationMethods.includes('generateContent')).map((m:any)=>({id:m.name?.replace(/^models\//,'')}));if(!Array.isArray(body?.data))throw new Error('模型列表格式不兼容，需要 data 数组');
          all.push(...body.data);if(all.length>5000)throw Error('模型列表超过 5000 项');
          const cursor=provider.protocol==='gemini'?body.nextPageToken:provider.protocol==='anthropic'&&body.has_more?body.last_id:undefined;if(!cursor)break;
          if(typeof cursor!=='string'||cursor.length>4000||page>=19||cursors.has(cursor))throw Error('Provider 模型列表分页异常');cursors.add(cursor);
          const url=new URL(`${validateModelEndpoint(provider.baseUrl)}/models`);url.searchParams.set(provider.protocol==='gemini'?'pageToken':'after_id',cursor);const next=await fetch(url,{headers,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});if(!next.ok){await next.body?.cancel();throw Error(`获取模型列表失败 HTTP ${next.status}`);}body=await jsonBody(next);
        }body={data:all};
        if(body.data.length>5000)throw new Error('模型列表超过 5000 项');
        const secrets=this.secrets(),ids=new Set<string>();for(const item of body.data){if(typeof item?.id!=='string')throw new Error('模型列表缺少模型 ID');const id=text(item.id,'模型 ID',256);if(secrets.some(secret=>id.includes(secret)))throw new Error('模型列表包含凭据信息');ids.add(id);}
        models=[...ids].sort((a,b)=>a.localeCompare(b)).map(id=>({id}));
      }catch(caught){error=redactHost((caught as Error).message,this.secrets()).slice(0,400);}
      const current=this.store.data.providers?.find(provider=>provider.id===id);
      if(!current)throw new Error('Provider 已删除');
      if(controller.signal.aborted||JSON.stringify([current.baseUrl,current.encryptedKey,current.protocol])!==revision)return this.public(current);
      const stamp=new Date().toISOString(),next={...current,models:models||current.models,modelsCheckedAt:stamp,modelsUpdatedAt:models?stamp:current.modelsUpdatedAt,modelsError:error};
      this.commit({providers:this.store.data.providers!.map(provider=>provider.id===id?next:provider)});return this.public(next);
    })();this.requests.set(id,{revision,controller,promise:pending});void pending.finally(()=>{if(this.requests.get(id)?.promise===pending)this.requests.delete(id);}).catch(()=>{});return pending;
  }
  dispose(){for(const request of this.requests.values())request.controller.abort();this.requests.clear();this.decrypted.clear();}
}
