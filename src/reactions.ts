import {PIN_EMOJI_OPTIONS,PIN_EMOJI_BY_VALUE} from './emoji-catalog';
export const PIN_EMOJIS=PIN_EMOJI_OPTIONS.map(option=>option.emoji);
export type PinEmoji=typeof PIN_EMOJIS[number];
export interface PinActor {id:string;name:string;kind:'user'|'bot';color?:string;}
export interface MessagePin {emoji:PinEmoji;actor:PinActor;time:string;}
export interface PinEvent {messageId:string;emoji:PinEmoji;removed:boolean;}
export interface PinInput {messageId:string;emoji:PinEmoji;remove?:boolean;}
export function validPin(input:PinInput){
  if(!input||typeof input.messageId!=='string'||!input.messageId||input.messageId.length>100||!PIN_EMOJI_BY_VALUE.has(input.emoji)||input.remove!==undefined&&typeof input.remove!=='boolean')throw new Error('无效的 emoji 回应');
}
export function updatePins(target:{pins?:MessagePin[]},actor:PinActor,input:PinInput){
  validPin(input);const pins=target.pins||[],exists=pins.some(pin=>pin.actor.id===actor.id&&pin.emoji===input.emoji);
  if(exists===!input.remove)return false;
  target.pins=input.remove?pins.filter(pin=>pin.actor.id!==actor.id||pin.emoji!==input.emoji):[...pins,{emoji:input.emoji,actor,time:new Date().toISOString()}];
  return true;
}
export const pinDescription=(actor:PinActor,input:PinInput,content:string)=>`${actor.name}${input.remove?'撤回了':'回应了'} ${input.emoji} · ${content.replace(/\s+/g,' ').slice(0,160)}`;
