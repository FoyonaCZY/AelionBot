import {useEffect,useState} from 'react';
import type {ChatMessage,RunRecord} from './shared';
import type {DesignSession} from './designer-types';
import {toolOperation} from './activity';
import {liveBotProgress,waitingExplanation} from './live-bot-progress';
import {useI18n} from './i18n';
import {Icon} from './ui';
const designLabels:Record<string,[string,string]>={design_tasks:['查看设计任务','Review design tasks'],design_start:['创建设计任务','Create design task'],design_use:['读取任务状态','Read task state'],design_spec:['保存设计约定','Save design direction'],design_resource:['读取设计资料','Read design resources'],design_check:['检查实际画面','Inspect rendered output'],design_publish:['整理交付文件','Prepare deliverables'],design_deck:['生成演示文稿','Build the deck'],design_file_create:['写入设计文件','Write a design file'],design_image:['生成插图','Generate an illustration'],design_export_pdf:['导出 PDF','Export PDF'],design_plugin:['读取设计插件','Read a design plugin']};
export function designOperationLabel(tool:string,en=false){return designLabels[tool]?.[en?1:0]||toolOperation(tool).label;}
export function designRecentOperations(messages:ChatMessage[],run:RunRecord){return messages.filter(m=>m.botId===run.botId&&m.runId===run.id&&m.role==='tool'&&m.status==='done'&&(!m.executionId||!run.executions?.some(e=>e.id===m.executionId&&e.status!=='succeeded'))).slice(-3);}
export function DesignerProgress({task,run,messages,waiting,reviewing=false}:{task:DesignSession;run:RunRecord;messages:ChatMessage[];waiting?:'host_permission'|'vm_takeover'|'user_input';reviewing?:boolean}){
 const {language}=useI18n(),en=language==='en',[now,setNow]=useState(Date.now),[expanded,setExpanded]=useState(false);
 useEffect(()=>{setExpanded(false);setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[run.id]);
 const scoped=messages.filter(m=>m.botId===run.botId&&m.runId===run.id),step=liveBotProgress(scoped,run,waiting,reviewing),current=[...scoped].reverse().find(m=>m.role==='tool'&&m.status==='running'),recent=designRecentOperations(scoped,run);
 const seconds=Math.max(0,Math.floor((now-Date.parse(run.startedAt))/1000)),elapsed=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
 const fallback=task.stage==='delivery'?(en?'Preparing your draft':'正在整理初版'):task.stage==='verify'?(en?'Checking the files':'正在核对文件'):(en?'Preparing the next step':'正在准备下一步');
 const label=waiting||step?.retry?step?.label:current?(en?'In progress: ':'正在')+designOperationLabel(current.tool||'',en):run.modelRequest?.phase==='streaming'?(step?.label||(en?'Creating your draft':'正在生成内容')):fallback;
 const note=step&&(waitingExplanation(step,now)||(waiting||step.retry?step.description:undefined));
 return <section className="designer-activity" aria-label={en?'Task progress':'任务进度'}><div className="designer-activity-line"><div className="designer-activity-copy"><div role="status" aria-live="polite"><strong>{label||fallback}</strong>{note&&<p>{note}</p>}</div><div className="designer-activity-meta"><time aria-label={en?'Elapsed time':'已用时间'}>{elapsed}</time>{recent.length>0&&<><span aria-hidden="true">·</span><button type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{en?'Activity':'查看进展'}<Icon name="down" size={11}/></button></>}</div></div><div className="studio-working-collage" aria-hidden="true"><i/><i/><i/></div></div>{expanded&&<ol className="designer-activity-history">{recent.map(m=><li key={m.id}><span className="designer-activity-pin" aria-hidden="true"/>{designOperationLabel(m.tool||'',en)}</li>)}</ol>}</section>;
}
