import {useId,useState,type ReactNode} from 'react';
import {DEFAULT_RUNTIME,type RuntimeSettings as Values} from './runtime-types';
import {RUNTIME_FIELDS,runtimeDraft,runtimeDraftValues,runtimeFieldValid,type RuntimeField,type RuntimeNumberKey} from './runtime-form';
import {useI18n} from './i18n';
import './runtime-settings.css';

function RuntimeNumber({field,value,onChange}:{field:RuntimeField;value:string;onChange:(value:string)=>void}){
  const {t}=useI18n();
  const id=useId(),valid=runtimeFieldValid(field,value),step=1/(field.factor||1);
  const change=(direction:number)=>onChange(String(Math.max(field.min,Math.min(field.max,(Number(value)||0)+direction))));
  return <div className="runtime-field"><label htmlFor={id} className="runtime-field-copy"><span>{t(field.label)}</span><small id={id+'-hint'} className={valid?'':'is-invalid'}>{valid?t(field.hint):t('请输入 {min}–{max} {unit}',{min:field.min.toLocaleString(),max:field.max.toLocaleString(),unit:t(field.unit)})}</small></label>
    <div className={`runtime-number ${field.stepper?'is-stepper':''} ${valid?'':'is-invalid'}`}>
      {field.stepper&&<button type="button" title={t('减少{label}',{label:t(field.label)})} aria-label={t('减少{label}',{label:t(field.label)})} disabled={Number(value)<=field.min} onClick={()=>change(-1)}><span aria-hidden="true">−</span></button>}
      <input id={id} type="number" inputMode={field.factor?'decimal':'numeric'} aria-label={t(field.label)} aria-describedby={id+'-hint'} aria-invalid={!valid} min={field.min} max={field.max} step={step} value={value} onChange={event=>onChange(event.target.value)}/>
      {!field.stepper&&<span className="runtime-unit" aria-hidden="true">{t(field.unit)}</span>}
      {field.stepper&&<button type="button" title={t('增加{label}',{label:t(field.label)})} aria-label={t('增加{label}',{label:t(field.label)})} disabled={Number(value)>=field.max} onClick={()=>change(1)}><span aria-hidden="true">+</span></button>}
    </div>
  </div>;
}
function RuntimeGroup({title,children,wide=false}:{title:string;children:ReactNode;wide?:boolean}){
  return <section className={`runtime-group ${wide?'runtime-group-wide':''}`} aria-label={title}><h3>{title}</h3><div className="runtime-group-fields">{children}</div></section>;
}
export function RuntimeSettings({settings,onNotify}:{settings?:Values;onNotify:(text:string)=>void}){
  const {t}=useI18n();
  const [saved,setSaved]=useState<Values>(()=>({...DEFAULT_RUNTIME,...settings})),[draft,setDraft]=useState(()=>runtimeDraft({...DEFAULT_RUNTIME,...settings})),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const checkpointId=useId(),values=runtimeDraftValues(draft),dirty=JSON.stringify(draft)!==JSON.stringify(runtimeDraft(saved));
  const update=(key:RuntimeNumberKey,value:string)=>{setError('');setDraft(current=>({...current,numbers:{...current.numbers,[key]:value}}));};
  const number=(key:RuntimeNumberKey)=><RuntimeNumber key={key} field={RUNTIME_FIELDS.find(field=>field.key===key)!} value={draft.numbers[key]} onChange={value=>update(key,value)}/>;
  return <form className="runtime-settings" onSubmit={async event=>{
    event.preventDefault();if(!values||saving||!dirty)return;setSaving(true);setError('');
    try{await window.aelion.saveRuntimeSettings(values);setSaved(values);setDraft(runtimeDraft(values));onNotify(t('运行设置已保存'));}
    catch(error){setError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}
    finally{setSaving(false);}
  }}>
    <p className="runtime-intro">{t('调整任务的执行边界与响应节奏。')}</p>
    <fieldset className="runtime-fields" disabled={saving}><legend className="runtime-sr-only">{t('运行设置')}</legend>
      <div className="runtime-columns">
        <RuntimeGroup title={t('每次任务')}>{number('maxTurns')}{number('maxMinutes')}{number('maxTokens')}</RuntimeGroup>
        <RuntimeGroup title={t('模型与读取')}>{number('requestTimeoutMs')}{number('modelRetries')}{number('maxOutputTokens')}{number('parallelReads')}</RuntimeGroup>
      </div>
      <RuntimeGroup title={t('恢复')} wide><div className="runtime-field runtime-checkpoint"><label htmlFor={checkpointId} className="runtime-field-copy"><span>{t('文件恢复点')}</span><small>{t('修改前保留一份文件版本')}</small></label><button id={checkpointId} type="button" className="runtime-switch" role="switch" aria-label={t('文件修改前保留检查点')} aria-checked={draft.fileCheckpoints} onClick={()=>{setError('');setDraft(value=>({...value,fileCheckpoints:!value.fileCheckpoints}));}}><span/></button></div></RuntimeGroup>
    </fieldset>
    <footer className="runtime-actions"><button type="button" className="runtime-reset" disabled={saving} onClick={()=>{setError('');setDraft(runtimeDraft(DEFAULT_RUNTIME));}}>{t('恢复默认')}</button><span className={`runtime-save-state ${error?'is-error':''}`} role="status">{error||(!values?t('请检查输入的数值'):dirty?t('有未保存的更改'):'')}</span><button type="submit" className="runtime-save" disabled={!dirty||!values||saving}>{saving?t('保存中…'):t('保存更改')}</button></footer>
  </form>;
}
