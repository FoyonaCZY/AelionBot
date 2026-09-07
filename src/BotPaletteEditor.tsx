import {useEffect,useId,useState} from 'react';
import {Avatar} from './ui';
import {Select} from './Select';
import {BOT_PALETTES,BOT_SPLIT_PATTERNS,DEFAULT_BOT_PALETTE,botPaletteKey,displayBotPalette,isBotHexColor,normalizeBotPalette,randomBotPalette,type BotPalette,type BotSplitPattern} from './bot-colors';
import './bot-palette-editor.css';

function ColorField({label,color,onChange,disabled}:{label:string;color:string;onChange:(color:string)=>void;disabled:boolean}){
  const id=useId(),[text,setText]=useState(color),[touched,setTouched]=useState(false);
  useEffect(()=>{setText(color);setTouched(false);},[color]);
  const normalized=text.startsWith('#')?text:'#'+text,valid=isBotHexColor(normalized);
  return <div className="bot-color-field"><label htmlFor={id}>{label}</label><div className="bot-color-input">
    <input className="bot-color-swatch" type="color" aria-label={`${label}选择器`} value={color} disabled={disabled} onChange={event=>{setText(event.target.value);setTouched(false);onChange(event.target.value);}}/>
    <input id={id} className="bot-color-hex" aria-label={`${label}色值`} aria-invalid={touched&&!valid||undefined} value={text} maxLength={7} pattern="#?[a-fA-F0-9]{6}" required spellCheck={false} disabled={disabled} onInvalid={()=>setTouched(true)} onBlur={()=>{setTouched(true);if(valid)setText(normalized.toLowerCase());}} onChange={event=>{const next=event.target.value;setText(next);const hex=next.startsWith('#')?next:'#'+next;if(isBotHexColor(hex))onChange(hex.toLowerCase());}}/>
  </div>{touched&&!valid&&<span className="bot-color-error" role="alert">请输入六位颜色值</span>}</div>;
}

export function BotPaletteEditor({value,onChange,name='Bot',disabled=false}:{value:BotPalette;onChange:(palette:BotPalette)=>void;name?:string;disabled?:boolean}){
  const [open,setOpen]=useState(false),[editVersion,setEditVersion]=useState(0),id=useId(),palette=displayBotPalette(value),kind=palette.avatarStyle?.kind||'solid';
  const key=botPaletteKey(palette),preset=BOT_PALETTES.find(item=>botPaletteKey(item)===key),kindLabel={solid:'纯色',gradient:'渐变',split:'拼色'}[kind];
  const selectPalette=(next:BotPalette)=>{setEditVersion(version=>version+1);onChange(next);};
  const chooseKind=(next:'solid'|'gradient'|'split')=>{
    if(next===kind)return;const fallback=next==='gradient'?'#4d8ac4':'#c7956c',secondary=palette.avatarStyle?.secondary||(palette.color===fallback?'#8b6bea':fallback);
    selectPalette(next==='solid'?{color:palette.color}:{color:palette.color,avatarStyle:next==='gradient'?{kind:next,secondary,direction:'diagonal'}:{kind:next,secondary,pattern:'arc'}});
  };
  return <section className="bot-palette-editor" aria-label="头像配色">
    <div className="bot-palette-summary"><Avatar bot={{name,...palette}} size={60}/><div><span>头像配色</span><strong>{preset?.name||`自定义${kindLabel}`}</strong></div><button type="button" className="bot-palette-toggle" disabled={disabled} aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>setOpen(!open)}>{open?'收起':'更改配色'}</button><button type="button" className="bot-palette-random" disabled={disabled} onClick={()=>selectPalette(randomBotPalette(palette))}>随机</button></div>
    {open&&<div className="bot-palette-body" id={id}>
      <div className="bot-palette-tabs" role="group" aria-label="配色类型">{(['solid','gradient','split'] as const).map(type=><button type="button" key={type} aria-pressed={kind===type} disabled={disabled} onClick={()=>chooseKind(type)}>{({solid:'纯色',gradient:'渐变',split:'拼色'})[type]}</button>)}</div>
      <div className="bot-palette-presets" role="group" aria-label={`${kindLabel}预设`}>{BOT_PALETTES.filter(item=>(item.avatarStyle?.kind||'solid')===kind).map(item=><button type="button" key={item.id} title={item.name} aria-label={`选择${item.name}配色`} aria-pressed={key===botPaletteKey(item)} disabled={disabled} onClick={()=>selectPalette(normalizeBotPalette(item))}><Avatar bot={{name:item.name,color:item.color,avatarStyle:item.avatarStyle}} size={32}/><span>{item.name}</span></button>)}</div>
      <div className="bot-palette-custom"><ColorField key={`primary-${editVersion}`} label="主色" color={palette.color} disabled={disabled} onChange={color=>onChange({...palette,color})}/>{palette.avatarStyle&&<ColorField key={`secondary-${editVersion}`} label="第二种颜色" color={palette.avatarStyle.secondary} disabled={disabled} onChange={secondary=>onChange({...palette,avatarStyle:{...palette.avatarStyle!,secondary}})}/>}</div>
      {palette.avatarStyle?.kind==='gradient'&&<label className="bot-palette-pattern">渐变方向<Select aria-label="渐变方向" value={palette.avatarStyle.direction} disabled={disabled} onChange={event=>onChange({...palette,avatarStyle:{...palette.avatarStyle as Extract<NonNullable<BotPalette['avatarStyle']>,{kind:'gradient'}>,direction:event.target.value as 'diagonal'|'vertical'}})}><option value="diagonal">斜向</option><option value="vertical">纵向</option></Select></label>}
      {palette.avatarStyle?.kind==='split'&&<label className="bot-palette-pattern">拼色方式<Select aria-label="拼色方式" value={palette.avatarStyle.pattern} disabled={disabled} onChange={event=>onChange({...palette,avatarStyle:{...palette.avatarStyle as Extract<NonNullable<BotPalette['avatarStyle']>,{kind:'split'}>,pattern:event.target.value as BotSplitPattern}})}>{Object.entries(BOT_SPLIT_PATTERNS).map(([pattern,label])=><option value={pattern} key={pattern}>{label}</option>)}</Select></label>}
      <div className="bot-palette-tools"><button type="button" disabled={disabled} onClick={()=>selectPalette({...DEFAULT_BOT_PALETTE})}>恢复原版紫色</button>{palette.avatarStyle&&<button type="button" disabled={disabled} onClick={()=>selectPalette({color:palette.avatarStyle!.secondary,avatarStyle:{...palette.avatarStyle!,secondary:palette.color}})}>交换两色</button>}</div>
    </div>}
  </section>;
}
