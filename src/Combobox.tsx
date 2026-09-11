import {useEffect,useId,useLayoutEffect,useRef,useState,type InputHTMLAttributes} from 'react';
import {useI18n} from './i18n';
import './select.css';

type Props=Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'defaultValue'|'onChange'|'list'|'type'> & {
  value:string;options:string[];onChange:(value:string)=>void;emptyMessage?:string;
};

export function Combobox({value,options,onChange,emptyMessage='也可以直接输入其他值',disabled,className='',onKeyDown,onBlur,...props}:Props){
  const {t}=useI18n();
  const id=useId(),input=useRef<HTMLInputElement>(null),root=useRef<HTMLSpanElement>(null),list=useRef<HTMLSpanElement>(null);
  const empty=emptyMessage==='也可以直接输入其他值'?t('也可以直接输入其他值'):emptyMessage;
  const [open,setOpen]=useState(false),[filter,setFilter]=useState(false),[active,setActive]=useState(0);
  const matches=options.filter(option=>!filter||option.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
  const index=matches.length?Math.min(active,matches.length-1):-1;
  const show=()=>{if(disabled)return;setFilter(false);setActive(Math.max(0,options.indexOf(value)));setOpen(true);};
  const choose=(option:string)=>{onChange(option);setFilter(false);setOpen(false);input.current?.focus({preventScroll:true});};

  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useLayoutEffect(()=>{
    const popup=list.current,field=input.current;if(!open||!popup||!field)return;
    popup.showPopover();
    const place=()=>{
      const rect=field.getBoundingClientRect(),width=Math.min(rect.width,document.documentElement.clientWidth-16);
      const above=rect.top-8,below=innerHeight-rect.bottom-8,down=below>=Math.min(240,above),available=Math.max(0,(down?below:above)-6);
      popup.style.width=`${width}px`;popup.style.maxHeight=`${Math.min(272,available)}px`;
      popup.style.left=`${Math.max(8,Math.min(rect.left,document.documentElement.clientWidth-width-8))}px`;
      popup.style.top=`${down?rect.bottom+6:Math.max(8,rect.top-6-popup.getBoundingClientRect().height)}px`;
    };
    place();
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const scroll=(event:Event)=>{if(!popup.contains(event.target as Node))place();};
    const observer=new ResizeObserver(place);observer.observe(field);
    document.addEventListener('pointerdown',outside,true);window.addEventListener('resize',place);window.addEventListener('scroll',scroll,true);
    return()=>{observer.disconnect();document.removeEventListener('pointerdown',outside,true);window.removeEventListener('resize',place);window.removeEventListener('scroll',scroll,true);if(popup.matches(':popover-open'))popup.hidePopover();};
  },[open,matches.join('\0')]);
  useLayoutEffect(()=>{if(!open||index<0)return;const popup=list.current,option=popup?.querySelector<HTMLElement>(`[data-index="${index}"]`);if(!popup||!option)return;if(option.offsetTop<popup.scrollTop)popup.scrollTop=option.offsetTop;else if(option.offsetTop+option.offsetHeight>popup.scrollTop+popup.clientHeight)popup.scrollTop=option.offsetTop+option.offsetHeight-popup.clientHeight;},[open,index]);

  return <span className={`aelion-combobox ${className}`} ref={root} data-open={open} data-disabled={disabled||undefined}>
    <input {...props} ref={input} className="aelion-combobox-input" type="text" role="combobox" value={value} disabled={disabled} autoComplete="off" aria-autocomplete="list" aria-expanded={open} aria-controls={open?id:undefined} aria-activedescendant={open&&index>=0?`${id}-${index}`:undefined}
      onClick={show} onChange={event=>{onChange(event.target.value);setFilter(true);setActive(0);setOpen(true);}} onBlur={event=>{setOpen(false);onBlur?.(event);}}
      onKeyDown={event=>{
        if(event.nativeEvent.isComposing)return;
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopPropagation();if(!open)show();else if(matches.length)setActive((index+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length);}
        else if(open&&event.key==='Enter'){event.preventDefault();event.stopPropagation();if(index>=0)choose(matches[index]);else setOpen(false);}
        else if(open&&event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);}
        else if(event.key==='Tab')setOpen(false);
        onKeyDown?.(event);
      }}/>
    <span className="aelion-combobox-arrow" aria-hidden="true" onPointerDown={event=>{event.preventDefault();if(disabled)return;input.current?.focus({preventScroll:true});if(open)setOpen(false);else show();}} onClick={event=>event.preventDefault()}/>
    {open&&<span ref={list} id={id} popover="manual" role="listbox" aria-label={props['aria-label']||t('选项')} className="aelion-combobox-list">
      {matches.length?matches.map((option,i)=><span key={option} id={`${id}-${i}`} data-index={i} role="option" aria-selected={option===value} className={`aelion-combobox-option ${i===index?'is-active':''}`} onPointerDown={event=>event.preventDefault()} onMouseMove={()=>setActive(i)} onClick={event=>{event.preventDefault();choose(option);}}>{option}{option===value&&<span className="aelion-option-check" aria-hidden="true"/>}</span>):<span className="aelion-combobox-empty">{empty}</span>}
    </span>}
  </span>;
}
