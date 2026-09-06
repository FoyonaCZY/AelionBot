import type {WireMessage} from './shared';
export function visibleImages(messages:WireMessage[]){
  const all=messages.flatMap(message=>message.images||[]),screens=all.filter(image=>!image.attachmentId).slice(-2),files=new Map<string,typeof all[number]>();
  for(const image of all)if(image.attachmentId){files.delete(image.id);files.set(image.id,image);}
  return [...screens,...[...files.values()].slice(-10)];
}
