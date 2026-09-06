import type {Store} from './store';
import type {BotMention,ChatMessage} from '../../src/shared';
import {attachmentSummary} from '../../src/attachment-types';

export function validateChatInput(store:Store,botId:string,input:string,value?:BotMention[],hasAttachments=false){
  store.bot(botId);if(typeof input!=='string'||!input.trim()&&!hasAttachments||input.length>32000)throw new Error('消息为空或过长');
  if(value===undefined)return [];if(!Array.isArray(value)||value.length>12)throw new Error('提及的 Bot 无效');let end=0;
  return value.map(mention=>{
    if(!mention||typeof mention.id!=='string'||typeof mention.name!=='string'||!Number.isInteger(mention.start)||!Number.isInteger(mention.end)||mention.start<end||mention.end<=mention.start||mention.end>input.length||input.slice(mention.start,mention.end)!==`@${mention.name}`)throw new Error('Bot 提及的位置已变化，请重新选择');
    const target=store.bot(mention.id);if(target.id===botId)throw new Error('请选择其他 Bot');end=mention.end;return {id:target.id,name:mention.name,color:target.color,start:mention.start,end:mention.end};
  });
}
export function chatInputText(message:ChatMessage){
  if(message.scheduled)return `定时任务触发：${message.scheduled.title}（计划时间 ${message.scheduled.scheduledFor}）。这是已保存计划的本次执行，请直接完成任务并在当前会话回复，不要重新创建同一计划。原有工具权限仍然适用。\n任务内容：${message.content}`;
  if(message.reaction)return `用户通过 emoji 发言（不代表新增任务或操作授权）：${JSON.stringify({eventId:message.id,...message.reaction,content:message.content})}`;
  return message.content||(message.attachments?.length?`用户发送了 ${message.attachments.length} 个附件。`:'');
}
