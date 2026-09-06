import {readableContent} from './activity';

const controls=['[群聊静默]','[表情静默]'];
const tags=['<think>','</think>','<thinking>','</thinking>','<analysis>','</analysis>'];
// A partial control token or reasoning delimiter is never user-facing text.
export function streamingReplyText(raw:string){
  const at=raw.lastIndexOf('<');
  if(at>=0&&tags.some(tag=>tag.startsWith(raw.slice(at).toLowerCase())))raw=raw.slice(0,at);
  let text=readableContent(raw);
  if(controls.some(control=>control.startsWith(text)))return '';
  for(const control of controls)text=text.replaceAll(control,'');
  const controlAt=text.lastIndexOf('[');if(controlAt>=0&&controls.some(control=>control.startsWith(text.slice(controlAt))))text=text.slice(0,controlAt);
  return text.replace(/@\{[^}]*$/,'').trim();
}
