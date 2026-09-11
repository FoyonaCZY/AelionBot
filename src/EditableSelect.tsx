import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {useI18n} from './i18n';
import './editable-select.css';

export function EditableSelect({value,onChange,options,label,placeholder,disabled=false,maxLength=256}:{value:string;onChange:(value:string)=>void;options:string[];label:string;placeholder?:string;disabled?:boolean;maxLength?:number}){
  const {t}=useI18n();
  const id=useId(),root=useRef<HTMLDivElement>(null),field=useRef<HTMLInputElement>(null),[open,setOpen]=useState(false),[active,setActive]=useState(-1),[all,setAll]=useState(false),[position,setPosition]=useState({left:0,top:0,width:0,maxHeight:240});
  const choices=[...new Set(options)].filter(option=>all||option.toLowerCase().includes(value.toLowerCase())).slice(0,100);
  useEffect(()=>{setActive(-1);},[value]);
  useEffect(()=>{if(open&&active>=0)document.getElementById(`${id}-${active}`)?.scrollIntoView({block:'nearest'});},[open,active,id]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{const box=root.current!.getBoundingClientRect(),below=innerHeight-box.bottom-12,height=Math.min(260,Math.max(below,box.top-12));setPosition({left:Math.max(8,Math.min(box.left,innerWidth-box.width-8)),top:below>=160?box.bottom+5:Math.max(8,box.top-Math.min(height,choices.length*36+12)-5),width:box.width,maxHeight:height});};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open,choices.length]);
  const choose=(choice:string)=>{onChange(choice);setOpen(false);setActive(-1);field.current?.focus();};
  return <div className="editable-select" ref={root} onBlur={event=>{if(!root.current?.contains(event.relatedTarget as Node|null))setOpen(false);}}>
    <input ref={field} role="combobox" aria-label={label} aria-expanded={open&&choices.length>0} aria-controls={open&&choices.length?id:undefined} aria-autocomplete="list" aria-activedescendant={open&&active>=0&&active<choices.length?`${id}-${active}`:undefined} value={value} placeholder={placeholder} disabled={disabled} maxLength={maxLength} autoComplete="off" spellCheck={false}
      onChange={event=>{onChange(event.target.value);setAll(false);setOpen(true);}}
      onKeyDown={event=>{
        if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setOpen(false);}
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setOpen(true);setAll(true);setActive(index=>Math.max(0,Math.min(choices.length-1,index+(event.key==='ArrowDown'?1:-1))));}
        if(event.key==='Enter'&&open){event.preventDefault();event.stopPropagation();if(active>=0&&choices[active])choose(choices[active]);else setOpen(false);}
        if(event.key==='Tab')setOpen(false);
      }}/>
    <button type="button" tabIndex={-1} disabled={disabled} aria-label={t('选择{label}',{label})} onMouseDown={event=>event.preventDefault()} onClick={()=>{setAll(true);setOpen(value=>!value);field.current?.focus();}}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5"/></svg></button>
    {open&&choices.length>0&&createPortal(<div id={id} role="listbox" aria-label={t('{label}建议',{label})} className="editable-select-options" style={position} onMouseDown={event=>event.preventDefault()}>{choices.map((choice,index)=><div key={choice} id={`${id}-${index}`} role="option" aria-selected={choice===value} className={index===active?'active':''} onMouseEnter={()=>setActive(index)} onClick={()=>choose(choice)}>{choice}</div>)}</div>,document.body)}
  </div>;
}
