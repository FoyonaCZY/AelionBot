import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import type {Bot,BotMention} from './shared';
import {AttachmentList,AttachmentIcon} from './Attachments';
import {ATTACHMENT_LIMITS,type Attachment,type AttachmentScope} from './attachment-types';
import {Avatar,Icon} from './ui';

export interface ComposerDraft {text:string;mentions:BotMention[];attachments?:Attachment[];}
const empty:ComposerDraft={text:'',mentions:[]};
function read(root:Node):ComposerDraft{
  let text='';const mentions:BotMention[]=[];
  const visit=(node:Node)=>{
    if(node.nodeType===Node.TEXT_NODE){text+=node.textContent||'';return;}
    if(node instanceof HTMLElement&&node.dataset.botId){const name=node.dataset.botName||'',start=text.length;text+=`@${name}`;mentions.push({id:node.dataset.botId,name,color:node.dataset.botColor||'#858b95',start,end:text.length});return;}
    if(node instanceof HTMLBRElement){if(!node.dataset.caretPlaceholder)text+='\n';return;}
    if(node instanceof HTMLElement&&['DIV','P'].includes(node.tagName)&&node!==root&&text&&!text.endsWith('\n'))text+='\n';
    node.childNodes.forEach(visit);
  };
  visit(root);return {text,mentions};
}
function selectionOffset(root:HTMLElement){const selection=getSelection();if(!selection?.rangeCount||!root.contains(selection.focusNode))return undefined;const range=document.createRange();range.selectNodeContents(root);range.setEnd(selection.focusNode!,selection.focusOffset);return read(range.cloneContents()).text.length;}
function position(root:HTMLElement,offset:number):[Node,number]{
  let left=offset,found:[Node,number]|undefined;
  const visit=(node:Node)=>{
    if(found)return;
    if(node instanceof HTMLElement&&node.dataset.botId){const length=(node.dataset.botName||'').length+1;if(left<=length){const index=Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode);found=[node.parentNode!,index+(left?1:0)];}else left-=length;return;}
    if(node.nodeType===Node.TEXT_NODE){if(left<=(node.textContent?.length||0))found=[node,left];else left-=node.textContent?.length||0;return;}
    if(node instanceof HTMLBRElement){if(node.dataset.caretPlaceholder)return;if(left<=1){const index=Array.from(node.parentNode!.childNodes).indexOf(node);found=[node.parentNode!,index+(left?1:0)];}else left--;return;}
    node.childNodes.forEach(visit);
  };root.childNodes.forEach(visit);return found||[root,root.childNodes.length];
}
function chip(mention:BotMention){
  const node=document.createElement('span');node.className='bot-mention';node.contentEditable='false';node.dataset.botId=mention.id;node.dataset.botName=mention.name;node.dataset.botColor=mention.color;
  const face=document.createElement('span');face.className='mention-avatar';face.style.backgroundColor=mention.color;face.setAttribute('aria-hidden','true');const name=document.createElement('span');name.textContent=`@${mention.name}`;node.append(face,name);return node;
}
export function BotComposer({bot,bots,draft=empty,running,onChange,onSend,onStop,attachmentScope}:{bot:Pick<Bot,'id'|'name'>;bots:Bot[];draft?:ComposerDraft;running:boolean;attachmentScope?:AttachmentScope;onChange:(draft:ComposerDraft)=>void;onSend:()=>void;onStop:()=>void}){
  const editor=useRef<HTMLDivElement>(null),list=useRef<HTMLDivElement>(null),last=useRef(''),composing=useRef(false),sendRef=useRef(onSend);sendRef.current=onSend;
  const draftRef=useRef(draft),changeRef=useRef(onChange),uploadCount=useRef(0),uploadChain=useRef(Promise.resolve());draftRef.current=draft;changeRef.current=onChange;
  const [uploading,setUploading]=useState(0),[uploadError,setUploadError]=useState(''),[dragging,setDragging]=useState(false);
  const scope:AttachmentScope=attachmentScope||{kind:'bot',id:bot.id},hasContent=Boolean(draft.text.trim()||draft.attachments?.length);
  const update=(next:ComposerDraft)=>{draftRef.current=next;changeRef.current(next);};
  const ingest=(operation:()=>Promise<Attachment[]>)=>{uploadCount.current++;setUploading(uploadCount.current);setUploadError('');uploadChain.current=uploadChain.current.then(async()=>{const added=await operation(),latest=draftRef.current,files=[...new Map([...(latest.attachments||[]),...added].map(file=>[file.id,file])).values()];if(files.length>ATTACHMENT_LIMITS.count)throw Error('每条消息最多附加 10 个文件');if(files.reduce((total,file)=>total+file.size,0)>ATTACHMENT_LIMITS.totalBytes)throw Error('附件总大小不能超过 100 MB');update({...latest,attachments:files});}).catch(error=>setUploadError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''))).finally(()=>{uploadCount.current--;setUploading(uploadCount.current);});};
  const importFiles=(files:File[])=>{if(files.length+(draftRef.current.attachments?.length||0)>ATTACHMENT_LIMITS.count){setUploadError('每条消息最多附加 10 个文件');return;}if(files.some(file=>file.size>ATTACHMENT_LIMITS.fileBytes)){setUploadError('单个附件不能超过 25 MB');return;}ingest(async()=>window.aelion.importAttachments({scope,files:await Promise.all(files.map(async file=>({name:file.name||'粘贴图片.png',bytes:new Uint8Array(await file.arrayBuffer())})))}));};
  const [query,setQuery]=useState<{start:number;end:number;text:string}>(),[active,setActive]=useState(0);const id=useId();
  const options=query?bots.filter(item=>item.id!==bot.id&&`${item.name} ${item.role}`.toLowerCase().includes(query.text.toLowerCase())).slice(0,20):[];
  const refresh=()=>{
    const root=editor.current;if(!root)return;const value=read(root);last.current=JSON.stringify(value);update({...value,attachments:draftRef.current.attachments});
    const caret=selectionOffset(root);if(caret===undefined||composing.current){setQuery(undefined);return;}
    const start=Math.max(value.text.lastIndexOf('@',caret-1),value.text.lastIndexOf('＠',caret-1)),word=value.text.slice(start+1,caret);
    if(start<0||/[\s@＠]/.test(word)||word.length>80||value.text[start]==='@'&&start>0&&/[a-zA-Z0-9_.+-]/.test(value.text[start-1])||value.mentions.some(mention=>start>=mention.start&&start<mention.end)){setQuery(undefined);return;}
    setActive(0);setQuery({start,end:caret,text:word});
  };
  const insert=(text:string)=>{
    const root=editor.current,selection=getSelection();if(!root||!selection?.rangeCount||!root.contains(selection.anchorNode))return;
    const range=selection.getRangeAt(0),atEnd=selectionOffset(root)===read(root).text.length;
    root.querySelectorAll('br[data-caret-placeholder]').forEach(node=>node.remove());range.deleteContents();
    const fragment=document.createDocumentFragment(),parts=text.split('\n');let tail:Text|undefined;
    parts.forEach((part,index)=>{tail=document.createTextNode(part);fragment.append(tail);if(index<parts.length-1)fragment.append(document.createElement('br'));});
    range.insertNode(fragment);
    if(atEnd&&text.endsWith('\n')){const placeholder=document.createElement('br');placeholder.dataset.caretPlaceholder='true';tail!.after(placeholder);range.setStartBefore(placeholder);}else range.setStart(tail!,tail!.length);
    range.collapse(true);selection.removeAllRanges();selection.addRange(range);refresh();
  };
  const choose=(target:Bot)=>{
    const root=editor.current;if(!root||!query)return;root.focus({preventScroll:true});const range=document.createRange();range.setStart(...position(root,query.start));range.setEnd(...position(root,query.end));range.deleteContents();
    const space=document.createTextNode(' ');range.insertNode(space);range.insertNode(chip({id:target.id,name:target.name,color:target.color,start:0,end:0}));range.setStart(space,1);range.collapse(true);const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);refresh();setQuery(undefined);
  };
  useLayoutEffect(()=>{
    const root=editor.current,key=JSON.stringify({text:draft.text,mentions:draft.mentions});if(!root||last.current===key)return;
    const focused=document.activeElement===root,fragment=document.createDocumentFragment();let at=0;
    for(const mention of draft.mentions){if(mention.start<at||draft.text.slice(mention.start,mention.end)!==`@${mention.name}`)continue;fragment.append(document.createTextNode(draft.text.slice(at,mention.start)),chip(mention));at=mention.end;}
    fragment.append(document.createTextNode(draft.text.slice(at)));if(draft.text.endsWith('\n')){const placeholder=document.createElement('br');placeholder.dataset.caretPlaceholder='true';fragment.append(placeholder);}root.replaceChildren(fragment);last.current=key;setQuery(undefined);
    if(focused){const range=document.createRange();range.selectNodeContents(root);range.collapse(false);const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);}
  },[draft]);
  useEffect(()=>{const item=list.current?.children[active] as HTMLElement|undefined;if(item&&list.current){if(item.offsetTop<list.current.scrollTop)list.current.scrollTop=item.offsetTop;else if(item.offsetTop+item.offsetHeight>list.current.scrollTop+list.current.clientHeight)list.current.scrollTop=item.offsetTop+item.offsetHeight-list.current.clientHeight;}},[active]);
  return <div className={`composer mention-composer ${dragging?'is-dragging':''}`} onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';setDragging(true);}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDragging(false);}} onDrop={event=>{event.preventDefault();setDragging(false);const files=Array.from(event.dataTransfer.files);if(files.length)importFiles(files);}}>
    <AttachmentList files={draft.attachments} compact onRemove={id=>update({...draftRef.current,attachments:draftRef.current.attachments?.filter(file=>file.id!==id)})}/>
    {uploading>0&&<div className="composer-uploading" role="status">正在添加附件…</div>}{uploadError&&<div className="composer-attachment-error" role="alert">{uploadError}</div>}
    {query&&<div ref={list} className="mention-picker" role="listbox" id={id} aria-label="选择要联系的 Bot">{options.length?options.map((item,index)=><button key={item.id} id={`${id}-${index}`} role="option" aria-selected={index===active} className={index===active?'active':''} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(item)}><Avatar bot={item} size={30}/><span><strong>{item.name}</strong><small>{item.role||'Bot'}{bots.filter(bot=>bot.name===item.name).length>1?` · ${item.id.slice(0,6)}`:''}</small></span></button>):<div className="mention-empty">没有匹配的 Bot</div>}</div>}
    <div ref={editor} className="composer-editor" role="textbox" aria-label={`给 ${bot.name} 发消息`} aria-multiline="true" aria-autocomplete="list" aria-controls={query?id:undefined} aria-expanded={Boolean(query)} aria-activedescendant={query&&options.length?`${id}-${Math.min(active,options.length-1)}`:undefined} contentEditable suppressContentEditableWarning data-placeholder={`给 ${bot.name} 发消息`} data-empty={!draft.text} spellCheck={false}
      onInput={refresh} onClick={refresh} onBlur={()=>setQuery(undefined)} onCompositionStart={()=>{composing.current=true;setQuery(undefined);}} onCompositionEnd={()=>{composing.current=false;requestAnimationFrame(refresh);}}
      onPaste={event=>{event.preventDefault();const files=Array.from(event.clipboardData.files),text=event.clipboardData.getData('text/plain').slice(0,32000);if(files.length){importFiles(files);return;}if(text&&!/^(?:[a-z]:[\\/]|\\\\|file:)/i.test(text)){insert(text);return;}const selection=getSelection(),range=selection?.rangeCount?selection.getRangeAt(0).cloneRange():undefined;ingest(async()=>{const files=await window.aelion.pasteAttachments(scope);if(!files.length&&text&&range&&editor.current?.contains(range.commonAncestorContainer)){const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);insert(text);}return files;});}} onDrop={event=>event.preventDefault()}
      onKeyDown={event=>{
        if(composing.current||event.nativeEvent.isComposing)return;
        if(query){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setQuery(undefined);return;}if(options.length&&(event.key==='ArrowDown'||event.key==='ArrowUp')){event.preventDefault();setActive(value=>(value+(event.key==='ArrowDown'?1:-1)+options.length)%options.length);return;}if(options.length&&(event.key==='Enter'||event.key==='Tab')){event.preventDefault();choose(options[Math.min(active,options.length-1)]);return;}}
        if(event.key==='Enter'){event.preventDefault();if(event.shiftKey)insert('\n');else if(hasContent&&!uploadCount.current)sendRef.current();}
      }} onKeyUp={event=>{if(['ArrowLeft','ArrowRight','Home','End','@','＠'].includes(event.key))refresh();}}/>
    <div className="composer-bottom"><button type="button" className="icon-button composer-attach" aria-label="添加附件" onClick={()=>ingest(()=>window.aelion.pickAttachments(scope))}><AttachmentIcon/></button>{running&&hasContent&&<button className="icon-button" aria-label="停止任务" onClick={onStop}><span className="stop-square"/></button>}{running&&!hasContent?<button className="send-button" aria-label="停止任务" onClick={onStop}><span className="stop-square"/></button>:<button className="send-button" aria-label="发送消息" disabled={!hasContent||uploading>0} onClick={onSend}><Icon name="send"/></button>}</div>
  </div>;
}
