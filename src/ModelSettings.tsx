import {Select} from './Select';
import {useEffect,useRef,useState} from 'react';
import type {ModelProvider,ModelSelection,ProviderModel,Snapshot} from './shared';
import type {ModelParameters,ModelProtocol} from './model-types';
import {IMAGE_ASPECTS,IMAGE_QUALITIES,type ImageProtocol,type ImageProtocolInfo} from './image-types';
import {Icon} from './ui';
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
  const {t}=useI18n(),providers=state.providers||[];
  const [page,setPage]=useState<'assignments'|'providers'>(providers.length?'assignments':'providers');
  const [editing,setEditing]=useState<string>(providers[0]?.id||'new'),[refreshing,setRefreshing]=useState<string[]>([]),[removing,setRemoving]=useState('');
  const attempted=useRef(new Set<string>());
  const refresh=async(id:string)=>{setRefreshing(value=>[...new Set([...value,id])]);try{await window.aelion.refreshProviderModels(id);}catch(error){onNotify(errorText(error));}finally{setRefreshing(value=>value.filter(item=>item!==id));}};
  useEffect(()=>{for(const provider of providers)if(!provider.modelsCheckedAt&&!attempted.current.has(provider.id)){attempted.current.add(provider.id);void refresh(provider.id);}},[providers.map(provider=>`${provider.id}:${provider.modelsCheckedAt||''}`).join('|')]);
  useEffect(()=>{if(editing!=='new'&&!providers.some(provider=>provider.id===editing))setEditing(providers[0]?.id||'new');},[editing,providers]);
  const affected=state.bots.filter(bot=>!bot.model).map(bot=>bot.id),busy=state.runs.some(run=>run.status==='running'&&affected.includes(run.botId));
  const editor=providers.find(provider=>provider.id===editing),editingUsed=state.bots.filter(bot=>(bot.model||state.defaultModel)?.providerId===editing).map(bot=>bot.id),editingBusy=state.runs.some(run=>run.status==='running'&&editingUsed.includes(run.botId));
  const used=Boolean(editor&&(state.defaultModel?.providerId===editor.id||state.approvalModel?.providerId===editor.id||state.bots.some(bot=>bot.model?.providerId===editor.id)));
  const remove=async()=>{if(!editor||used)return;setRemoving(editor.id);try{await window.aelion.removeProvider(editor.id);setEditing(providers.find(provider=>provider.id!==editor.id)?.id||'new');}catch(error){onNotify(errorText(error));}finally{setRemoving('');}};
  return <div className="model-settings-workspace">
    <div className="model-settings-navigation" role="group" aria-label={t('模型设置')}>
      <button type="button" aria-pressed={page==='assignments'} onClick={()=>setPage('assignments')}><Icon name="sliders" size={16}/>{t('模型分配')}</button>
      <button type="button" aria-pressed={page==='providers'} onClick={()=>setPage('providers')}><Icon name="layers" size={16}/>Providers<span className="model-count-badge">{providers.length}</span></button>
    </div>
    <div className="model-assignments-page" hidden={page!=='assignments'}>
      <div className="model-assignment-grid">
        <section className="model-assignment-panel"><header><Icon name="message" size={18}/><h3>{t('默认模型')}</h3></header><DefaultModelAssignment providers={providers} selection={state.defaultModel||null} busy={busy} onNotify={onNotify}/>{busy&&<p className="provider-model-note" role="status">{t('任务运行中，暂不可修改')}</p>}</section>
        <section className="model-assignment-panel"><header><Icon name="shield" size={18}/><h3>{t('自动审核模型')}</h3></header><DefaultModelAssignment approval defaultModel={state.defaultModel} providers={providers} selection={state.approvalModel||null} busy={false} onNotify={onNotify}/></section>
      </div>
      {!providers.length&&<button type="button" className="secondary-button model-add-first" onClick={()=>{setEditing('new');setPage('providers');}}><Icon name="plus" size={16}/>{t('添加 Provider')}</button>}
    </div>
    <div className="provider-workspace" hidden={page!=='providers'}>
      <aside className="provider-browser" aria-label={t('Provider 列表')}>
        <div className="provider-browser-heading"><span>Providers</span><button type="button" className="icon-button" aria-label={t('添加 Provider')} title={t('添加 Provider')} onClick={()=>setEditing('new')}><Icon name="plus" size={17}/></button></div>
        <div className="provider-browser-list">
          {providers.map(provider=><button type="button" key={provider.id} className={`provider-browser-item${editing===provider.id?' is-selected':''}`} aria-pressed={editing===provider.id} aria-label={t('编辑 Provider {name}',{name:provider.name})} onClick={()=>setEditing(provider.id)}><span className="provider-browser-name"><strong>{provider.name}</strong>{provider.modelsError&&<span className="provider-warning" title={provider.modelsError}><Icon name="alert" size={14}/></span>}</span><span className="provider-browser-meta">{protocolName(provider.protocol,t)}<span>{refreshing.includes(provider.id)?t('拉取中…'):provider.models.length}</span></span></button>)}
          {editing==='new'&&<div className="provider-browser-item is-selected provider-new-item"><Icon name="plus" size={16}/>{t('添加 Provider')}</div>}
        </div>
      </aside>
      <ProviderEditor key={editing} provider={editor} disabled={editingBusy} refreshing={Boolean(editor&&refreshing.includes(editor.id))} removing={removing===editing} used={used} onRefresh={()=>editor&&void refresh(editor.id)} onRemove={()=>void remove()} onSaved={(provider,close)=>{setEditing(current=>current===editing?provider.id:current);onNotify(provider.modelsError?t('Provider 已保存，模型列表拉取失败'):close===false?t('模型目录已更新'):t('Provider 已保存'));}}/>
    </div>
  </div>;
}

