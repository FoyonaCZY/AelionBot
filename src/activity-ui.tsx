import {useEffect,useState} from 'react';
import Markdown from 'react-markdown';
import type {ChatMessage,RunRecord,StreamingReply as Reply} from './shared';
import {StreamingReply} from './StreamingReply';
import {friendlyError,readableContent,runPresentation,toolDisplay,toolOperation} from './activity';
import {ToolDetails,ErrorDetails} from './tool-details';
import {Icon,Message,ScreenImage} from './ui';
import './activity.css';

function StatusMark({state}:{state:'running'|'done'|'failed'|'cancelled'|'recovered'}){
  return <span className={`activity-mark ${state}`} aria-hidden="true">{state==='running'?<span className="activity-spinner"/>:<Icon name={state==='done'?'check':state==='failed'?'alert':state==='recovered'?'restart':'pause'} size={14}/>}</span>;
}

function ToolStep({message,recovered,onScreen}:{message:ChatMessage;recovered:boolean;onScreen:(url:string)=>void}){
  const [open,setOpen]=useState(false);
  const display=toolDisplay(message),operation=toolOperation(message.tool);
  const state=message.status==='running'?'running':message.status==='failed'?recovered?'recovered':'failed':message.status==='cancelled'?'cancelled':'done';
  const labels={running:'进行中',done:'完成',failed:'遇到问题',cancelled:'已停止',recovered:'已处理'};
  return <li className="activity-step-wrap"><details className={`activity-step ${state}`} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary><span className="activity-step-icon"><Icon name={operation.icon} size={15}/></span><span className="activity-step-copy"><span>{display.label}</span>{display.detail&&<small title={display.detail}>{display.detail}</small>}</span><span className="activity-step-status">{labels[state]}</span><StatusMark state={state}/><Icon name="down" size={12}/></summary>
    {open&&<div className="activity-step-body">{message.status==='failed'&&recovered&&<p className="activity-step-error">此问题已通过后续操作处理，详见执行记录。</p>}{message.screenshotId&&<ScreenImage id={message.screenshotId} onOpen={onScreen}/>}<ToolDetails message={message}/></div>}
  </details></li>;
}

