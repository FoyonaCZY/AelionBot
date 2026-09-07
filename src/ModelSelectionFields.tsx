import {Select} from './Select';
import type {ModelProvider,ModelSelection} from './shared';

export function validModelSelection(value:ModelSelection|null,providers:ModelProvider[]){
  return !value||Boolean(providers.some(provider=>provider.id===value.providerId)&&value.model.trim()&&Number.isInteger(value.contextTokens)&&value.contextTokens>=8000&&value.contextTokens<=1000000);
}

export function ModelSelectionFields({providers,value,onChange,defaultModel,inheritDefault=false,disabled=false}:{providers:ModelProvider[];value:ModelSelection|null;onChange:(value:ModelSelection|null)=>void;defaultModel?:ModelSelection;inheritDefault?:boolean;disabled?:boolean}){
  const provider=providers.find(provider=>provider.id===value?.providerId),ids=provider?.models.map(model=>model.id)||[],existing=value?.model&&!ids.includes(value.model)?value.model:undefined;
  const update=(patch:Partial<ModelSelection>)=>onChange({providerId:value?.providerId||'',model:value?.model||'',contextTokens:value?.contextTokens||32000,...patch});
  return <div className="model-selection-fields">
    {inheritDefault&&<div className="model-default-row"><span>使用默认模型{defaultModel?` · ${defaultModel.model}`:''}</span><button type="button" className={`learning-switch ${value===null?'enabled':''}`} role="switch" aria-label="使用默认模型" aria-checked={value===null} disabled={disabled} onClick={()=>onChange(value===null?{providerId:defaultModel?.providerId||providers[0]?.id||'',model:defaultModel?.model||'',contextTokens:defaultModel?.contextTokens||32000}:null)}><i/></button></div>}
    {(!inheritDefault||value!==null)&&<div className="settings-card">
      <label className="settings-row"><span>Provider</span><Select aria-label="模型 Provider" value={value?.providerId||''} disabled={disabled} onChange={event=>event.target.value?update({providerId:event.target.value,model:''}):onChange(inheritDefault?{providerId:'',model:'',contextTokens:32000}:null)}><option value="">{inheritDefault?'请选择 Provider':'未设置'}</option>{providers.map(provider=><option key={provider.id} value={provider.id}>{provider.name}</option>)}</Select></label>
      <label className="settings-row"><span>模型</span><Select aria-label="使用的模型" value={value?.model||''} disabled={!provider||disabled} onChange={event=>update({model:event.target.value})}><option value="">{ids.length?'请选择模型':'请先拉取模型列表'}</option>{existing&&<option value={existing}>{existing}（当前配置）</option>}{ids.map(id=><option key={id} value={id}>{id}</option>)}</Select></label>
      <label className="settings-row settings-number"><span>上下文容量</span><input aria-label="模型上下文容量" type="number" min={8000} max={1000000} disabled={!value||disabled} value={value?.contextTokens??32000} onChange={event=>update({contextTokens:Number(event.target.value)})}/></label>
    </div>}
  </div>;
}
