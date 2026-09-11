import {Select} from './Select';
import {ContextCapacityInput} from './ContextCapacityInput';
import type {ModelProvider,ModelSelection} from './shared';
import {EditableSelect} from './EditableSelect';
import {REASONING_PRESETS} from './reasoning';
import {useI18n} from './i18n';

export function validModelSelection(value:ModelSelection|null,providers:ModelProvider[]){
  return !value||Boolean(providers.some(provider=>provider.id===value.providerId)&&value.model.trim()&&Number.isInteger(value.contextTokens)&&value.contextTokens>=8000&&value.contextTokens<=1000000);
}

export function ModelSelectionFields({providers,value,onChange,defaultModel,inheritDefault=false,disabled=false,reasoningValue,onReasoningChange}:{providers:ModelProvider[];value:ModelSelection|null;onChange:(value:ModelSelection|null)=>void;defaultModel?:ModelSelection;inheritDefault?:boolean;disabled?:boolean;reasoningValue?:string;onReasoningChange?:(value:string)=>void}){
  const {t}=useI18n();
  const provider=providers.find(provider=>provider.id===value?.providerId),ids=provider?.models.map(model=>model.id)||[];
  const effective=provider||(inheritDefault&&value===null?providers.find(provider=>provider.id===defaultModel?.providerId):undefined);
  const update=(patch:Partial<ModelSelection>)=>onChange({providerId:value?.providerId||'',model:value?.model||'',contextTokens:value?.contextTokens||32000,...value,...patch});
  const reason=effective&&['chat','responses'].includes(effective.protocol||'chat')?<label className="settings-row"><span>{t('推理强度')}</span><EditableSelect label={t('推理强度')} value={onReasoningChange?reasoningValue||'':value?.reasoningEffort||''} onChange={text=>onReasoningChange?onReasoningChange(text):update({reasoningEffort:text||undefined})} options={REASONING_PRESETS} maxLength={80} placeholder={t('模型默认，可输入自定义值')} disabled={disabled}/></label>:null;
  return <div className="model-selection-fields">
    {inheritDefault&&<div className="model-default-row"><span>{t('使用默认模型')}{defaultModel?` · ${defaultModel.model}`:''}</span><button type="button" className={`learning-switch ${value===null?'enabled':''}`} role="switch" aria-label={t('使用默认模型')} aria-checked={value===null} disabled={disabled} onClick={()=>onChange(value===null?{providerId:defaultModel?.providerId||providers[0]?.id||'',model:defaultModel?.model||'',contextTokens:defaultModel?.contextTokens||32000}:null)}><i/></button></div>}
    {(!inheritDefault||value!==null)&&<div className="settings-card">
      <label className="settings-row"><span>Provider</span><Select aria-label={t('模型 Provider')} value={value?.providerId||''} disabled={disabled} onChange={event=>event.target.value?update({providerId:event.target.value,model:''}):onChange(inheritDefault?{providerId:'',model:'',contextTokens:32000}:null)}><option value="">{inheritDefault?t('请选择 Provider'):t('未设置')}</option>{providers.map(provider=><option key={provider.id} value={provider.id}>{provider.name}</option>)}</Select></label>
      <label className="settings-row"><span>{t('模型')}</span><EditableSelect label={t('使用的模型')} value={value?.model||''} disabled={!provider||disabled} onChange={model=>update({model,supportsImages:undefined})} options={ids} placeholder={t('选择或输入模型名称')}/></label>
      <label className="settings-row settings-number"><span>{t('上下文容量')}</span><ContextCapacityInput value={value?.contextTokens??32000} disabled={!value||disabled} onChange={contextTokens=>update({contextTokens})}/></label>
      {reason}
    </div>}
    {inheritDefault&&value===null&&reason&&<div className="settings-card model-reasoning-card">{reason}</div>}
  </div>;
}
