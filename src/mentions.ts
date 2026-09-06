import {fromMarkdown} from 'mdast-util-from-markdown';
import type {BotIdentity,BotMention} from './peer-types';

interface Range {start:number;end:number;}
interface MarkdownNode {type:string;position?:{start:{offset?:number};end:{offset?:number}};children?:MarkdownNode[];}
function literalRanges(content:string):Range[]{
  const ranges:Range[]=[];
  const visit=(node:MarkdownNode)=>{
    if(['code','inlineCode','html','link','linkReference','image','imageReference','definition'].includes(node.type)){
      if(typeof node.position?.start.offset==='number'&&typeof node.position?.end.offset==='number')ranges.push({start:node.position.start.offset,end:node.position.end.offset});return;
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(content));
  for(const match of content.matchAll(/(?:https?:\/\/|mailto:)[^\s<>]+/g))ranges.push({start:match.index!,end:match.index!+match[0].length});
  return ranges;
}
function escaped(content:string,index:number){let slashes=0;while(index>0&&content[--index]==='\\')slashes++;return slashes%2===1;}
export function validMentions(content:string,mentions:BotMention[]=[]){
  let end=0;return mentions.filter(mention=>{
    if(!mention||!Number.isInteger(mention.start)||!Number.isInteger(mention.end)||mention.start<end||mention.end<=mention.start||mention.end>content.length||content.slice(mention.start,mention.end)!==`@${mention.name}`)return false;
    end=mention.end;return true;
  });
}

/** Bot replies can address a unique @name, or use @{id} for an exact identity. */
export function botMentions(input:string,members:BotIdentity[],senderId?:string,strict=true):{content:string;mentions:BotMention[]}{
  if(!/[@＠]/.test(input))return {content:input,mentions:[]};
  const ranges=literalRanges(input),inside=(start:number,end:number)=>ranges.some(range=>start<range.end&&end>range.start);
  const names=[...new Set(members.map(member=>member.name))].filter(Boolean).sort((a,b)=>b.length-a.length);
  let content='',at=0;const mentions:BotMention[]=[];
  while(at<input.length){
    if(input[at]!=='@'&&input[at]!=='＠'||escaped(input,at)||/[a-zA-Z0-9_.+\-]/.test(input[at-1]||'')){content+=input[at++];continue;}
    const explicit=/^@\{([^{}\s]+)\}/.exec(input.slice(at));
    let target:BotIdentity|undefined,length=0;
    if(explicit&&!inside(at,at+explicit[0].length)){
      target=members.find(member=>member.id===explicit[1]&&member.id!==senderId);length=explicit[0].length;
      if(!target&&strict)throw new Error('提及的 Bot 不在当前群中或是你自己；请使用当前群成员的准确 ID');
    }else{
      const name=names.find(name=>input.startsWith(name,at+1)&&!/^[\p{L}\p{N}_]|^\.[a-zA-Z]/u.test(input.slice(at+1+name.length))&&!inside(at,at+1+name.length));
      if(name){const candidates=members.filter(member=>member.name===name);length=name.length+1;
        if(candidates.length>1&&strict)throw new Error(`群里有同名的「${name}」，请用 @{Bot ID} 明确选择成员`);
        if(candidates.length===1&&candidates[0].id!==senderId)target=candidates[0];
      }
    }
    if(target){const start=content.length;content+=`@${target.name}`;mentions.push({...target,start,end:content.length});at+=length;}
    else if(length){content+=input.slice(at,at+length);at+=length;}else content+=input[at++];
  }
  return {content,mentions};
}

export function mentionMarkdown(content:string,mentions:BotMention[]){
  const ranges=literalRanges(content),valid=validMentions(content,mentions).filter(mention=>!ranges.some(range=>mention.start>=range.start&&mention.end<=range.end));
  let nonce='aelion-mention';while(content.includes(nonce))nonce+='x';
  const links=new Map<string,BotMention>();let markdown='',at=0;
  valid.forEach((mention,index)=>{const href=`${nonce}:${index}`;links.set(href,mention);markdown+=content.slice(at,mention.start)+`[${`@${mention.name}`.replace(/[\\`*_[\]<>]/g,'\\$&')}](${href})`;at=mention.end;});
  return {markdown:markdown+content.slice(at),links};
}
