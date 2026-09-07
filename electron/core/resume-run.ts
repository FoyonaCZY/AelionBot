import type {Store} from './store';
import {contextNeedsChange} from '../../src/context-issue';

export function resumableRun(store:Store,botId:string,runId:string){
  store.bot(botId);const run=store.data.runs.find(run=>run.id===runId&&run.botId===botId);
  if(!run||!['failed','cancelled','interrupted'].includes(run.status)||run.inputUpdated||run.groupUpdated)throw Error('这项任务不能继续，请查看当前任务状态');
  const latest=store.data.runs.filter(item=>item.botId===botId&&store.data.messages.some(message=>message.runId===item.id)).at(-1);
  if(latest&&latest.id!==run.id)throw Error('已有更新的任务，请从最新任务继续');
  if(!store.modelFor(botId).model)throw Error('请先选择模型');
  if(contextNeedsChange(run.contextIssue,store.modelFor(botId)))throw Error('上下文容量仍不足，请先调整并保存模型设置，或发送新的任务范围；重复继续不会释放空间。');
  return run;
}
