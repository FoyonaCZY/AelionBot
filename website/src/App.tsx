import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import logoLight from '../../docs/assets/logo-light.svg';
import logoDark from '../../docs/assets/logo-dark.svg';
import {productScenes,sceneCopy} from './product-scenes';
import {readSiteLanguage,rememberSiteLanguage} from './locale.mjs';
import {version} from '../../package.json';
import {BotSculpture,tones,type BotTone} from './BotSculpture';
import {siteCopy,siteExamples,siteLanguages,siteQuestions,type SiteLanguage} from './site-i18n';
import {resetSurface,trackSurface,useMotionPreference,useSiteMotion} from './useSiteMotion';
import site from '../site.json';
import './site-i18n.css';

const download=`${site.repository}/releases/latest`;
const macGuide=`${site.repository}/blob/main/docs/releases/v0.6.0.md`;

type IconName='arrow'|'down'|'plus'|'close'|'menu'|'expand'|'file'|'check'|'windows';
function Icon({name,size=20}:{name:IconName;size?:number}){
  const paths:Record<IconName,ReactNode>={arrow:<path d="M4 12h15m-6-6 6 6-6 6"/>,down:<path d="M12 4v15m-6-6 6 6 6-6"/>,plus:<path d="M5 12h14M12 5v14"/>,close:<path d="m6 6 12 12M18 6 6 18"/>,menu:<path d="M4 8h16M4 16h16"/>,expand:<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/>,file:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"/><path d="M8 13h8M8 17h5"/></>,check:<path d="m5 12 4 4L19 6"/>,windows:<path d="m3 5 8-1v7H3zm10-1 8-1v8h-8zM3 13h8v7l-8-1zm10 0h8v8l-8-1z" fill="currentColor" stroke="none"/>};
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function WorkOfArt({copy}:{copy:typeof siteCopy['zh-CN']}){
  return <div className="work-of-art" aria-label={copy.sceneAria}>
    <div className="work-light"/>
    <div className="work-paper paper-back"><span>{copy.paperBack}</span><div className="paper-chart" aria-hidden="true">{[35,59,45,75,61,90,73].map((height,index)=><i key={index} style={{'--bar-height':`${height}%`} as CSSProperties}/>)}</div><div className="paper-rule"/><div className="paper-rule short"/></div>
    <div className="work-paper paper-front"><span className="paper-overline">{copy.paperOverline}</span><h3>{copy.paperTitle[0]}<br/>{copy.paperTitle[1]}</h3><div className="paper-art" aria-hidden="true"><i/><i/><i/></div><div className="paper-rule"/><div className="paper-rule"/><div className="paper-rule short"/><span className="paper-page">01</span></div>
    <div className="work-delivery"><span className="delivery-icon"><Icon name="file" size={24}/></span><div><strong>{copy.deliveryTitle}</strong><span>{copy.deliverySubtitle}</span></div><Icon name="check" size={19}/></div>
    <BotSculpture className="work-helper" tone="blue"/>
  </div>;
}

export default function App(){
  const root=useRef<HTMLDivElement>(null),gallery=useRef<HTMLDialogElement>(null),menuButton=useRef<HTMLButtonElement>(null);
  const motion=useMotionPreference();useSiteMotion(root,motion.enabled);
  const [language,setLanguage]=useState<SiteLanguage>(()=>readSiteLanguage() as SiteLanguage),[menuOpen,setMenuOpen]=useState(false),[view,setView]=useState(0),[detail,setDetail]=useState(2),[shot,setShot]=useState<number|null>(null),[tone,setTone]=useState<BotTone>('violet'),[example,setExample]=useState(0);
  const copy=siteCopy[language],scenes=sceneCopy[language],workExamples=siteExamples[language],questions=siteQuestions[language],screenshots=productScenes(language).map((src,index)=>({src,title:index<2?copy.viewProduct[index]:scenes.tabs[index-2],alt:scenes.alt[index]}));
  const current=workExamples[example];
  useEffect(()=>{document.documentElement.lang=language;document.title=language==='en'?'AelionBot · Good ideas, made together':language==='zh-TW'?'AelionBot · 好點子，一起做出來':'AelionBot · 好想法，一起做出来';document.querySelector('meta[name="description"]')?.setAttribute('content',copy.heroDescription);rememberSiteLanguage(language);document.querySelector('meta[property="og:title"]')?.setAttribute('content',document.title);document.querySelector('meta[property="og:description"]')?.setAttribute('content',copy.heroDescription);},[language,copy.heroDescription]);
  useEffect(()=>{
    if(!menuOpen)return;
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMenuOpen(false);menuButton.current?.focus();}};
    const outside=(event:PointerEvent)=>{if(!(event.target as Element).closest('.site-header'))setMenuOpen(false);};
    document.addEventListener('keydown',escape);document.addEventListener('pointerdown',outside);
    return()=>{document.removeEventListener('keydown',escape);document.removeEventListener('pointerdown',outside);};
  },[menuOpen]);
  useEffect(()=>{
    const dialog=gallery.current;if(!dialog)return;
    if(shot===null){if(dialog.open)dialog.close();return;}
    if(!dialog.open)dialog.showModal();
    const overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    return()=>{document.body.style.overflow=overflow;};
  },[shot]);
  const changeShot=(step:number)=>setShot(index=>index===null?0:(index+step+screenshots.length)%screenshots.length);
  return <div ref={root} className="site-app product-site" data-motion={motion.enabled?'on':'off'}>
    <div className="reading-progress" aria-hidden="true"/><a className="skip-link" href="#main">{copy.skip}</a>
    <header className="site-header"><div className="nav-shell"><a className="brand-link" href="#" aria-label={copy.home}><img className="brand-on-light" src={logoLight} width="144" height="41" alt="AelionBot"/><img className="brand-on-dark" src={logoDark} width="144" height="41" alt=""/></a>
      <nav id="main-navigation" className={`main-nav ${menuOpen?'is-open':''}`} aria-label={copy.mainNav}>{site.navigation.map(link=><a key={link.href} href={link.href==='/blog/'?`/blog/?lang=${language}`:link.href} onClick={()=>setMenuOpen(false)} {...(link.external?{target:'_blank',rel:'noopener noreferrer'}:{})}>{link.href==='/blog/'?copy.blog:copy.github}</a>)}</nav>
      <a className="button nav-download" href="#download">{copy.download}</a><select className="site-language-switcher" aria-label={language==='en'?'Language':language==='zh-TW'?'語言':'语言'} value={language} onChange={event=>setLanguage(event.target.value as SiteLanguage)}>{siteLanguages.map(option=><option value={option.value} key={option.value}>{option.label}</option>)}</select><button ref={menuButton} className="mobile-menu-button" aria-label={menuOpen?copy.closeNav:copy.openNav} aria-controls="main-navigation" aria-expanded={menuOpen} onClick={()=>setMenuOpen(value=>!value)}><Icon name={menuOpen?'close':'menu'}/></button>
    </div></header>
    <main id="main">
      <section className="hero-section" aria-labelledby="hero-title" data-motion-region data-scroll-scene="hero">
        <div className="hero-spotlight" aria-hidden="true"/><div className="hero-copy"><p className="eyebrow" data-reveal>{copy.heroEyebrow}</p><h1 id="hero-title" data-reveal data-delay="1">{copy.heroTitle[0]}<br/><span>{copy.heroTitle[1]}</span></h1><p className="hero-description" data-reveal data-delay="2">{copy.heroDescription}</p><div className="hero-actions" data-reveal data-delay="3"><a href="#download" className="button button-primary">{copy.meet}<Icon name="arrow" size={17}/></a><a href="#work" className="hero-more">{copy.seeCollab}<Icon name="down" size={16}/></a></div></div>
        <div className="hero-cast" aria-hidden="true"><div className="cast-floor"/><div className="cast-member cast-blue"><BotSculpture tone="blue"/></div><div className="cast-member cast-mint"><BotSculpture tone="mint"/></div><div className="cast-member cast-violet"><BotSculpture/></div><span className="cast-caption">{copy.castCaption}</span></div>
      </section>

      <section className="work-section section-shell" id="work" data-scroll-scene="showcase">
        <div className="section-heading centered" data-reveal><p className="section-kicker">{copy.fromOne}</p><h2>{copy.workTitle[0]}<br/>{copy.workTitle[1]}</h2><p>{copy.workDescription}</p></div>
        <div className="product-view-tabs" role="tablist" aria-label={copy.productViewAria}>{copy.viewProduct.map((label,index)=><button key={label} id={`view-tab-${index}`} role="tab" aria-selected={view===index} aria-controls="product-view" tabIndex={view===index?0:-1} onClick={()=>setView(index)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:1-index;setView(next);document.getElementById(`view-tab-${next}`)?.focus();}}}>{label}</button>)}</div>
        <div className="product-stage" data-reveal><div className="product-stage-light" aria-hidden="true"/><div className="product-device" id="product-view" role="tabpanel" aria-labelledby={`view-tab-${view}`}><img key={view} src={screenshots[view].src} alt={screenshots[view].alt} width="1200" height="740" loading="lazy"/><button className="product-expand" onClick={()=>setShot(view)} aria-label={copy.expandProduct}><Icon name="expand" size={18}/></button></div></div>
        <p className="product-caption">{scenes.caption}</p>
      </section>

      <section className="making-section" data-scroll-scene="making" data-motion-region>
        <div className="making-sticky section-shell"><div className="making-copy" data-reveal><p className="section-kicker">{copy.makingKicker}</p><h2>{copy.makingTitle[0]}<br/>{copy.makingTitle[1]}<br/><span>{copy.makingTitle[2]}</span></h2><p>{copy.makingDescription[0]}<br/>{copy.makingDescription[1]}</p></div><WorkOfArt copy={copy}/></div>
      </section>

      <section className="personality-section section-shell" data-motion-region>
        <div className="personality-visual" style={{'--tone-light':tones[tone][0],'--tone-main':tones[tone][1]} as CSSProperties}><div className="personality-halo" aria-hidden="true"/><BotSculpture key={tone} tone={tone} className="personality-bot"/><div className="palette-options" role="group" aria-label={copy.paletteAria}>{(Object.keys(tones) as BotTone[]).map((value,index)=><button key={value} aria-label={copy.paletteNames[index]} aria-pressed={tone===value} onClick={()=>setTone(value)} style={{'--swatch':`linear-gradient(140deg,${tones[value][0]},${tones[value][2]})`} as CSSProperties}/>)}</div><span className="palette-hint">{copy.paletteHint}</span></div>
        <div className="personality-copy" data-reveal><p className="section-kicker">{copy.personalityKicker}</p><h2>{copy.personalityTitle[0]}<br/><span>{copy.personalityTitle[1]}</span></h2><p>{copy.personalityDescription[0]}<br/>{copy.personalityDescription[1]}</p><div className="memory-note"><BotSculpture tone={tone} flat/><div><p>{copy.memoryQuote}</p><span>{copy.memoryDescription}</span></div></div></div>
      </section>

      <section className="possibilities-section" id="possibilities"><div className="section-shell"><div className="section-heading" data-reveal><p className="section-kicker">{copy.possibilitiesKicker}</p><h2>{copy.possibilitiesTitle[0]}<br/><span>{copy.possibilitiesTitle[1]}</span></h2></div>
        <div className="possibility-tabs" role="tablist" aria-label={copy.possibilitiesKicker}>{workExamples.map((item,index)=><button key={item.name} id={`case-tab-${index}`} role="tab" aria-selected={example===index} aria-controls="case-panel" tabIndex={example===index?0:-1} onClick={()=>setExample(index)} onKeyDown={event=>{let next=index;if(event.key==='ArrowRight')next=(index+1)%workExamples.length;else if(event.key==='ArrowLeft')next=(index+workExamples.length-1)%workExamples.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=workExamples.length-1;else return;event.preventDefault();setExample(next);document.getElementById(`case-tab-${next}`)?.focus();}}>{item.name}</button>)}</div>
        <div id="case-panel" role="tabpanel" aria-labelledby={`case-tab-${example}`} className="case-panel" data-motion-region onPointerMove={trackSurface} onPointerLeave={resetSurface}><div className="case-copy" key={example}><span>{copy.casePrompt}</span><h3>{current.prompt}</h3><p>{current.result}</p></div><div className={`case-art case-${current.tone}`} aria-hidden="true"><BotSculpture tone={current.tone}/><div className="case-file"><Icon name="file" size={30}/><span>{current.file}</span><i><Icon name="check" size={15}/></i></div></div></div>
        <div className="everyday-note" data-reveal><span className="calendar-mini" aria-hidden="true"><span>{language==='en'?'Week':language==='zh-TW'?'每週':'每周'}</span><strong>{language==='en'?'F': '五'}</strong></span><div><h3>{copy.weeklyTitle}</h3><p>{copy.weeklyDescription}</p></div><a className="text-link" href="#questions">{copy.weeklyLink}<Icon name="arrow" size={17}/></a></div>
      </div></section>

      <section className="studio-section section-shell" aria-labelledby="studio-title">
        <div className="section-heading centered" data-reveal><p className="section-kicker">{scenes.kicker}</p><h2 id="studio-title">{scenes.title[0]}<br/><span>{scenes.title[1]}</span></h2><p>{scenes.description}</p></div>
        <div className="studio-tabs" role="group" aria-label={scenes.kicker}>{scenes.tabs.map((label,index)=><button key={label} aria-pressed={detail===index+2} onClick={()=>setDetail(index+2)}>{label}</button>)}</div>
        <button className="studio-visual" onClick={()=>setShot(detail)} aria-label={`${copy.expandProduct}: ${scenes.tabs[detail-2]}`}><img src={screenshots[detail].src} alt={screenshots[detail].alt} width="1200" height="740" loading="lazy"/><span className="studio-expand"><Icon name="expand" size={18}/></span></button><p className="product-caption">{scenes.caption}</p>
      </section>

      <section className="questions-section section-shell" id="questions"><h2 data-reveal>{copy.questionsTitle}</h2><div className="question-list">{questions.map(item=><details className="question-item" key={item.question}><summary>{item.question}<Icon name="plus" size={18}/></summary><p>{item.answer}</p></details>)}</div></section>

      <section className="download-section" id="download" data-motion-region><div className="download-glow" aria-hidden="true"/><BotSculpture className="download-bot"/><div data-reveal><p className="section-kicker">{copy.downloadKicker}</p><h2>{copy.downloadTitle[0]}<br/>{copy.downloadTitle[1]}</h2><a className="button button-primary" href={download} target="_blank" rel="noopener noreferrer"><Icon name="windows" size={18}/>{copy.downloadWindows}<Icon name="arrow" size={18}/></a><p className="download-meta">v{version}<span>·</span><a href={macGuide} target="_blank" rel="noopener noreferrer">{copy.macPreview}</a></p></div></section>
    </main>
    <footer className="site-footer"><div className="section-shell footer-inner"><a href="#" aria-label={copy.home}><img src={logoLight} width="136" height="39" alt="AelionBot"/></a><p>{copy.footerTagline}</p><nav aria-label={copy.footerNav}><a href={`/blog/?lang=${language}`}>{copy.blog}</a><a href={site.repository} target="_blank" rel="noopener noreferrer">GitHub</a><a href={`${site.repository}/releases`} target="_blank" rel="noopener noreferrer">{language==='en'?'Releases':language==='zh-TW'?'版本更新':'版本更新'}</a><a href={`${site.repository}/issues`} target="_blank" rel="noopener noreferrer">{language==='en'?'Feedback':language==='zh-TW'?'回報建議':'反馈建议'}</a></nav><span>© {new Date().getFullYear()} AelionBot</span></div></footer>
    <dialog ref={gallery} className="screenshot-dialog" aria-labelledby="gallery-title" onClose={()=>setShot(null)} onClick={event=>{if(event.target===event.currentTarget)setShot(null);}} onKeyDown={event=>{if(event.key==='ArrowLeft'){event.preventDefault();changeShot(-1);}else if(event.key==='ArrowRight'){event.preventDefault();changeShot(1);}}}>
      {shot!==null&&<div className="gallery-content"><header><div><span>{scenes.caption}</span><h2 id="gallery-title">{screenshots[shot].title}</h2></div><button className="icon-button" autoFocus onClick={()=>setShot(null)} aria-label={copy.closeScreenshot}><Icon name="close"/></button></header><div className="gallery-artwork" tabIndex={0} role="region" aria-label={screenshots[shot].alt}><img src={screenshots[shot].src} alt={screenshots[shot].alt}/></div><p className="gallery-pan-hint">{language==='en'?'Swipe to explore the details':language==='zh-TW'?'滑動查看細節':'滑动查看细节'}</p><footer><button className="icon-button previous-shot" onClick={()=>changeShot(-1)} aria-label={copy.previousScreenshot}><Icon name="arrow"/></button><span>{shot+1} / {screenshots.length}</span><button className="icon-button" onClick={()=>changeShot(1)} aria-label={copy.nextScreenshot}><Icon name="arrow"/></button></footer></div>}
    </dialog>
  </div>;
}
