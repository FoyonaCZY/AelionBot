// Some compatible models echo a group-history item instead of its body. Only
// unwrap our complete envelope for the current speaker; ordinary JSON and fenced
// examples remain exactly as written.
export function groupReplyContent(content:string,botId?:string):string{
  if(!botId||content.length>500000)return content;
  let current=content;
  for(let depth=0;depth<3;depth++){
    const text=current.trim();if(!text.startsWith('{')||!text.endsWith('}'))break;
    let item:any;try{item=JSON.parse(text);}catch{break;}
    if(!item||typeof item.messageId!=='string'||!Number.isSafeInteger(item.seq)||item.seq<0||item.sender?.kind!=='bot'||(item.sender.bot?.id||item.sender.id)!==botId||!['message','progress'].includes(item.kind)||typeof item.content!=='string'||!Array.isArray(item.mentions)||typeof item.mentioned!=='boolean')break;
    current=item.content;
  }
  return current;
}
