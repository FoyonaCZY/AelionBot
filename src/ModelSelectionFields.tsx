import {Select} from './Select';
import {useState} from 'react';
import {ContextCapacityInput} from './ContextCapacityInput';
import type {ModelProvider,ModelSelection} from './shared';
import {EditableSelect} from './EditableSelect';
import {REASONING_PRESETS} from './reasoning';
import {useI18n} from './i18n';

export function validModelSelection(value:ModelSelection|null,providers:ModelProvider[]){
  return !value||Boolean(providers.some(provider=>provider.id===value.providerId)&&value.model.trim()&&Number.isInteger(value.contextTokens)&&value.contextTokens>=8000&&value.contextTokens<=1000000);
}

/** Proves the image route end to end instead of leaving the user to discover it on the first real task. */
function ImageModelTest({selection,disabled}:{selection:ModelSelection;disabled:boolean}){
  const {t}=useI18n();
  const [state,setState]=useState<{phase:'idle'|'running'|'done'|'error';text?:string}>({phase:'idle'});
  const run=async()=>{
    setState({phase:'running'});
    try{
      const result=await window.aelion.testImageModel({selection});
      setState({phase:'done',text:t('连接成功，使用 {protocol} 协议，返回 {size} KB 图片。',{protocol:result.protocol,size:Math.max(1,Math.round(result.bytes/1024))})});
    }catch(error){
      setState({phase:'error',text:(error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,'')});
    }
  };
  return <div className="image-model-test">
    <button type="button" className="secondary-button" disabled={disabled||state.phase==='running'||!selection.providerId||!selection.model.trim()} onClick={()=>void run()}>{state.phase==='running'?t('正在生成测试图…'):t('测试生图连接')}</button>
    {state.text&&<p className={state.phase==='error'?'provider-error':'provider-model-note'} role="status">{state.text}</p>}
  </div>;
}

export function ModelSelectionFields({providers,value,onChange,defaultModel,inheritDefault=false,disabled=false,reasoningValue,onReasoningChange,showInheritedReasoning=true,noneLabel,purpose='chat'}:{showInheritedReasoning?:boolean;providers:ModelProvider[];value:ModelSelection|null;onChange:(value:ModelSelection|null)=>void;defaultModel?:ModelSelection;inheritDefault?:boolean;disabled?:boolean;reasoningValue?:string;onReasoningChange?:(value:string)=>void;noneLabel?:string;purpose?:'chat'|'image'}){
  const {t}=useI18n();
  const image=purpose==='image',provider=providers.find(provider=>provider.id===value?.providerId);
  // For image work, models the user marked as image-capable come first so the list is usable on a large catalog.
  const ids=image
    ?[...(provider?.models||[])].sort((a,b)=>Number(Boolean(b.imageOutput))-Number(Boolean(a.imageOutput))||a.id.localeCompare(b.id)).map(model=>model.id)
    :provider?.models.map(model=>model.id)||[];
  const effective=provider||(inheritDefault&&value===null?providers.find(provider=>provider.id===defaultModel?.providerId):undefined);
  const update=(patch:Partial<ModelSelection>)=>onChange({providerId:value?.providerId||'',model:value?.model||'',contextTokens:value?.contextTokens||32000,...value,...patch});
  const reason=!image&&effective&&['chat','responses'].includes(effective.protocol||'chat')?<label className="settings-row"><span>{t('推理强度')}</span><EditableSelect label={t('推理强度')} value={onReasoningChange?reasoningValue||'':value?.reasoningEffort||''} onChange={text=>onReasoningChange?onReasoningChange(text):update({reasoningEffort:text||undefined})} options={REASONING_PRESETS} maxLength={80} placeholder={t('模型默认，可输入自定义值')} disabled={disabled}/></label>:null;
  return <div className="model-selection-fields">
    {inheritDefault&&<div className="model-default-row"><span>{noneLabel||t('使用默认模型')}{!noneLabel&&defaultModel?` · ${defaultModel.model}`:''}</span><button type="button" className={`learning-switch ${value===null?'enabled':''}`} role="switch" aria-label={noneLabel||t('使用默认模型')} aria-checked={value===null} disabled={disabled} onClick={()=>onChange(value===null?{providerId:defaultModel?.providerId||providers[0]?.id||'',model:defaultModel?.model||'',contextTokens:defaultModel?.contextTokens||32000}:null)}><i/></button></div>}
    {(!inheritDefault||value!==null)&&<div className="settings-card">
      <label className="settings-row"><span>Provider</span><Select aria-label={t('模型 Provider')} value={value?.providerId||''} disabled={disabled} onChange={event=>event.target.value?update({providerId:event.target.value,model:''}):onChange(inheritDefault?{providerId:'',model:'',contextTokens:32000}:null)}><option value="">{inheritDefault?t('请选择 Provider'):t('未设置')}</option>{providers.map(provider=><option key={provider.id} value={provider.id}>{provider.name}</option>)}</Select></label>
      <label className="settings-row"><span>{t('模型')}</span><EditableSelect label={t('使用的模型')} value={value?.model||''} disabled={!provider||disabled} onChange={model=>{const entry=provider?.models.find(item=>item.id===model);update({model,...(image?{}:{contextTokens:entry?.contextTokens||value?.contextTokens||32000,reasoningEffort:entry?.reasoningEffort})});}} options={ids} placeholder={t('选择或输入模型名称')}/></label>
      {!image&&(()=>{const entry=provider?.models.find(item=>item.id===value?.model);return entry?.contextTokens?<p className="model-catalog-note">{t('上下文 {tokens} Token',{tokens:entry.contextTokens.toLocaleString()})}{entry.reasoningEffort?` · ${entry.reasoningEffort}`:''}{provider?.hostedWebSearch?` · ${t('服务端搜索')}`:''}{provider?.hostedImageGeneration?` · ${t('服务端生图')}`:''}</p>:<label className="settings-row settings-number"><span>{t('上下文容量')}</span><ContextCapacityInput value={value?.contextTokens??32000} disabled={!value||disabled} onChange={contextTokens=>update({contextTokens})}/></label>;})()}
      {image&&(()=>{const entry=provider?.models.find(item=>item.id===value?.model),aspect=entry?.imageAspect||provider?.imageAspect,quality=entry?.imageQuality||provider?.imageQuality;return <>
        <p className="model-catalog-note">{t('生图协议')}：{provider?.imageProtocol||t('自动检测')}{aspect?` · ${aspect}`:''}{quality?` · ${quality}`:''}{entry&&!entry.imageOutput?` · ${t('未标记为生图模型')}`:''}</p>
        {value&&<ImageModelTest selection={value} disabled={disabled}/>}
      </>;})()}
      {!image&&!(provider?.models.some(item=>item.id===value?.model&&item.reasoningEffort))&&reason}
    </div>}
    {inheritDefault&&showInheritedReasoning&&value===null&&reason&&<div className="settings-card model-reasoning-card">{reason}</div>}
  </div>;
}
