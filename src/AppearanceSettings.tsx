import {useEffect,useState,type ReactNode} from 'react';
import {Select} from './Select';
import {Icon} from './ui';
import {DEFAULT_APPEARANCE,normalizeAppearance,type AppearanceSettings as Values} from './appearance';
import {languageOptions,useI18n} from './i18n';
import './appearance-settings.css';

function Row({title,hint,children}:{title:string;hint?:string;children:ReactNode}){return <div className="appearance-row"><div><span>{title}</span>{hint&&<small>{hint}</small>}</div><div className="appearance-control">{children}</div></div>;}
function FontName({value,onChange,label}:{value:string;onChange:(v:string)=>void;label:string}){
  const [draft,setDraft]=useState(value);useEffect(()=>setDraft(value),[value]);
  const {t}=useI18n();
  return <input aria-label={label} value={draft} placeholder={t('例如 Microsoft YaHei')} maxLength={80} onChange={e=>setDraft(e.target.value)} onBlur={()=>{const name=normalizeAppearance({customFont:draft}).customFont;setDraft(name);onChange(name);}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur();}}}/>;
}
export function AppearanceSettings({settings,change,saving,error}:{settings:Values;change:(patch:Partial<Values>)=>void;saving:boolean;error:string}){
  const {t,language,setLanguage}=useI18n();
  const number=(key:'textScale'|'messageSize'|'codeSize'|'lineHeight',label:string,min:number,max:number,step=1,suffix='')=><div className="appearance-range"><input type="range" aria-label={t(label)} min={min} max={max} step={step} value={settings[key]} onChange={e=>change({[key]:Number(e.target.value)})}/><output>{settings[key]}{suffix}</output></div>;
  return <div className="appearance-settings">
    <section className="appearance-section"><h3>{t('语言')}</h3><Row title={t('界面语言')} hint={t('语言会立即应用并保存在本机')}><Select aria-label={t('选择界面语言')} value={language} onChange={event=>setLanguage(event.target.value as typeof language)}>{languageOptions.map(option=><option value={option.value} key={option.value}>{option.label}</option>)}</Select></Row></section>
    <section className="appearance-section"><h3>{t('主题')}</h3><div className="appearance-themes">{(['light','dark','system'] as const).map(theme=><button type="button" key={theme} aria-pressed={settings.theme===theme} onClick={()=>change({theme})}><span className={`appearance-theme-swatch is-${theme}`} aria-hidden="true"><i/><b/><em/></span><span>{t(theme==='light'?'浅色':theme==='dark'?'深色':'跟随系统')}{settings.theme===theme&&<Icon name="check" size={14}/>}</span></button>)}</div></section>
    <div className="appearance-sample" aria-label={t('外观实时预览')}><span>{t('实时预览')}</span><h3>{t('让阅读更舒服一点。')}</h3><p>{t('今天的工作已经整理好。')} The details make a difference.</p><code>const progress = 100;</code></div>
    <section className="appearance-section"><h3>{t('字体')}</h3>
      <Row title={t('界面字体')}><Select aria-label={t('界面字体')} value={settings.font} onChange={e=>change({font:e.target.value as Values['font']})}><option value="bundled">Inter ＋ {language==='en'?'Noto Sans':'思源黑体'}</option><option value="system">{t('系统默认')}</option><option value="custom">{t('自定义字体')}</option></Select></Row>
      {settings.font==='custom'&&<Row title={t('字体名称')} hint={t('填写已安装的字体；未找到时使用内置字体')}><FontName label={t('自定义界面字体名称')} value={settings.customFont} onChange={customFont=>change({customFont})}/></Row>}
      <Row title={t('代码字体')}><Select aria-label={t('代码字体')} value={settings.codeFont} onChange={e=>change({codeFont:e.target.value as Values['codeFont']})}><option value="bundled">JetBrains Mono</option><option value="system">{t('系统等宽字体')}</option><option value="custom">{t('自定义字体')}</option></Select></Row>
      {settings.codeFont==='custom'&&<Row title={t('代码字体名称')} hint={t('建议使用等宽字体')}><FontName label={t('自定义代码字体名称')} value={settings.customCodeFont} onChange={customCodeFont=>change({customCodeFont})}/></Row>}
      <Row title={t('正文字重')} hint={t('按钮和标题会相应加重，保留层级')}><Select aria-label={t('正文字重')} value={String(settings.weight)} onChange={e=>change({weight:Number(e.target.value)})}><option value="300">{t('纤细 · 300')}</option><option value="400">{t('常规 · 400')}</option><option value="500">{t('中等 · 500')}</option><option value="600">{t('较粗 · 600')}</option></Select></Row>
    </section>
    <section className="appearance-section"><h3>{t('大小与间距')}</h3>
      <Row title={t('界面文字')} hint={t('同时调整标题、按钮和辅助文字')}>{number('textScale','界面文字大小',85,130,5,'%')}</Row>
      <Row title={t('消息文字')}>{number('messageSize','消息文字大小',12,22,1,' px')}</Row>
      <Row title={t('代码文字')}>{number('codeSize','代码文字大小',11,20,1,' px')}</Row>
      <Row title={t('消息行距')}>{number('lineHeight','消息行距',1.4,2.2,.1)}</Row>
      <Row title={t('显示比例')} hint={t('缩放整个界面，包括侧栏与控件')}><Select aria-label={t('显示比例')} value={String(settings.zoom)} onChange={e=>change({zoom:Number(e.target.value)})}>{[...new Set([50,75,90,100,110,125,150,175,200,settings.zoom])].sort((a,b)=>a-b).map(value=><option key={value} value={String(value)}>{value}%{value===100?` · ${t('默认')}`:''}</option>)}</Select></Row>
    </section>
    <footer className="appearance-footer"><button type="button" className="text-button" onClick={()=>change({...DEFAULT_APPEARANCE})}>{t('恢复默认')}</button><span role="status" className={error?'is-error':''}>{error|| (saving?t('正在保存…'):t('更改已自动保存'))}</span></footer>
  </div>;
}
