import {groupReplyContent} from '../../src/message-envelope';
import type {Store} from './store';
import type {GroupRoom} from '../../src/group-types';
import {messageReply} from '../../src/message-replies';
import {isPrivatePeerOrigin} from '../../src/peer-types';

function replyId(value:unknown){
  if(value===undefined)return;
  if(typeof value!=='string'||!value||value.length>160)throw Error('引用消息无效，请重新选择');
  return value;
}
export function resolveChatReply(store:Store,botId:string,value:unknown){
  const id=replyId(value);if(!id)return;
  const target=store.data.messages.find(message=>message.id===id&&message.botId===botId&&!message.reaction&&['user','assistant'].includes(message.role)&&!['running','cancelled'].includes(message.status||'done')&&message.presentation!=='error'&&(message.content||message.attachments?.length));
  const run=target?.runId?store.data.runs.find(run=>run.id===target.runId):undefined;
  if(!target||target.audience!=='user'&&(isPrivatePeerOrigin(run?.peerOrigin)||run?.groupOrigin&&!run.groupTask))throw Error('只能回复当前聊天中已发送的消息');
  return messageReply(target,target.role==='user'?'你':store.bot(botId).name,target.role==='user'?'user':botId);
}
export function resolveGroupReply(room:GroupRoom,value:unknown){
  const id=replyId(value);if(!id)return;
  const target=room.messages.find(message=>message.id===id&&['message','progress'].includes(message.kind)&&message.sender.kind!=='system'&&(message.content||message.attachments?.length));
  if(!target)throw Error('只能回复当前群聊中已发送的消息');
  return messageReply({...target,content:groupReplyContent(target.content,target.sender.kind==='bot'?target.sender.id:undefined)},target.sender.name,target.sender.id);
}
