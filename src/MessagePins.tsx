import {useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {MessagePin,PinEmoji,PinInput} from './reactions';
import {PIN_EMOJI_CATEGORIES,PIN_EMOJI_BY_VALUE,QUICK_PIN_EMOJIS,searchPinEmojis} from './emoji-catalog';
import {useI18n} from './i18n';
import './message-pins.css';

const errorText=(error:unknown)=>(error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,'');
interface Anchor {left:number;top:number;copyText:string;returnFocus:HTMLElement|null;}

export function MessagePins({messageId,pins,pending,onChoose}:{messageId:string;pins:MessagePin[];pending:boolean;onChoose:(emoji:PinEmoji)=>void}){
  const {t}=useI18n();
  if(!pins.length)return null;
  return <div className="message-pins" role="group" aria-label={t('消息回应')} data-pin-target={messageId}>{[...new Set(pins.map(pin=>pin.emoji))].map(emoji=>{
    const selected=pins.filter(pin=>pin.emoji===emoji);if(!selected.length)return null;const own=selected.some(pin=>pin.actor.id==='user'),names=selected.map(pin=>pin.actor.name).join('、');
    const label=t(PIN_EMOJI_BY_VALUE.get(emoji)?.label||emoji);
    return <button key={emoji} type="button" className={`pin-chip ${own?'own':''}`} aria-pressed={own} aria-label={t('{emoji} {label}，{count} 人：{names}{action}',{emoji,label,count:selected.length,names,action:own?t('，点击撤回'):t('，点击回应')})} title={t('{label} · {names}{action}',{label,names,action:own?t(' · 点击撤回'):''})} disabled={pending} onClick={()=>onChoose(emoji)}><span aria-hidden="true">{emoji}</span>{selected.length>1&&<small aria-hidden="true">{selected.length}</small>}</button>;
  })}</div>;
}

export function MessageActions({messageId,content,pins=[],onPin,onReply,bubbleClassName,children}:{messageId:string;content:string;pins?:MessagePin[];onPin?:(input:PinInput)=>Promise<void>;onReply?:()=>void;bubbleClassName:string;children:ReactNode}){
  const {t}=useI18n();
  const [anchor,setAnchor]=useState<Anchor>(),[expanded,setExpanded]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[category,setCategory]=useState('all'),[focusedEmoji,setFocusedEmoji]=useState('');
  const [hovered,setHovered]=useState(false),[toolbarPosition,setToolbarPosition]=useState({left:0,top:0});
  const toolbar=useRef<HTMLDivElement>(null),hoverTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const showToolbar=()=>{clearTimeout(hoverTimer.current);window.dispatchEvent(new CustomEvent('aelion:message-hover',{detail:messageId}));setHovered(true);};
  const hideToolbar=()=>{clearTimeout(hoverTimer.current);hoverTimer.current=setTimeout(()=>{if(!bubble.current?.contains(document.activeElement)&&!toolbar.current?.contains(document.activeElement))setHovered(false);},140);};
  useEffect(()=>()=>clearTimeout(hoverTimer.current),[]);
  const options=useMemo(()=>searchPinEmojis(query,category),[query,category]);
  const bubble=useRef<HTMLDivElement>(null),menu=useRef<HTMLDivElement>(null),grid=useRef<HTMLDivElement>(null),busy=useRef(false),anchorRef=useRef(anchor);anchorRef.current=anchor;
  useLayoutEffect(()=>{
    if(!hovered||!bubble.current)return;
    const place=()=>{const box=bubble.current!.getBoundingClientRect(),surface=bubble.current!.closest('.messages,.peer-chat-body')?.getBoundingClientRect(),width=(onPin?28:0)+(onReply?28:0)+(onPin&&onReply?4:0),right=Math.min(window.innerWidth-8,surface?.right||window.innerWidth-8);let left=box.right+6,top=box.bottom-28;if(left+width>right){if(box.left-width-6>=(surface?.left||0)+4)left=box.left-width-6;else{left=Math.max(surface?.left||8,box.right-width);top=box.top-31;}}const pins=bubble.current!.nextElementSibling;if(pins?.classList.contains('message-pins'))for(const chip of pins.querySelectorAll('.pin-chip')){const rect=chip.getBoundingClientRect();if(left<rect.right&&left+width>rect.left&&top<rect.bottom&&top+28>rect.top)top=rect.top-32;}
      const bottom=Math.min(window.innerHeight-8,surface?.bottom||window.innerHeight-8);setToolbarPosition({left:Math.max(8,left),top:Math.max(42,surface?surface.top+4:42,Math.min(top,bottom-32))});};
    place();const observer=new ResizeObserver(place);observer.observe(bubble.current);const hide=()=>setHovered(false);const other=(event:Event)=>{if((event as CustomEvent).detail!==messageId)setHovered(false);};window.addEventListener('aelion:message-hover',other);window.addEventListener('scroll',hide,true);window.addEventListener('resize',hide);return()=>{observer.disconnect();window.removeEventListener('aelion:message-hover',other);window.removeEventListener('scroll',hide,true);window.removeEventListener('resize',hide);};
  },[hovered,onPin,onReply,messageId]);
  const dismiss=(restore=false)=>{const previous=anchorRef.current?.returnFocus;setAnchor(undefined);setExpanded(false);if(restore)(previous?.isConnected?previous:bubble.current)?.focus({preventScroll:true});};
  const open=(x?:number,y?:number)=>{
    if(!content.trim())return;const element=bubble.current;if(!element)return;const box=element.getBoundingClientRect(),selection=getSelection();
    const selected=selection?.rangeCount&&element.contains(selection.getRangeAt(0).commonAncestorContainer)?selection.toString():'';
    window.dispatchEvent(new Event('aelion:message-menu-open'));
    setError('');setExpanded(false);setQuery('');setCategory('all');setFocusedEmoji('');setAnchor({left:x??box.left+14,top:y??box.bottom+5,copyText:selected||content,returnFocus:document.activeElement instanceof HTMLElement?document.activeElement:element});
  };
  useLayoutEffect(()=>{
    if(!anchor||!menu.current)return;const box=menu.current.getBoundingClientRect();menu.current.style.left=`${Math.max(8,Math.min(anchor.left,window.innerWidth-box.width-8))}px`;menu.current.style.top=`${Math.max(44,Math.min(anchor.top,window.innerHeight-box.height-8))}px`;
  },[anchor,expanded,query,category]);
  useEffect(()=>{
    if(!anchor)return;menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
    const outside=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node))dismiss();};
    const hide=()=>dismiss();const scroll=(event:Event)=>{if(!menu.current?.contains(event.target as Node))dismiss();};
    document.addEventListener('pointerdown',outside);window.addEventListener('blur',hide);window.addEventListener('resize',hide);window.addEventListener('scroll',scroll,true);window.addEventListener('aelion:message-menu-open',hide);
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('blur',hide);window.removeEventListener('resize',hide);window.removeEventListener('scroll',scroll,true);window.removeEventListener('aelion:message-menu-open',hide);};
  },[anchor]);
  useEffect(()=>{if(expanded)menu.current?.querySelector<HTMLInputElement>('.message-emoji-search input')?.focus({preventScroll:true});},[expanded]);
  useEffect(()=>{setFocusedEmoji('');if(grid.current)grid.current.scrollTop=0;},[query,category]);
  const choose=async(emoji:PinEmoji)=>{
    if(busy.current||!onPin)return;busy.current=true;setPending(true);setError('');dismiss(true);
    try{await onPin({messageId,emoji,remove:pins.some(pin=>pin.emoji===emoji&&pin.actor.id==='user')});}catch(error){setError(errorText(error));}finally{busy.current=false;setPending(false);}
  };
  const copy=async()=>{const text=anchorRef.current?.copyText||content;dismiss(true);try{await navigator.clipboard.writeText(text);}catch(error){setError(errorText(error));}};
  const emojiButton=(emoji:PinEmoji,inGrid=false)=>{const label=t(PIN_EMOJI_BY_VALUE.get(emoji)?.label||emoji),selected=pins.some(pin=>pin.emoji===emoji&&pin.actor.id==='user');return <button key={emoji} type="button" role={expanded?undefined:'menuitemcheckbox'} aria-checked={expanded?undefined:selected} aria-pressed={expanded?selected:undefined} aria-label={`${emoji} ${label}`} title={label} tabIndex={inGrid?(emoji===(focusedEmoji||options[0]?.emoji)?0:-1):undefined} onFocus={inGrid?()=>setFocusedEmoji(emoji):undefined} disabled={pending} onClick={()=>void choose(emoji)}>{emoji}</button>;};
  return <>
    <div ref={bubble} className={`${bubbleClassName} message-context-target`} data-hover-actions={onPin||onReply?'true':undefined} onMouseEnter={showToolbar} onMouseLeave={hideToolbar} onFocusCapture={showToolbar} onBlurCapture={hideToolbar} tabIndex={content?0:undefined} aria-haspopup={content?'menu':undefined} aria-expanded={anchor?true:undefined}
      onContextMenu={event=>{if(!content.trim())return;event.preventDefault();event.stopPropagation();open(event.clientX||undefined,event.clientY||undefined);}}
      onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();event.stopPropagation();open();}}}>{children}</div>
    {onPin&&<MessagePins messageId={messageId} pins={pins} pending={pending} onChoose={emoji=>void choose(emoji)}/>}
    {hovered&&(onPin||onReply)&&createPortal(<div ref={toolbar} className="message-hover-actions" role="group" aria-label={t('消息操作')} style={toolbarPosition} onMouseEnter={showToolbar} onMouseLeave={hideToolbar} onFocusCapture={showToolbar} onBlurCapture={hideToolbar}>
      {onPin&&<button type="button" aria-label={t('添加表情')} title={t('添加表情')} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();open(rect.left,rect.bottom+5);}}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 14s1 3 4 3 4-3 4-3M8 9h.01M16 9h.01" strokeLinecap="round"/></svg></button>}
      {onReply&&<button type="button" aria-label={t('回复消息')} title={t('回复消息')} onClick={()=>{setHovered(false);onReply();}}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5-6 6 6 6M3 11h11a7 7 0 0 1 7 7" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
    </div>,document.body)}
    {error&&<span className="pin-error" role="alert">{error}</span>}
    {anchor&&createPortal(<div ref={menu} className={`message-context-menu ${expanded?'emoji-expanded':''}`} role={expanded?'dialog':'menu'} aria-label={expanded?t('选择表情'):t('消息菜单')} data-message-menu={messageId} style={{left:anchor.left,top:anchor.top}} onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss(true);return;}
      if(event.key==='Tab'){
        event.preventDefault();if(!expanded){dismiss(true);return;}
        const fields=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input,button:not(:disabled)')).filter(element=>element.tabIndex>=0),index=fields.indexOf(document.activeElement as HTMLElement);fields[(index+(event.shiftKey?-1:1)+fields.length)%fields.length]?.focus();return;
      }
      if(event.target instanceof HTMLInputElement){if(event.key==='ArrowDown'){event.preventDefault();grid.current?.querySelector<HTMLButtonElement>('button')?.focus();}return;}
      const inGrid=grid.current?.contains(document.activeElement),buttons=Array.from((inGrid?grid.current!:event.currentTarget).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')),current=buttons.indexOf(document.activeElement as HTMLButtonElement);
      if((event.key==='Enter'||event.key===' ')&&current>=0){event.preventDefault();buttons[current].click();return;}
      const stride=inGrid&&['ArrowDown','ArrowUp'].includes(event.key)?7:1;
      const next=['ArrowRight','ArrowDown'].includes(event.key)?Math.min(buttons.length-1,current+stride):['ArrowLeft','ArrowUp'].includes(event.key)?Math.max(0,current-stride):event.key==='Home'?0:event.key==='End'?buttons.length-1:undefined;
      if(next!==undefined){event.preventDefault();buttons[next]?.focus();buttons[next]?.scrollIntoView({block:'nearest'});}
    }}>
      {onPin&&<><div className="message-emoji-quick" role="group" aria-label={t('常用表情')}>{QUICK_PIN_EMOJIS.map(emoji=>emojiButton(emoji))}<button type="button" className="message-emoji-more" role={expanded?undefined:'menuitem'} aria-label={t('更多表情')} aria-haspopup="dialog" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20.5 13a8.5 8.5 0 1 1-9.5-9.5M8 14s1 3 4 3 4-3 4-3M8 9h.01M14 9h.01M19 2v6M16 5h6" strokeLinecap="round"/></svg></button></div>{expanded&&<div className="message-emoji-picker">
        <label className="message-emoji-search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input type="search" aria-label={t('搜索表情')} placeholder={t('搜索表情')} value={query} onChange={event=>setQuery(event.target.value)}/></label>
        <div className="message-emoji-categories" role="group" aria-label={t('表情分类')}><button type="button" aria-label={t('全部表情')} title={t('全部表情')} aria-pressed={category==='all'&&!query} onClick={()=>{setCategory('all');setQuery('');}}>✦</button>{PIN_EMOJI_CATEGORIES.map(item=><button key={item.id} type="button" aria-label={t(item.name)} title={t(item.name)} aria-pressed={category===item.id&&!query} onClick={()=>{setCategory(item.id);setQuery('');}}>{item.icon}</button>)}</div>
        <div className="message-emoji-label" aria-live="polite">{query?t('搜索结果 · {count}',{count:options.length}):category==='all'?t('全部表情'):t(PIN_EMOJI_CATEGORIES.find(item=>item.id===category)?.name||'')}</div>
        <div ref={grid} className={`message-emoji-grid ${options.length?'':'is-empty'}`} role="group" aria-label={t('表情列表')}>{options.length?options.map(item=>emojiButton(item.emoji,true)):<span className="message-emoji-empty">{t('没有找到表情')}</span>}</div>
      </div>}<div className="message-menu-separator" role="separator"/></>}
      {onReply&&<button type="button" className="message-menu-action" role={expanded?undefined:'menuitem'} onClick={()=>{dismiss();setHovered(false);onReply();}}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5-6 6 6 6M3 11h11a7 7 0 0 1 7 7"/></svg>{t('回复')}</button>}
      <button type="button" className="message-menu-action" role={expanded?undefined:'menuitem'} onClick={()=>void copy()}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="8" y="3" width="12" height="15" rx="2"/><path d="M16 21H5a2 2 0 0 1-2-2V8"/></svg>{t('复制')}</button>
    </div>,document.body)}
  </>;
}