function DefaultModelAssignment({providers,selection,busy,onNotify,approval=false,defaultModel}:{approval?:boolean;defaultModel?:ModelSelection;providers:ModelProvider[];selection:ModelSelection|null;busy:boolean;onNotify:(text:string)=>void}){
  const [value,setValue]=useState<ModelSelection|null>(selection),seq=useRef(0);
  useEffect(()=>{setValue(selection);},[JSON.stringify(selection)]);
  const persist=async(next:ModelSelection|null)=>{
    setValue(next);
    if(!validModelSelection(next,providers)||same(next,selection))return;
    const n=++seq.current;
    try{if(approval)await window.aelion.setApprovalModel(next);else await window.aelion.setDefaultModel(next);}
    catch(error){if(n===seq.current){setValue(selection);onNotify(errorText(error));}}
  };
  return <div className="model-assignment">
    <ModelSelectionFields providers={providers} value={value} onChange={persist} disabled={busy} inheritDefault={approval} defaultModel={defaultModel} showInheritedReasoning={!approval}/>
  </div>;
}

function ProviderEditor({provider,disabled,refreshing,removing,used,onRefresh,onRemove,onSaved}:{provider?:ModelProvider;disabled:boolean;refreshing:boolean;removing:boolean;used:boolean;onRefresh:()=>void;onRemove:()=>void;onSaved:(provider:ModelProvider,close?:boolean)=>void}){
  const {t}=useI18n();
  const [tab,setTab]=useState<'connection'|'models'|'images'|'advanced'>('connection');
  const form=useRef<HTMLFormElement>(null);
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
  return <form ref={form} className="provider-editor" onInvalidCapture={event=>{
    const field=event.target as HTMLInputElement,panel=field.closest<HTMLElement>('[data-provider-panel]');
    if(panel?.hidden){event.preventDefault();setTab(panel.dataset.providerPanel as typeof tab);requestAnimationFrame(()=>{field.focus();field.reportValidity();});}
  }} onSubmit={event=>{event.preventDefault();if(!disabled&&!pending&&name.trim()&&baseUrl.trim())void save();}}>
    <header className="provider-editor-heading"><div><h3>{provider?.name||t('添加 Provider')}</h3>{provider&&<span className="provider-protocol">{protocolName(provider.protocol,t)}</span>}</div>{provider&&<button type="button" className="icon-button provider-delete" disabled={used||disabled||pending||removing} title={used?t('请先切换使用此 Provider 的默认模型、审核模型或 Bot 模型'):t('删除 Provider {name}',{name:provider.name})} aria-label={t('删除 Provider {name}',{name:provider.name})} onClick={onRemove}><Icon name="trash" size={16}/></button>}</header>
    <div className="provider-editor-tabs" role="group" aria-label={t('Provider 设置')}>
      {([{id:'connection',label:t('连接')},{id:'models',label:t('模型'),count:provider?.models.length},{id:'images',label:t('生图')},{id:'advanced',label:t('高级')}] as const).map(item=><button type="button" key={item.id} aria-pressed={tab===item.id} disabled={item.id==='models'&&!provider} onClick={()=>setTab(item.id)}>{item.label}{'count' in item&&item.count!==undefined&&<span>{item.count}</span>}</button>)}
    </div>
    {disabled&&<p className="provider-editor-notice" role="status">{t('任务运行中，暂不可修改')}</p>}
    <div className="provider-editor-content" data-provider-panel="connection" hidden={tab!=='connection'}>
    <div className="settings-card">
      <label className="settings-row"><span>{t('协议')}</span><Select aria-label={t('Provider 协议')} value={parameters.protocol} disabled={disabled||pending} onChange={e=>setParameters({...parameters,protocol:e.target.value as ModelProtocol})}><option value="chat">OpenAI {t('兼容')}</option><option value="responses">OpenAI Responses</option><option value="anthropic">Claude Messages</option><option value="gemini">Gemini Generate Content</option></Select></label>
      <label className="settings-row"><span>{t('名称')}</span><input aria-label={t('Provider 名称')} value={name} onChange={event=>setName(event.target.value)} maxLength={80} disabled={disabled||pending} placeholder={t('例如：OpenAI')}/></label>
      <label className="settings-row"><span>Base URL</span><input aria-label={t('Provider Base URL')} value={baseUrl} onChange={event=>setBaseUrl(event.target.value)} maxLength={2000} spellCheck={false} disabled={disabled||pending} placeholder="https://api.example.com/v1"/></label>
      <label className="settings-row"><span>API Key</span><input aria-label={t('Provider API Key')} type="password" autoComplete="off" value={apiKey} onChange={event=>{setApiKey(event.target.value);setClearKey(false);}} disabled={disabled||pending} maxLength={4000} placeholder={provider?.hasKey&&!clearKey?t('已保存，留空保持不变'):t('本地服务可留空')}/></label>

    </div>
    {provider?.hasKey&&<label className="provider-clear-key"><input type="checkbox" checked={clearKey} disabled={disabled||pending} onChange={event=>{setClearKey(event.target.checked);setApiKey('');}}/>{t('清除已保存的密钥')}</label>}
    </div>
    <div className="provider-editor-content" data-provider-panel="images" hidden={tab!=='images'}>
    <div className="settings-card provider-image-card">
      <label className="settings-row"><span>{t('生图协议')}</span><Select aria-label={t('生图协议')} value={imageProtocol} disabled={disabled||pending} onChange={e=>setParameters({...parameters,imageProtocol:e.target.value as ImageProtocol})}>{imageOptions.map(info=><option key={info.id} value={info.id}>{info.label}</option>)}</Select></label>
      {imageInfo?.endpoint&&<p className="provider-model-note">{imageInfo.endpoint}</p>}
      {capabilities.length>0&&<p className="provider-image-capabilities">{t('支持')}：{capabilities.join(' · ')}</p>}
      <label className="settings-row"><span>{t('默认画幅')}</span><Select aria-label={t('默认画幅')} value={parameters.imageAspect||''} disabled={disabled||pending||!imageInfo?.capabilities.aspect} onChange={e=>setParameters({...parameters,imageAspect:e.target.value?e.target.value as ModelParameters['imageAspect']:undefined})}><option value="">{t('模型默认')}</option>{IMAGE_ASPECTS.map(aspect=><option key={aspect} value={aspect}>{aspect}</option>)}</Select></label>
      <label className="settings-row"><span>{t('默认质量')}</span><Select aria-label={t('默认质量')} value={parameters.imageQuality||'auto'} disabled={disabled||pending||!imageInfo?.capabilities.quality} onChange={e=>setParameters({...parameters,imageQuality:e.target.value==='auto'?undefined:e.target.value as ModelParameters['imageQuality']})}>{IMAGE_QUALITIES.map(quality=><option key={quality} value={quality}>{quality==='auto'?t('模型默认'):quality}</option>)}</Select></label>
    </div>
    </div>
    <div className="provider-editor-content" data-provider-panel="advanced" hidden={tab!=='advanced'}>
      <div className="settings-card">
      {responses&&<label className="settings-row"><span>{t('连接方式')}</span><Select aria-label={t('Responses 连接方式')} value={parameters.responsesTransport||'auto'} disabled={disabled||pending} onChange={e=>setParameters({...parameters,responsesTransport:e.target.value as ModelParameters['responsesTransport']})}><option value="auto">{t('自动')}</option><option value="http">HTTP</option><option value="websocket">WebSocket（{t('服务端支持时')}）</option></Select></label>}
      </div>
      <h4>{t('对话默认')}</h4>
      <div className="settings-card">
        <label className="settings-row"><span>{t('温度')}</span><input type="number" min={0} max={2} step={0.1} placeholder={t('模型默认')} disabled={disabled||pending} value={parameters.temperature??''} onChange={e=>setParameters({...parameters,temperature:e.target.value===''?undefined:Number(e.target.value)})}/></label>
        {['anthropic','gemini'].includes(parameters.protocol||'chat')&&<label className="settings-row"><span>{t('思考预算')}</span><input type="number" min={1024} max={64000} placeholder={t('模型默认')} disabled={disabled||pending} value={parameters.thinkingBudget??''} onChange={e=>setParameters({...parameters,thinkingBudget:e.target.value===''?undefined:Number(e.target.value)})}/></label>}
        <label className="settings-row"><span>{t('故障时的备用模型')}</span><input value={parameters.fallbackModel||''} disabled={disabled||pending} placeholder={t('不自动切换')} maxLength={256} onChange={e=>setParameters({...parameters,fallbackModel:e.target.value})}/></label>
      </div>
    {responses&&<div className="settings-card provider-tools-card">
      <p className="provider-card-kicker">{t('Responses 工具')}</p>
      <label className="settings-row provider-hosted-row"><span>{t('服务端搜索')}</span><input type="checkbox" checked={Boolean(parameters.hostedWebSearch)} disabled={disabled||pending} onChange={event=>setParameters({...parameters,hostedWebSearch:event.target.checked})} aria-label={t('使用服务端内置搜索，不再提供应用内 web_search')}/></label>
      <label className="settings-row provider-hosted-row"><span>{t('服务端生图')}</span><input type="checkbox" checked={Boolean(parameters.hostedImageGeneration)} disabled={disabled||pending} onChange={event=>setParameters({...parameters,hostedImageGeneration:event.target.checked})} aria-label={t('使用服务端内置生图，由 Responses 直接出图')}/></label>
    </div>}
    </div>
    {provider&&<div className="provider-editor-content provider-catalog-panel" data-provider-panel="models" hidden={tab!=='models'}><ProviderModelCatalog provider={provider} disabled={disabled||pending} refreshing={refreshing} onRefresh={onRefresh} onChange={next=>onSaved(next,false)}/></div>}
    <footer className="provider-editor-footer">
      <div className="provider-save-status" role="status">{error?<span className="provider-error">{error}</span>:provider?.modelsError?<span className="provider-error">{provider.modelsError}</span>:provider?.hasKey?<span><Icon name="check" size={14}/>{t('密钥已保存')}</span>:null}</div>
      <button className="primary-button" disabled={disabled||pending||!name.trim()||!baseUrl.trim()}>{pending?t('保存并拉取中…'):provider?t('保存更改'):t('添加 Provider')}</button>
    </footer>
  </form>;
}

