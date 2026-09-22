import {Select} from './Select';
import {useEffect,useRef,useState} from 'react';
import type {ModelProvider,ModelSelection,ProviderModel,Snapshot} from './shared';
import type {ModelParameters,ModelProtocol} from './model-types';
import {IMAGE_ASPECTS,IMAGE_QUALITIES,type ImageProtocol,type ImageProtocolInfo} from './image-types';
import {SettingsSection} from './SettingsWindow';
import {ModelSelectionFields,validModelSelection} from './ModelSelectionFields';
import {ContextCapacityInput} from './ContextCapacityInput';
import {EditableSelect} from './EditableSelect';
import {REASONING_PRESETS} from './reasoning';
import {useI18n} from './i18n';
import './model-settings.css';

const errorText=(error:unknown)=>(error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,'');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function protocolName(protocol:string|undefined,t:(value:string)=>string){
  return protocol==='responses'?'Responses':protocol==='anthropic'?'Claude':protocol==='gemini'?'Gemini':t('OpenAI 兼容');
}
/** The protocol catalog is owned by the main process so adding an adapter needs no renderer change. */
export function useImageProtocols(){
  const [catalog,setCatalog]=useState<ImageProtocolInfo[]>([]);
  useEffect(()=>{let live=true;void window.aelion.imageProtocols().then(value=>{if(live)setCatalog(value);}).catch(()=>{});return()=>{live=false;};},[]);
  return catalog;
}
function capabilityLabels(info:ImageProtocolInfo|undefined,t:(value:string)=>string){
  if(!info)return [];
  const {capabilities}=info;
  return [capabilities.aspect&&t('画幅'),capabilities.quality&&t('质量'),capabilities.reference&&t('参考图'),capabilities.negativePrompt&&t('负向提示'),capabilities.seed&&t('随机种子')].filter(Boolean) as string[];
}
export function ModelSettings({state,onNotify}:{state:Snapshot;onNotify:(text:string)=>void}){
  const {t}=useI18n();
  const providers=state.providers||[];
  const [editing,setEditing]=useState<string>(),[refreshing,setRefreshing]=useState<string[]>([]),[removing,setRemoving]=useState('');
  const attempted=useRef(new Set<string>());
  const refresh=async(id:string)=>{setRefreshing(value=>[...new Set([...value,id])]);try{await window.aelion.refreshProviderModels(id);}catch(error){onNotify(errorText(error));}finally{setRefreshing(value=>value.filter(item=>item!==id));}};
  useEffect(()=>{for(const provider of providers)if(!provider.modelsCheckedAt&&!attempted.current.has(provider.id)){attempted.current.add(provider.id);void refresh(provider.id);}},[providers.map(provider=>`${provider.id}:${provider.modelsCheckedAt||''}`).join('|')]);
  const selection=state.defaultModel||null;
  const affected=state.bots.filter(bot=>!bot.model).map(bot=>bot.id),busy=state.runs.some(run=>run.status==='running'&&affected.includes(run.botId));
  const editor=providers.find(provider=>provider.id===editing),editingUsed=state.bots.filter(bot=>(bot.model||state.defaultModel)?.providerId===editing).map(bot=>bot.id),editingBusy=state.runs.some(run=>run.status==='running'&&editingUsed.includes(run.botId));
  return <>
    <SettingsSection title={t('默认模型')}>
      <p className="provider-model-hint">{t('未单独指定对话模型的 Bot 使用这里。生图模型在 Bot 资料里配置。')}</p>
      <DefaultModelAssignment providers={providers} selection={selection} busy={busy} onNotify={onNotify}/>
    </SettingsSection>
    <SettingsSection title={t('自动审核模型')}>
      <p className="provider-model-hint">{t('本机权限审批用的模型，可与默认对话模型不同。')}</p>
      <DefaultModelAssignment approval defaultModel={state.defaultModel} providers={providers} selection={state.approvalModel||null} busy={false} onNotify={onNotify}/>
    </SettingsSection>
    <SettingsSection title="Providers">
      <div className="provider-heading"><button className="secondary-button" onClick={()=>setEditing('new')}>{t('添加 Provider')}</button></div>
      <div className="settings-card provider-list">{providers.map(provider=>{
        const used=state.defaultModel?.providerId===provider.id||state.approvalModel?.providerId===provider.id||state.bots.some(bot=>bot.model?.providerId===provider.id);
        return <div className="provider-row" key={provider.id}><button className="provider-info" aria-label={t('编辑 Provider {name}',{name:provider.name})} onClick={()=>setEditing(provider.id)}><strong>{provider.name}<span className="provider-protocol">{protocolName(provider.protocol,t)}</span>{provider.models.some(model=>model.imageOutput)&&<span className="provider-protocol provider-image-tag">{t('生图')}</span>}</strong><span>{provider.baseUrl}</span></button><span className="provider-model-count">{refreshing.includes(provider.id)?t('拉取中…'):t('{count} 个模型',{count:provider.models.length})}</span><button className="text-button" disabled={refreshing.includes(provider.id)} onClick={()=>void refresh(provider.id)} aria-label={t('刷新 {name} 模型列表',{name:provider.name})}>{t('刷新')}</button><button className="text-button" disabled={used||removing===provider.id} title={used?t('请先切换使用此 Provider 的默认模型、审核模型或 Bot 模型'):''} aria-label={t('删除 Provider {name}',{name:provider.name})} onClick={async()=>{setRemoving(provider.id);try{await window.aelion.removeProvider(provider.id);if(editing===provider.id)setEditing(undefined);}catch(error){onNotify(errorText(error));}finally{setRemoving('');}}}>{t('删除')}</button></div>;
      })}{!providers.length&&<div className="provider-empty">{t('还没有 Provider')}</div>}</div>
      {providers.filter(provider=>provider.modelsError).map(provider=><p className="provider-error" role="status" key={provider.id}>{provider.name}：{provider.modelsError}</p>)}
      {editing&&(editing==='new'||editor)&&<ProviderEditor key={editing} provider={editor} disabled={editingBusy} onClose={()=>setEditing(undefined)} onSaved={(provider,close)=>{if(close!==false)setEditing(undefined);onNotify(provider.modelsError?t('Provider 已保存，模型列表拉取失败'):close===false?t('模型目录已更新'):t('Provider 已保存'));}}/>}
    </SettingsSection>
  </>;
}

