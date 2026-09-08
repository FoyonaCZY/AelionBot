import {readableContent} from './activity';
export interface TimedMessage {id:string;time:string;content?:string;role?:string;kind?:string;status?:string;reaction?:unknown;attachments?:unknown[];}
const dateKey=(date:Date)=>`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
export function conversationTimeLabels(messages:readonly TimedMessage[],now=new Date()){
  const labels=new Map<string,string>();let previous:Date|undefined;
  for(const message of messages){
    if(message.reaction||message.role&& !['user','assistant'].includes(message.role)||message.kind&&!['message','progress'].includes(message.kind)||['running','cancelled'].includes(message.status||'')||!readableContent(message.content||'')&&!message.attachments?.length)continue;
    const date=new Date(message.time);if(!Number.isFinite(date.getTime()))continue;
    if(!previous||dateKey(date)!==dateKey(previous)||date.getTime()-previous.getTime()>=15*60*1000)labels.set(message.id,formatConversationTime(message.time,now));
    previous=date;
  }
  return labels;
}
export function formatConversationTime(value:string,now=new Date()){
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
  const clock=`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  if(dateKey(date)===dateKey(now))return clock;
  const yesterday=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1);
  if(dateKey(date)===dateKey(yesterday))return `昨天 ${clock}`;
  return `${date.getFullYear()===now.getFullYear()?'':date.getFullYear()+'年'}${date.getMonth()+1}月${date.getDate()}日 ${clock}`;
}