function ProviderModelCatalog({provider,disabled,refreshing,onRefresh,onChange}:{provider:ModelProvider;disabled:boolean;refreshing:boolean;onRefresh:()=>void;onChange:(provider:ModelProvider)=>void}){
  const {t}=useI18n();
  const [customId,setCustomId]=useState(''),[query,setQuery]=useState(''),thinking=['anthropic','gemini'].includes(provider.protocol||'chat');
  const [error,setError]=useState(''),[saving,setSaving]=useState(false);
  const save=async(model:ProviderModel)=>{setSaving(true);setError('');try{const next=await window.aelion.updateProviderModel({providerId:provider.id,model});onChange(next);return true;}catch(error){setError(errorText(error));return false;}finally{setSaving(false);}};
  const add=async()=>{const id=customId.trim();if(disabled||saving||!id||provider.models.some(model=>model.id===id))return;if(await save({id,contextTokens:32000}))setCustomId('');};
  const needle=query.trim().toLowerCase(),models=needle?provider.models.filter(model=>model.id.toLowerCase().includes(needle)):provider.models;
  return <div className="provider-model-catalog">
    <div className="provider-catalog-toolbar"><label className="provider-model-search"><Icon name="search" size={16}/><input value={query} aria-label={t('筛选模型')} placeholder={t('筛选模型')} onChange={event=>setQuery(event.target.value)}/></label><button className="text-button" type="button" disabled={disabled||refreshing||saving} onClick={onRefresh}><Icon name="restart" size={14}/>{refreshing?t('拉取中…'):t('刷新')}</button></div>
    <div className="provider-model-add"><input value={customId} disabled={disabled||saving} aria-label={t('自定义模型名称')} maxLength={256} placeholder={t('自定义模型名称')} onChange={event=>setCustomId(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();void add();}}}/><button type="button" className="secondary-button" disabled={disabled||saving||!customId.trim()||provider.models.some(model=>model.id===customId.trim())} onClick={()=>void add()}><Icon name="plus" size={15}/>{t('添加模型')}</button></div>
    {error&&<p className="provider-error" role="alert">{error}</p>}
    <div className="provider-model-results">
    {models.map(model=><details key={model.id} className="provider-model-card"><summary><Icon name="arrow" size={14}/><span className="provider-model-id" title={model.id}>{model.id}</span><span className="provider-model-meta">{model.imageOutput?`${t('生图')} · `:''}{model.contextTokens?`${Math.round(model.contextTokens/1000)}k`:''}{model.reasoningEffort?` · ${model.reasoningEffort}`:''}{model.thinkingBudget?` · ${model.thinkingBudget}`:''}</span></summary>
      <label className="settings-row settings-number"><span>{t('上下文容量')}</span><ContextCapacityInput value={model.contextTokens??32000} disabled={disabled} onChange={contextTokens=>Number.isInteger(contextTokens)&&void save({...model,contextTokens})}/></label>
      {['chat','responses'].includes(provider.protocol||'chat')&&<label className="settings-row"><span>{t('推理强度')}</span><EditableSelect label={t('推理强度')} value={model.reasoningEffort||''} onChange={text=>void save({...model,reasoningEffort:text||undefined})} options={REASONING_PRESETS} maxLength={80} placeholder={t('模型默认，可输入自定义值')} disabled={disabled}/></label>}
      {thinking&&<label className="settings-row"><span>{t('思考预算')}</span><input type="number" min={1024} max={64000} placeholder={t('模型默认')} disabled={disabled} value={model.thinkingBudget??''} onChange={event=>{const text=event.target.value;if(text==='')void save({...model,thinkingBudget:undefined});else if(Number.isInteger(Number(text)))void save({...model,thinkingBudget:Number(text)});}}/></label>}
      <label className="settings-row provider-hosted-row"><span>{t('可用于生图')}</span><input type="checkbox" checked={Boolean(model.imageOutput)} disabled={disabled} onChange={event=>void save({...model,imageOutput:event.target.checked||undefined})} aria-label={t('把 {model} 标记为生图模型',{model:model.id})}/></label>
      {model.imageOutput&&<>
        <label className="settings-row"><span>{t('默认画幅')}</span><Select aria-label={t('{model} 的默认画幅',{model:model.id})} value={model.imageAspect||''} disabled={disabled} onChange={event=>void save({...model,imageAspect:event.target.value?event.target.value as ProviderModel['imageAspect']:undefined})}><option value="">{t('跟随 Provider')}</option>{IMAGE_ASPECTS.map(aspect=><option key={aspect} value={aspect}>{aspect}</option>)}</Select></label>
        <label className="settings-row"><span>{t('默认质量')}</span><Select aria-label={t('{model} 的默认质量',{model:model.id})} value={model.imageQuality||'auto'} disabled={disabled} onChange={event=>void save({...model,imageQuality:event.target.value==='auto'?undefined:event.target.value as ProviderModel['imageQuality']})}>{IMAGE_QUALITIES.map(quality=><option key={quality} value={quality}>{quality==='auto'?t('跟随 Provider'):quality}</option>)}</Select></label>
      </>}
    </details>)}
    {!models.length&&<p className="provider-empty">{query.trim()?t('没有匹配的模型'):t('暂无模型')}</p>}
    </div>
  </div>;
}