function DefaultModelAssignment({providers,selection,busy,onNotify,approval=false,defaultModel}:{approval?:boolean;defaultModel?:ModelSelection;providers:ModelProvider[];selection:ModelSelection|null;busy:boolean;onNotify:(text:string)=>void}){
  const [value,setValue]=useState<ModelSelection|null>(selection),seq=useRef(0);
  const persist=async(next:ModelSelection|null)=>{
    setValue(next);
    if(!validModelSelection(next,providers)||same(next,selection))return;
    const n=++seq.current;
    try{if(approval)await window.aelion.setApprovalModel(next);else await window.aelion.setDefaultModel(next);}
    catch(error){if(n===seq.current)onNotify(errorText(error));}
  };
  return <div className="model-assignment">
    <ModelSelectionFields providers={providers} value={value} onChange={persist} disabled={busy} inheritDefault={approval} defaultModel={defaultModel} showInheritedReasoning={!approval}/>
  </div>;
}

function ProviderEditor({provider,disabled,onClose,onSaved}:{provider?:ModelProvider;disabled:boolean;onClose:()=>void;onSaved:(provider:ModelProvider,close?:boolean)=>void}){
  const {t}=useI18n();
  const form=useRef<HTMLFormElement>(null);
  useEffect(()=>{form.current?.scrollIntoView({block:'start'});form.current?.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true});},[]);
  const [parameters,setParameters]=useState<ModelParameters>({protocol:provider?(provider.protocol||'chat'):'responses',responsesTransport:provider?.responsesTransport,temperature:provider?.temperature,thinkingBudget:provider?.thinkingBudget,fallbackModel:provider?.fallbackModel,hostedWebSearch:provider?.hostedWebSearch,hostedImageGeneration:provider?.hostedImageGeneration,imageProtocol:provider?.imageProtocol,imageAspect:provider?.imageAspect,imageQuality:provider?.imageQuality});
  const [name,setName]=useState(provider?.name||''),[baseUrl,setBaseUrl]=useState(provider?.baseUrl||''),[apiKey,setApiKey]=useState(''),[clearKey,setClearKey]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState('');
  const save=async()=>{setPending(true);setError('');try{const saved=await window.aelion.saveProvider({id:provider?.id,name,baseUrl,...parameters,apiKey:clearKey?null:apiKey||undefined});setName(saved.name);setBaseUrl(saved.baseUrl);setApiKey('');setClearKey(false);onSaved(saved);}catch(error){setError(errorText(error));}finally{setPending(false);}};
  const responses=parameters.protocol==='responses';
  const protocols=useImageProtocols();
  // Hosted generation only exists on a Responses provider; drop it from the menu and from state when the chat protocol moves away.
  const imageOptions=protocols.filter(info=>info.id!=='responses-images'||responses);
  const imageProtocol=(parameters.imageProtocol&&imageOptions.some(info=>info.id===parameters.imageProtocol)?parameters.imageProtocol:'auto') as ImageProtocol;
  const imageInfo=imageOptions.find(info=>info.id===imageProtocol);
  const capabilities=capabilityLabels(imageInfo,t);
  return <form ref={form} className="provider-editor" onSubmit={event=>{event.preventDefault();void save();}}>
    <h4>{provider?t('编辑 Provider'):t('添加 Provider')}</h4>
    <p className="provider-model-hint">{t('连接只负责协议和密钥。对话默认和模型列表分开设置。')}</p>
    <div className="settings-card">
      <label className="settings-row"><span>{t('协议')}</span><Select aria-label={t('Provider 协议')} value={parameters.protocol} disabled={disabled||pending} onChange={e=>setParameters({...parameters,protocol:e.target.value as ModelProtocol})}><option value="chat">OpenAI {t('兼容')}</option><option value="responses">OpenAI Responses</option><option value="anthropic">Claude Messages</option><option value="gemini">Gemini Generate Content</option></Select></label>
      <label className="settings-row"><span>{t('名称')}</span><input aria-label={t('Provider 名称')} value={name} onChange={event=>setName(event.target.value)} maxLength={80} disabled={disabled||pending} placeholder={t('例如：OpenAI')}/></label>
      <label className="settings-row"><span>Base URL</span><input aria-label={t('Provider Base URL')} value={baseUrl} onChange={event=>setBaseUrl(event.target.value)} maxLength={2000} spellCheck={false} disabled={disabled||pending} placeholder="https://api.example.com/v1"/></label>
      <label className="settings-row"><span>API Key</span><input aria-label={t('Provider API Key')} type="password" autoComplete="off" value={apiKey} onChange={event=>{setApiKey(event.target.value);setClearKey(false);}} disabled={disabled||pending} maxLength={4000} placeholder={provider?.hasKey&&!clearKey?t('已保存，留空保持不变'):t('本地服务可留空')}/></label>
      {responses&&<label className="settings-row"><span>{t('连接方式')}</span><Select aria-label={t('Responses 连接方式')} value={parameters.responsesTransport||'auto'} disabled={disabled||pending} onChange={e=>setParameters({...parameters,responsesTransport:e.target.value as ModelParameters['responsesTransport']})}><option value="auto">{t('自动')}</option><option value="http">HTTP</option><option value="websocket">WebSocket（{t('服务端支持时')}）</option></Select></label>}
    </div>
    {responses&&<div className="settings-card provider-tools-card">
      <p className="provider-card-kicker">{t('Responses 工具')}</p>
      <label className="settings-row provider-hosted-row"><span>{t('服务端搜索')}</span><input type="checkbox" checked={Boolean(parameters.hostedWebSearch)} disabled={disabled||pending} onChange={event=>setParameters({...parameters,hostedWebSearch:event.target.checked})} aria-label={t('使用服务端内置搜索，不再提供应用内 web_search')}/></label>
      <label className="settings-row provider-hosted-row"><span>{t('服务端生图')}</span><input type="checkbox" checked={Boolean(parameters.hostedImageGeneration)} disabled={disabled||pending} onChange={event=>setParameters({...parameters,hostedImageGeneration:event.target.checked})} aria-label={t('使用服务端内置生图，由 Responses 直接出图')}/></label>
    </div>}
    <div className="settings-card provider-image-card">
      <p className="provider-card-kicker">{t('生图')}</p>
      <p className="provider-model-hint">{t('这里决定这个 Provider 的图片怎么生成。选好协议后不再逐次探测，失败也不会轮流尝试其他接口而重复计费。')}</p>
      <label className="settings-row"><span>{t('生图协议')}</span><Select aria-label={t('生图协议')} value={imageProtocol} disabled={disabled||pending} onChange={e=>setParameters({...parameters,imageProtocol:e.target.value as ImageProtocol})}>{imageOptions.map(info=><option key={info.id} value={info.id}>{info.label}</option>)}</Select></label>
      {imageInfo&&<p className="provider-model-note">{imageInfo.hint}{imageInfo.endpoint?` · ${imageInfo.endpoint}`:''}</p>}
      {capabilities.length>0&&<p className="provider-image-capabilities">{t('支持')}：{capabilities.join(' · ')}</p>}
      <label className="settings-row"><span>{t('默认画幅')}</span><Select aria-label={t('默认画幅')} value={parameters.imageAspect||''} disabled={disabled||pending||!imageInfo?.capabilities.aspect} onChange={e=>setParameters({...parameters,imageAspect:e.target.value?e.target.value as ModelParameters['imageAspect']:undefined})}><option value="">{t('模型默认')}</option>{IMAGE_ASPECTS.map(aspect=><option key={aspect} value={aspect}>{aspect}</option>)}</Select></label>
      <label className="settings-row"><span>{t('默认质量')}</span><Select aria-label={t('默认质量')} value={parameters.imageQuality||'auto'} disabled={disabled||pending||!imageInfo?.capabilities.quality} onChange={e=>setParameters({...parameters,imageQuality:e.target.value==='auto'?undefined:e.target.value as ModelParameters['imageQuality']})}>{IMAGE_QUALITIES.map(quality=><option key={quality} value={quality}>{quality==='auto'?t('模型默认'):quality}</option>)}</Select></label>
    </div>
    <details className="provider-advanced">
      <summary>{t('对话默认')}</summary>
      <div className="settings-card">
        <label className="settings-row"><span>{t('温度')}</span><input type="number" min={0} max={2} step={0.1} placeholder={t('模型默认')} disabled={disabled||pending} value={parameters.temperature??''} onChange={e=>setParameters({...parameters,temperature:e.target.value===''?undefined:Number(e.target.value)})}/></label>
        {['anthropic','gemini'].includes(parameters.protocol||'chat')&&<label className="settings-row"><span>{t('思考预算')}</span><input type="number" min={1024} max={64000} placeholder={t('模型默认')} disabled={disabled||pending} value={parameters.thinkingBudget??''} onChange={e=>setParameters({...parameters,thinkingBudget:e.target.value===''?undefined:Number(e.target.value)})}/></label>}
        <label className="settings-row"><span>{t('故障时的备用模型')}</span><input value={parameters.fallbackModel||''} disabled={disabled||pending} placeholder={t('不自动切换')} maxLength={256} onChange={e=>setParameters({...parameters,fallbackModel:e.target.value})}/></label>
      </div>
    </details>
    {provider?.hasKey&&<label className="provider-clear-key"><input type="checkbox" checked={clearKey} disabled={disabled||pending} onChange={event=>{setClearKey(event.target.checked);setApiKey('');}}/>{t('清除已保存的密钥')}</label>}
    {error&&<p className="provider-error" role="alert">{error}</p>}
    <div className="settings-actions"><button className="secondary-button" type="button" disabled={pending} onClick={onClose}>{t('关闭')}</button><button className="primary-button" disabled={disabled||pending||!name.trim()||!baseUrl.trim()}>{pending?t('保存并拉取中…'):provider?t('保存并检查连接'):t('添加并拉取模型')}</button></div>
    {provider&&<ProviderModelCatalog provider={provider} disabled={disabled||pending} onChange={next=>onSaved(next,false)}/>}
  </form>;
}

