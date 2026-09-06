import {useState} from 'react';
import {DEFAULT_RUNTIME,type RuntimeSettings as Values} from './runtime-types';
import {SettingsSection} from './SettingsWindow';
export function RuntimeSettings({settings,onNotify}:{settings?:Values;onNotify:(text:string)=>void}){
 const [value,setValue]=useState({...DEFAULT_RUNTIME,...settings}),[saving,setSaving]=useState(false);
 const fields:Array<[keyof Omit<Values,'fileCheckpoints'>,string,number,number]>=[['maxTurns','每次最多执行轮数（0 表示不限轮数）',0,10000],['maxMinutes','每次最长执行时间（分钟）',1,1440],['maxTokens','每次模型用量上限（Token）',10000,10000000],['modelRetries','模型请求重试次数',0,5],['requestTimeoutMs','单次模型请求超时（毫秒）',1000,600000],['maxOutputTokens','单次输出上限（Token）',256,65536],['parallelReads','并行读取数量',1,8],['progressSeconds','进度汇报最短间隔（秒）',15,600]];
 return <SettingsSection title="执行与恢复"><div className="settings-card">{fields.map(([key,label,min,max])=><label className="settings-row" key={key}><span>{label}</span><input type="number" aria-label={label} min={min} max={max} value={value[key]} onChange={e=>setValue({...value,[key]:Number(e.target.value)})}/></label>)}<label className="settings-row"><span>文件修改前保留检查点</span><input type="checkbox" checked={value.fileCheckpoints} onChange={e=>setValue({...value,fileCheckpoints:e.target.checked})}/></label></div><div className="settings-actions"><button className="primary-button" disabled={saving} onClick={async()=>{setSaving(true);try{await window.aelion.saveRuntimeSettings(value);onNotify('运行设置已保存');}catch(e){onNotify((e as Error).message);}finally{setSaving(false);}}}>保存</button></div></SettingsSection>;
}
