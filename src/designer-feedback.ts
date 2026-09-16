import {readableContent} from './activity';
import type {ChatMessage,RunRecord,StreamingReply} from './shared';
export function designFailureText(error:string,en=false){
 if(/timeout|timed out|超时/i.test(error))return {title:en?'Model response timed out':'模型响应超时',detail:en?'The response did not finish within the configured time limit. Existing files and completed steps are retained. You can continue this task.':'模型未在设置的时限内完成响应。已有文件和已完成步骤会保留，可以继续当前任务。'};
 if(/工作电脑(?:桌面)?尚未就绪|请先启动工作电脑/.test(error))return {title:en?'Work computer is not ready':'工作电脑尚未就绪',detail:en?'Start the computer, then continue from the saved design task.':'启动工作电脑后，可以从已保存的设计任务继续。'};
 if(/abort|cancel|停止|取消/i.test(error))return {title:en?'Task stopped':'任务已停止',detail:en?'Completed steps and existing files are retained.':'已完成步骤和现有文件会保留。'};
 return {title:en?'The task needs attention':'任务需要处理',detail:error};
}
/** Legacy runs stored the same failure in both an assistant bubble and an event. */
export function designConversationMessages(messages:ChatMessage[],runs:RunRecord[],botId:string,taskId:string,runIds:string[]){
 const ids=new Set(runIds),errors=new Set(runs.filter(r=>r.botId===botId&&(r.designSessionId===taskId||ids.has(r.id))).flatMap(r=>r.error?[r.error]:[]));
 return messages.filter(m=>m.botId===botId&&(m.designSessionId===taskId||ids.has(m.runId||''))&&m.role!=='tool'&&m.presentation!=='error'&&(m.role!=='assistant'||Boolean(readableContent(m.content))||m.status==='running'||Boolean(m.attachments?.length))&&!((m.role==='event'||m.status==='failed'||m.status==='cancelled')&&errors.has(m.content)));
}

/** A stream updates the same message slot; it never becomes a progress-card caption. */
export function designMessageTimeline(messages:ChatMessage[],streams:StreamingReply[]){
 const live=new Map(streams.map(s=>[s.id,s])),items=messages.map(message=>{const stream=live.get(message.id);live.delete(message.id);return {message:stream?{...message,content:stream.content,status:'running' as const}:message,streaming:Boolean(stream)};});
 for(const stream of live.values())items.push({message:{id:stream.id,botId:stream.botId,runId:stream.runId,time:stream.time,role:'assistant',content:stream.content,status:'running'},streaming:true});
 return items.filter(({message})=>message.role!=='assistant'||Boolean(readableContent(message.content))||Boolean(message.attachments?.length));
}
