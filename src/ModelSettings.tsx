import {Select} from './Select';
import {useEffect,useRef,useState} from 'react';
import type {ModelProvider,ModelSelection,Snapshot} from './shared';
import type {ModelParameters,ModelProtocol} from './model-types';
import {SettingsSection} from './SettingsWindow';
import {ModelSelectionFields,validModelSelection} from './ModelSelectionFields';
import './model-settings.css';

const errorText=(error:unknown)=>(error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,'');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function ModelSettings({state,onNotify}:{state:Snapshot;onNotify:(text:string)=>void}){
  const providers=state.providers||[];
  const [editing,setEditing]=useState<string>(),[refreshing,setRefreshing]=useState<string[]>([]),[removing,setRemoving]=useState('');
  const attempted=useRef(new Set<string>());
  const refresh=async(id:string)=>{setRefreshing(value=>[...new Set([...value,id])]);try{await window.aelion.refreshProviderModels(id);}catch(error){onNotify(errorText(error));}finally{setRefreshing(value=>value.filter(item=>item!==id));}};
  useEffect(()=>{for(const provider of providers)if(!provider.modelsCheckedAt&&!attempted.current.has(provider.id)){attempted.current.add(provider.id);void refresh(provider.id);}},[providers.map(provider=>`${provider.id}:${provider.modelsCheckedAt||''}`).join('|')]);
  const selection=state.defaultModel||null;
  const affected=state.bots.filter(bot=>!bot.model).map(bot=>bot.id),busy=state.runs.some(run=>run.status==='running'&&affected.includes(run.botId));
  const editor=providers.find(provider=>provider.id===editing),editingUsed=state.bots.filter(bot=>(bot.model||state.defaultModel)?.providerId===editing).map(bot=>bot.id),editingBusy=state.runs.some(run=>run.status==='running'&&editingUsed.includes(run.botId));
  return <>
    <SettingsSection title="默认模型">
      <DefaultModelAssignment key={JSON.stringify(selection)} providers={providers} selection={selection} busy={busy} onNotify={onNotify}/>
    </SettingsSection>
    <SettingsSection title="Providers">
      <div className="provider-heading"><button className="secondary-button" onClick={()=>setEditing('new')}>添加 Provider</button></div>
      <div className="settings-card provider-list">{providers.map(provider=>{
        const used=state.defaultModel?.providerId===provider.id||state.bots.some(bot=>bot.model?.providerId===provider.id);
        return <div className="provider-row" key={provider.id}><button className="provider-info" aria-label={`编辑 Provider ${provider.name}`} onClick={()=>setEditing(provider.id)}><strong>{provider.name}</strong><span>{provider.baseUrl}</span></button><span className="provider-model-count">{refreshing.includes(provider.id)?'拉取中…':`${provider.models.length} 个模型`}</span><button className="text-button" disabled={refreshing.includes(provider.id)} onClick={()=>void refresh(provider.id)} aria-label={`刷新 ${provider.name} 模型列表`}>刷新</button><button className="text-button" disabled={used||removing===provider.id} title={used?'请先切换默认模型或相关 Bot 的模型':''} aria-label={`删除 Provider ${provider.name}`} onClick={async()=>{setRemoving(provider.id);try{await window.aelion.removeProvider(provider.id);if(editing===provider.id)setEditing(undefined);}catch(error){onNotify(errorText(error));}finally{setRemoving('');}}}>删除</button></div>;
      })}{!providers.length&&<div className="provider-empty">还没有 Provider</div>}</div>
      {providers.filter(provider=>provider.modelsError).map(provider=><p className="provider-error" role="status" key={provider.id}>{provider.name}：{provider.modelsError}</p>)}
      {editing&&(editing==='new'||editor)&&<ProviderEditor key={editing} provider={editor} disabled={editingBusy} onClose={()=>setEditing(undefined)} onSaved={provider=>{setEditing(undefined);onNotify(provider.modelsError?'Provider 已保存，模型列表拉取失败':'Provider 已保存');}}/>}
    </SettingsSection>
  </>;
}

function DefaultModelAssignment({providers,selection,busy,onNotify}:{providers:ModelProvider[];selection:ModelSelection|null;busy:boolean;onNotify:(text:string)=>void}){
  const [value,setValue]=useState<ModelSelection|null>(selection),[saving,setSaving]=useState(false);
  const save=async()=>{setSaving(true);try{await window.aelion.setDefaultModel(value);onNotify('默认模型已保存');}catch(error){onNotify(errorText(error));}finally{setSaving(false);}};
  return <div className="model-assignment">
    <ModelSelectionFields providers={providers} value={value} onChange={setValue} disabled={busy||saving}/>
    <div className="settings-actions"><button className="primary-button" disabled={busy||saving||!validModelSelection(value,providers)||same(value,selection)} onClick={()=>void save()}>{saving?'保存中…':'保存默认模型'}</button></div>
  </div>;
}