function ProviderModelCatalog({provider,disabled,onChange}:{provider:ModelProvider;disabled:boolean;onChange:(provider:ModelProvider)=>void}){
  const {t}=useI18n();
  const [customId,setCustomId]=useState(''),[query,setQuery]=useState(''),thinking=['anthropic','gemini'].includes(provider.protocol||'chat');
  const save=async(model:ProviderModel)=>{const next=await window.aelion.updateProviderModel({providerId:provider.id,model});onChange(next);};
  const needle=query.trim().toLowerCase(),models=needle?provider.models.filter(model=>model.id.toLowerCase().includes(needle)):provider.models;
  return <div className="provider-model-catalog">
    <h4>{t('模型目录')}</h4>
    <p className="provider-model-hint">{t('这里是拉取到的模型名单，给对话选择器用。上下文和推理在选模型时设置，不必每条都打开。')}</p>
    {provider.models.length>8&&<input className="provider-model-filter" value={query} disabled={disabled} placeholder={t('筛选模型')} onChange={event=>setQuery(event.target.value)}/>}
    {models.map(model=><details key={model.id} className="provider-model-card"><summary><span className="provider-model-id">{model.id}</span><span className="provider-model-meta">{model.imageOutput?`${t('生图')} · `:''}{model.contextTokens?`${Math.round(model.contextTokens/1000)}k`:''}{model.reasoningEffort?` · ${model.reasoningEffort}`:''}{model.thinkingBudget?` · ${model.thinkingBudget}`:''}</span></summary>
      <label className="settings-row settings-number"><span>{t('上下文容量')}</span><ContextCapacityInput value={model.contextTokens??32000} disabled={disabled} onChange={contextTokens=>Number.isInteger(contextTokens)&&void save({...model,contextTokens})}/></label>
      {['chat','responses'].includes(provider.protocol||'chat')&&<label className="settings-row"><span>{t('推理强度')}</span><EditableSelect label={t('推理强度')} value={model.reasoningEffort||''} onChange={text=>void save({...model,reasoningEffort:text||undefined})} options={REASONING_PRESETS} maxLength={80} placeholder={t('模型默认，可输入自定义值')} disabled={disabled}/></label>}
      {thinking&&<label className="settings-row"><span>{t('思考预算')}</span><input type="number" min={1024} max={64000} placeholder={t('模型默认')} disabled={disabled} value={model.thinkingBudget??''} onChange={event=>{const text=event.target.value;if(text==='')void save({...model,thinkingBudget:undefined});else if(Number.isInteger(Number(text)))void save({...model,thinkingBudget:Number(text)});}}/></label>}
      <label className="settings-row provider-hosted-row"><span>{t('可用于生图')}</span><input type="checkbox" checked={Boolean(model.imageOutput)} disabled={disabled} onChange={event=>void save({...model,imageOutput:event.target.checked||undefined})} aria-label={t('把 {model} 标记为生图模型',{model:model.id})}/></label>
      {model.imageOutput&&<>
        <label className="settings-row"><span>{t('默认画幅')}</span><Select aria-label={t('{model} 的默认画幅',{model:model.id})} value={model.imageAspect||''} disabled={disabled} onChange={event=>void save({...model,imageAspect:event.target.value?event.target.value as ProviderModel['imageAspect']:undefined})}><option value="">{t('跟随 Provider')}</option>{IMAGE_ASPECTS.map(aspect=><option key={aspect} value={aspect}>{aspect}</option>)}</Select></label>
        <label className="settings-row"><span>{t('默认质量')}</span><Select aria-label={t('{model} 的默认质量',{model:model.id})} value={model.imageQuality||'auto'} disabled={disabled} onChange={event=>void save({...model,imageQuality:event.target.value==='auto'?undefined:event.target.value as ProviderModel['imageQuality']})}>{IMAGE_QUALITIES.map(quality=><option key={quality} value={quality}>{quality==='auto'?t('跟随 Provider'):quality}</option>)}</Select></label>
      </>}
    </details>)}
    {!models.length&&<p className="provider-empty">{query.trim()?t('没有匹配的模型'):t('还没有模型，保存连接后会自动拉取。')}</p>}
    <div className="provider-model-add"><input value={customId} disabled={disabled} maxLength={256} placeholder={t('自定义模型名称')} onChange={event=>setCustomId(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();const id=customId.trim();if(!id||provider.models.some(model=>model.id===id))return;setCustomId('');void save({id,contextTokens:32000});}}}/><button type="button" className="secondary-button" disabled={disabled||!customId.trim()||provider.models.some(model=>model.id===customId.trim())} onClick={()=>{const id=customId.trim();setCustomId('');void save({id,contextTokens:32000});}}>{t('添加模型')}</button></div>
  </div>;
}