function elapsed(start:string,end?:string){const seconds=Math.max(0,Math.floor(((end?Date.parse(end):Date.now())-Date.parse(start))/1000));if(!Number.isFinite(seconds)||seconds<1)return '';return seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分${seconds%60?` ${seconds%60} 秒`:''}`;}

export function RunMessage({messages,allMessages=messages,isLast=true,run,stream,latest,canContinue,waiting,reviewing=false,onContinue,onSettings,onScreen}:{messages:ChatMessage[];allMessages?:ChatMessage[];isLast?:boolean;run?:RunRecord;stream?:Reply;latest:boolean;canContinue:boolean;waiting?:'host_permission'|'vm_takeover';reviewing?:boolean;onContinue:()=>void;onSettings:(tab:'model'|'computer'|'mcp')=>void;onScreen:(url:string)=>void}){
  const view=runPresentation(messages,run);
  const [open,setOpen]=useState(false),[,tick]=useState(0);
  useEffect(()=>{if(!isLast||view.status!=='running'||waiting&&!reviewing)return;const timer=setInterval(()=>tick(value=>value+1),1000);return()=>clearInterval(timer);},[isLast,view.status,waiting,reviewing]);
  const running=isLast&&view.status==='running',failed=isLast&&['failed','interrupted'].includes(view.status),cancelled=isLast&&view.status==='cancelled';
  const allTools=allMessages.filter(message=>message.role==='tool'),recovered=(message:ChatMessage)=>Boolean(message.executionResolved);
  const segmentFailed=!isLast&&view.tools.some(message=>message.status==='failed'&&!recovered(message));
  const notice=friendlyError(view.error);
  const hasActivity=running&&!stream||view.tools.length>0||view.notes.length>0||failed||cancelled;
  const current=view.current;
  const title=!isLast?'执行记录':running?(reviewing?'默认模型正在审核操作':waiting==='host_permission'?'等待你的本机操作许可':waiting==='vm_takeover'?'等待人工接管':current?toolOperation(current.tool).active:view.tools.length?'正在整理结果':'正在处理'):failed?(latest?'执行已暂停':notice.title):cancelled?(run?.inputUpdated?'已接收新的输入':run?.groupUpdated?'已接收新的群消息':'已停止'):'执行完成';
  const notes=view.notes.filter((message,index,list)=>!list.slice(0,index).some(item=>item.content===message.content));
  const duration=isLast?elapsed(run?.startedAt||messages[0]?.time,run?.endedAt||(!running?messages.at(-1)?.time:undefined)):'';
  const onlyPins=!running&&!failed&&!cancelled&&messages.some(message=>message.tool==='chat_pin'||message.tool==='group_pin')&&messages.every(message=>message.reaction||message.tool==='chat_pin'||message.tool==='group_pin'||message.role==='assistant'&&!message.content);
  if(onlyPins||run?.inputUpdated&&!view.tools.length)return null;
  return <div className="run-message" data-run-id={run?.id||messages[0]?.runId} data-run-segment={messages[0]?.id} data-run-terminal={isLast}>
    {isLast&&!hasActivity&&allTools.length>0&&view.status==='completed'&&<div className="run-completion"><StatusMark state="done"/><span>执行完成</span><span className="activity-meta">{allTools.length} 个步骤{duration&&<span>{duration}</span>}</span></div>}
    {hasActivity&&<details className={`run-activity ${running?'is-running':''} ${failed?'is-failed':''}`} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
      <summary><StatusMark state={reviewing?'running':waiting?'cancelled':running?'running':failed||segmentFailed?'failed':cancelled?'cancelled':'done'}/><span className="activity-heading" role={running?'status':undefined} aria-live={running?'polite':undefined}>{title}</span><span className="activity-meta">{view.tools.length>0&&`${view.tools.length} 个步骤`}{duration&&<span>{duration}</span>}</span><Icon name="down" size={13}/></summary>
      {open&&(view.tools.length>0||notes.length>0||failed)&&<div className="activity-content">{view.tools.length>0&&<ol className="activity-steps">{view.tools.map((message,index)=><ToolStep key={message.id} message={message} recovered={recovered(message)} onScreen={onScreen}/>)}</ol>}{notes.length>0&&<details className="activity-notes"><summary>过程说明 <span>{notes.length}</span><Icon name="down" size={12}/></summary><div>{notes.map(message=><div className="markdown" key={message.id}><Markdown>{message.content.startsWith('执行检查发现未解决')?'发现校验问题，继续检查并修正。':readableContent(message.content)}</Markdown></div>)}</div></details>}{failed&&!latest&&<p className="activity-history-note">{notice.description}</p>}{failed&&<details className="activity-diagnostics"><summary>错误详情</summary><ErrorDetails error={view.error}/></details>}</div>}
    </details>}
    {failed&&latest&&<div className="run-notice" role="status"><span className="run-notice-icon"><Icon name="alert" size={18}/></span><div><strong>{notice.title}</strong><p>{notice.description}</p>{canContinue&&<div className="run-notice-actions"><button onClick={onContinue}>继续处理<Icon name="arrow" size={13}/></button>{notice.settings&&<button onClick={()=>onSettings(notice.settings!)}>检查设置</button>}</div>}</div></div>}
    {cancelled&&latest&&!run?.groupUpdated&&!run?.inputUpdated&&<div className="run-stopped"><p>{view.error?.startsWith('用户拒绝')||view.error?.startsWith('用户取消')?view.error:'已停止，完成的操作和文件仍然保留。'}</p>{canContinue&&<button onClick={onContinue}>继续处理<Icon name="arrow" size={13}/></button>}</div>}
    {stream&&running&&<StreamingReply reply={stream}/>}
    {isLast&&view.final&&<Message message={view.final} allowPins={!run?.groupOrigin}/>}
  </div>;
}