function ProviderEditor({provider,disabled,onClose,onSaved}:{provider?:ModelProvider;disabled:boolean;onClose:()=>void;onSaved:(provider:ModelProvider)=>void}){
  const form=useRef<HTMLFormElement>(null);
  useEffect(()=>{form.current?.scrollIntoView({block:'start'});form.current?.querySelector<HTMLInputElement>('[aria-label="Provider 名称"]')?.focus({preventScroll:true});},[]);
  const [parameters,setParameters]=useState<ModelParameters>({protocol:provider?(provider.protocol||'chat'):'responses',temperature:provider?.temperature,thinkingBudget:provider?.thinkingBudget,fallbackModel:provider?.fallbackModel});
  const [name,setName]=useState(provider?.name||''),[baseUrl,setBaseUrl]=useState(provider?.baseUrl||''),[apiKey,setApiKey]=useState(''),[clearKey,setClearKey]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState('');
  const save=async()=>{setPending(true);setError('');try{const saved=await window.aelion.saveProvider({id:provider?.id,name,baseUrl,...parameters,apiKey:clearKey?null:apiKey||undefined});setName(saved.name);setBaseUrl(saved.baseUrl);setApiKey('');setClearKey(false);onSaved(saved);}catch(error){setError(errorText(error));}finally{setPending(false);}};
  return <form ref={form} className="provider-editor" onSubmit={event=>{event.preventDefault();void save();}}>
    <h4>{provider?'编辑 Provider':'添加 Provider'}</h4><div className="settings-card">
      <label className="settings-row"><span>协议</span><Select aria-label="Provider 协议" value={parameters.protocol} disabled={disabled||pending} onChange={e=>setParameters({protocol:e.target.value as ModelProtocol})}><option value="chat">OpenAI 兼容</option><option value="responses">OpenAI Responses</option><option value="anthropic">Claude Messages</option><option value="gemini">Gemini Generate Content</option></Select></label>
      <label className="settings-row"><span>名称</span><input aria-label="Provider 名称" value={name} onChange={event=>setName(event.target.value)} maxLength={80} disabled={disabled||pending} placeholder="例如：OpenAI"/></label>
      <label className="settings-row"><span>Base URL</span><input aria-label="Provider Base URL" value={baseUrl} onChange={event=>setBaseUrl(event.target.value)} maxLength={2000} spellCheck={false} disabled={disabled||pending} placeholder="https://api.example.com/v1"/></label>
      <label className="settings-row"><span>API Key</span><input aria-label="Provider API Key" type="password" autoComplete="off" value={apiKey} onChange={event=>{setApiKey(event.target.value);setClearKey(false);}} disabled={disabled||pending} maxLength={4000} placeholder={provider?.hasKey&&!clearKey?'已保存，留空保持不变':'本地服务可留空'}/></label>
      <label className="settings-row"><span>温度</span><input type="number" min={0} max={2} step={0.1} placeholder="模型默认" disabled={disabled||pending} value={parameters.temperature??''} onChange={e=>setParameters({...parameters,temperature:e.target.value===''?undefined:Number(e.target.value)})}/></label>
      {['anthropic','gemini'].includes(parameters.protocol||'chat')&&<label className="settings-row"><span>思考预算</span><input type="number" min={1024} max={64000} placeholder="模型默认" disabled={disabled||pending} value={parameters.thinkingBudget??''} onChange={e=>setParameters({...parameters,thinkingBudget:e.target.value===''?undefined:Number(e.target.value)})}/></label>}
      <label className="settings-row"><span>故障时的备用模型</span><input value={parameters.fallbackModel||''} disabled={disabled||pending} placeholder="不自动切换" maxLength={256} onChange={e=>setParameters({...parameters,fallbackModel:e.target.value})}/></label>
    </div>
    {provider?.hasKey&&<label className="provider-clear-key"><input type="checkbox" checked={clearKey} disabled={disabled||pending} onChange={event=>{setClearKey(event.target.checked);setApiKey('');}}/>清除已保存的密钥</label>}
    {error&&<p className="provider-error" role="alert">{error}</p>}
    <div className="settings-actions"><button className="secondary-button" type="button" disabled={pending} onClick={onClose}>关闭</button><button className="primary-button" disabled={disabled||pending||!name.trim()||!baseUrl.trim()}>{pending?'保存并拉取中…':provider?'保存修改并拉取模型':'添加并拉取模型'}</button></div>
  </form>;
}
