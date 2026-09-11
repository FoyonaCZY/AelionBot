import {useEffect,useId,useState} from 'react';
import {Avatar} from './ui';
import {Select} from './Select';
import {BOT_PALETTES,BOT_SPLIT_PATTERNS,DEFAULT_BOT_PALETTE,botPaletteKey,displayBotPalette,isBotHexColor,normalizeBotPalette,randomBotPalette,type BotPalette,type BotSplitPattern} from './bot-colors';
import {useI18n} from './i18n';
import './bot-palette-editor.css';

function ColorField({label,color,onChange,disabled}:{label:string;color:string;onChange:(color:string)=>void;disabled:boolean}){
  const {t}=useI18n();
  const id=useId(),[text,setText]=useState(color),[touched,setTouched]=useState(false);
  useEffect(()=>{setText(color);setTouched(false);},[color]);
  const normalized=text.startsWith('#')?text:'#'+text,valid=isBotHexColor(normalized);
  return <div className="bot-color-field"><label htmlFor={id}>{label}</label><div className="bot-color-input">
    <input className="bot-color-swatch" type="color" aria-label={`${label}选择器`} value={color} disabled={disabled} onChange={event=>{setText(event.target.value);setTouched(false);onChange(event.target.value);}}/>
    <input id={id} className="bot-color-hex" aria-label={`${label}色值`} aria-invalid={touched&&!valid||undefined} value={text} maxLength={7} pattern="#?[a-fA-F0-9]{6}" required spellCheck={false} disabled={disabled} onInvalid={()=>setTouched(true)} onBlur={()=>{setTouched(true);if(valid)setText(normalized.toLowerCase());}} onChange={event=>{const next=event.target.value;setText(next);const hex=next.startsWith('#')?next:'#'+next;if(isBotHexColor(hex))onChange(hex.toLowerCase());}}/>
  </div>{touched&&!valid&&<span className="bot-color-error" role="alert">{t('请输入六位颜色值')}</span>}</div>;
}

export function BotPaletteEditor({value,onChange,name='Bot',disabled=false}:{value:BotPalette;onChange:(palette:BotPalette)=>void;name?:string;disabled?:boolean}){
  const {t}=useI18n();
  const [open,setOpen]=useState(false),[editVersion,setEditVersion]=useState(0),id=useId(),palette=displayBotPalette(value),kind=palette.avatarStyle?.kind||'solid';
  const key=botPaletteKey(palette),preset=BOT_PALETTES.find(item=>botPaletteKey(item)===key),kindLabel=t({solid:'纯色',gradient:'渐变',split:'拼色'}[kind]);
  const selectPalette=(next:BotPalette)=>{setEditVersion(version=>version+1);onChange(next);};
  const chooseKind=(next:'solid'|'gradient'|'split')=>{
    if(next===kind)return;const fallback=next==='gradient'?'#4d8ac4':'#c7956c',secondary=palette.avatarStyle?.secondary||(palette.color===fallback?'#8b6bea':fallback);
    selectPalette(next==='solid'?{color:palette.color}:{color:palette.color,avatarStyle:next==='gradient'?{kind:next,secondary,direction:'diagonal'}:{kind:next,secondary,pattern:'arc'}});
  };
  return <section className="bot-palette-editor" aria-label={t('头像配色')}>
    <div className="bot-palette-summary"><Avatar bot={{name,...palette}} size={60}/><div><span>{t('头像配色')}</span><strong>{preset?t(preset.name):t('自定义{kind}',{kind:kindLabel})}</strong></div><button type="button" className="bot-palette-toggle" disabled={disabled} aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>setOpen(!open)}>{open?t('收起'):t('更改配色')}</button><button type="button" className="bot-palette-random" disabled={disabled} onClick={()=>selectPalette(randomBotPalette(palette))}>{t('随机')}</button></div>
    {open&&<div className="bot-palette-body" id={id}>
      <div className="bot-palette-tabs" role="group" aria-label={t('配色类型')}>{(['solid','gradient','split'] as const).map(type=><button type="button" key={type} aria-pressed={kind===type} disabled={disabled} onClick={()=>chooseKind(type)}>{t(({solid:'纯色',gradient:'渐变',split:'拼色'})[type])}</button>)}</div>
      <div className="bot-palette-presets" role="group" aria-label={t('{kind}预设',{kind:kindLabel})}>{BOT_PALETTES.filter(item=>(item.avatarStyle?.kind||'solid')===kind).map(item=><button type="button" key={item.id} title={t(item.name)} aria-label={t('选择{name}配色',{name:t(item.name)})} aria-pressed={key===botPaletteKey(item)} disabled={disabled} onClick={()=>selectPalette(normalizeBotPalette(item))}><Avatar bot={{name:item.name,color:item.color,avatarStyle:item.avatarStyle}} size={32}/><span>{t(item.name)}</span></button>)}</div>
      <div className="bot-palette-custom"><ColorField key={`primary-${editVersion}`} label={t('主色')} color={palette.color} disabled={disabled} onChange={color=>onChange({...palette,color})}/>{palette.avatarStyle&&<ColorField key={`secondary-${editVersion}`} label={t('第二种颜色')} color={palette.avatarStyle.secondary} disabled={disabled} onChange={secondary=>onChange({...palette,avatarStyle:{...palette.avatarStyle!,secondary}})}/>}</div>
      {palette.avatarStyle?.kind==='gradient'&&<label className="bot-palette-pattern">{t('渐变方向')}<Select aria-label={t('渐变方向')} value={palette.avatarStyle.direction} disabled={disabled} onChange={event=>onChange({...palette,avatarStyle:{...palette.avatarStyle as Extract<NonNullable<BotPalette['avatarStyle']>,{kind:'gradient'}>,direction:event.target.value as 'diagonal'|'vertical'}})}><option value="diagonal">{t('斜向')}</option><option value="vertical">{t('纵向')}</option></Select></label>}
      {palette.avatarStyle?.kind==='split'&&<label className="bot-palette-pattern">{t('拼色方式')}<Select aria-label={t('拼色方式')} value={palette.avatarStyle.pattern} disabled={disabled} onChange={event=>onChange({...palette,avatarStyle:{...palette.avatarStyle as Extract<NonNullable<BotPalette['avatarStyle']>,{kind:'split'}>,pattern:event.target.value as BotSplitPattern}})}>{Object.entries(BOT_SPLIT_PATTERNS).map(([pattern,label])=><option value={pattern} key={pattern}>{t(label)}</option>)}</Select></label>}
      <div className="bot-palette-tools"><button type="button" disabled={disabled} onClick={()=>selectPalette({...DEFAULT_BOT_PALETTE})}>{t('恢复原版紫色')}</button>{palette.avatarStyle&&<button type="button" disabled={disabled} onClick={()=>selectPalette({color:palette.avatarStyle!.secondary,avatarStyle:{...palette.avatarStyle!,secondary:palette.color}})}>{t('交换两色')}</button>}</div>
    </div>}
  </section>;
}
