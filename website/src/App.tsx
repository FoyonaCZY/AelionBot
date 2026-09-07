import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import logoLight from '../../docs/assets/logo-light.svg';
import logoDark from '../../docs/assets/logo-dark.svg';
import conversation from '../../docs/assets/product/conversation.png';
import collaboration from '../../docs/assets/product/collaboration.png';
import {version} from '../../package.json';
import {BotSculpture,tones,type BotTone} from './BotSculpture';
import {questions,workExamples} from './product-content';
import {resetSurface,trackSurface,useMotionPreference,useSiteMotion} from './useSiteMotion';
import site from '../site.json';

const download=`${site.repository}/releases/latest`;
const macGuide=`${site.repository}/blob/main/docs/releases/v0.6.0.md`;
const screenshots=[{src:conversation,title:'和一位伙伴，把事情做完',alt:'AelionBot 当前版本的写作对话，展示分享讲稿和可保存的文件。'}, {src:collaboration,title:'让不同的伙伴，一起配合',alt:'AelionBot 当前版本的群聊，资料、灵感和写作伙伴共同准备分享讲稿。'}];
type IconName='arrow'|'down'|'plus'|'close'|'menu'|'expand'|'file'|'check'|'windows';
function Icon({name,size=20}:{name:IconName;size?:number}){
  const paths:Record<IconName,ReactNode>={arrow:<path d="M4 12h15m-6-6 6 6-6 6"/>,down:<path d="M12 4v15m-6-6 6 6 6-6"/>,plus:<path d="M5 12h14M12 5v14"/>,close:<path d="m6 6 12 12M18 6 6 18"/>,menu:<path d="M4 8h16M4 16h16"/>,expand:<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/>,file:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"/><path d="M8 13h8M8 17h5"/></>,check:<path d="m5 12 4 4L19 6"/>,windows:<path d="m3 5 8-1v7H3zm10-1 8-1v8h-8zM3 13h8v7l-8-1zm10 0h8v8l-8-1z" fill="currentColor" stroke="none"/>};
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function WorkOfArt(){
  return <div className="work-of-art" aria-label="资料、创意和文件成果的视觉演示">
    <div className="work-light"/>
    <div className="work-paper paper-back"><span>资料，变得有头绪。</span><div className="paper-chart" aria-hidden="true">{[35,59,45,75,61,90,73].map((height,index)=><i key={index} style={{'--bar-height':`${height}%`} as CSSProperties}/>)}</div><div className="paper-rule"/><div className="paper-rule short"/></div>
    <div className="work-paper paper-front"><span className="paper-overline">写下来的想法</span><h3>让灵感，<br/>有处可去。</h3><div className="paper-art" aria-hidden="true"><i/><i/><i/></div><div className="paper-rule"/><div className="paper-rule"/><div className="paper-rule short"/><span className="paper-page">01</span></div>
    <div className="work-delivery"><span className="delivery-icon"><Icon name="file" size={24}/></span><div><strong>分享讲稿</strong><span>准备好了，看看吧。</span></div><Icon name="check" size={19}/></div>
    <BotSculpture className="work-helper" tone="blue"/>
  </div>;
}

export default function App(){
  const root=useRef<HTMLDivElement>(null),gallery=useRef<HTMLDialogElement>(null),menuButton=useRef<HTMLButtonElement>(null);
  const motion=useMotionPreference();useSiteMotion(root,motion.enabled);
  const [menuOpen,setMenuOpen]=useState(false),[view,setView]=useState(1),[shot,setShot]=useState<number|null>(null),[tone,setTone]=useState<BotTone>('violet'),[example,setExample]=useState(0);
  const current=workExamples[example];
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
    <div className="reading-progress" aria-hidden="true"/><a className="skip-link" href="#main">跳至主要内容</a>
    <header className="site-header"><div className="nav-shell"><a className="brand-link" href="#" aria-label="AelionBot 首页"><img className="brand-on-light" src={logoLight} width="144" height="41" alt="AelionBot"/><img className="brand-on-dark" src={logoDark} width="144" height="41" alt=""/></a>
      <nav id="main-navigation" className={`main-nav ${menuOpen?'is-open':''}`} aria-label="主导航">{site.navigation.map(link=><a key={link.href} href={link.href} onClick={()=>setMenuOpen(false)} {...(link.external?{target:'_blank',rel:'noopener noreferrer'}:{})}>{link.label}</a>)}</nav>
      <a className="button nav-download" href="#download">下载应用</a><button ref={menuButton} className="mobile-menu-button" aria-label={menuOpen?'关闭导航':'打开导航'} aria-controls="main-navigation" aria-expanded={menuOpen} onClick={()=>setMenuOpen(value=>!value)}><Icon name={menuOpen?'close':'menu'}/></button>
    </div></header>
    <main id="main">
      <section className="hero-section" aria-labelledby="hero-title" data-motion-region data-scroll-scene="hero">
        <div className="hero-spotlight" aria-hidden="true"/><div className="hero-copy"><p className="eyebrow" data-reveal>AelionBot · 你的 AI 工作伙伴</p><h1 id="hero-title" data-reveal data-delay="1">好想法。<br/><span>一起做出来。</span></h1><p className="hero-description" data-reveal data-delay="2">让擅长不同事情的伙伴，来到你的桌面。</p><div className="hero-actions" data-reveal data-delay="3"><a href="#download" className="button button-primary">认识你的伙伴<Icon name="arrow" size={17}/></a><a href="#work" className="hero-more">看看怎么合作<Icon name="down" size={16}/></a></div></div>
        <div className="hero-cast" aria-hidden="true"><div className="cast-floor"/><div className="cast-member cast-blue"><BotSculpture tone="blue"/></div><div className="cast-member cast-mint"><BotSculpture tone="mint"/></div><div className="cast-member cast-violet"><BotSculpture/></div><span className="cast-caption">各有本事。一起做事。</span></div>
      </section>

      <section className="work-section section-shell" id="work" data-scroll-scene="showcase">
        <div className="section-heading centered" data-reveal><p className="section-kicker">从一句话开始</p><h2>聊着聊着，<br/>事情就做出来了。</h2><p>单独交代一件事，或让几位伙伴接力完成。</p></div>
        <div className="product-view-tabs" role="tablist" aria-label="查看产品界面">{['和伙伴聊聊','让团队一起做'].map((label,index)=><button key={label} id={`view-tab-${index}`} role="tab" aria-selected={view===index} aria-controls="product-view" tabIndex={view===index?0:-1} onClick={()=>setView(index)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:1-index;setView(next);document.getElementById(`view-tab-${next}`)?.focus();}}}>{label}</button>)}</div>
        <div className="product-stage" data-reveal><div className="product-stage-light" aria-hidden="true"/><div className="product-device" id="product-view" role="tabpanel" aria-labelledby={`view-tab-${view}`}><img key={view} src={screenshots[view].src} alt={screenshots[view].alt} width="962" height="720" loading="lazy"/><button className="product-expand" onClick={()=>setShot(view)} aria-label="放大查看产品界面"><Icon name="expand" size={18}/></button></div></div>
        <p className="product-caption">当前版本界面 · 示例任务</p>
      </section>

      <section className="making-section" data-scroll-scene="making" data-motion-region>
        <div className="making-sticky section-shell"><div className="making-copy" data-reveal><p className="section-kicker">会想，也会动手</p><h2>让成果，<br/>从对话里<br/><span>走出来。</span></h2><p>查资料、处理文件、使用应用。<br/>伙伴有自己的工作电脑。</p></div><WorkOfArt/></div>
      </section>

      <section className="personality-section section-shell" data-motion-region>
        <div className="personality-visual" style={{'--tone-light':tones[tone][0],'--tone-main':tones[tone][1]} as CSSProperties}><div className="personality-halo" aria-hidden="true"/><BotSculpture key={tone} tone={tone} className="personality-bot"/><div className="palette-options" role="group" aria-label="试试伙伴的配色">{(Object.keys(tones) as BotTone[]).map((value,index)=><button key={value} aria-label={['暮光紫','晴空蓝','薄荷绿','蜜桃粉'][index]} aria-pressed={tone===value} onClick={()=>setTone(value)} style={{'--swatch':`linear-gradient(140deg,${tones[value][0]},${tones[value][2]})`} as CSSProperties}/>)}</div><span className="palette-hint">点一点，换个心情。</span></div>
        <div className="personality-copy" data-reveal><p className="section-kicker">很有个性，也很合拍</p><h2>你的伙伴。<br/><span>你的样子。</span></h2><p>名字、职责、配色，都由你决定。<br/>写作搭档，资料助手，或随时陪你聊灵感的朋友。</p><div className="memory-note"><BotSculpture tone={tone} flat/><div><p>“下次，也用这套风格。”</p><span>记下你确认过的偏好，让合作接得上。</span></div></div></div>
      </section>

      <section className="possibilities-section" id="possibilities"><div className="section-shell"><div className="section-heading" data-reveal><p className="section-kicker">先从哪件事开始？</p><h2>你正好需要。<br/><span>它正好拿手。</span></h2></div>
        <div className="possibility-tabs" role="tablist" aria-label="选择应用场景">{workExamples.map((item,index)=><button key={item.name} id={`case-tab-${index}`} role="tab" aria-selected={example===index} aria-controls="case-panel" tabIndex={example===index?0:-1} onClick={()=>setExample(index)} onKeyDown={event=>{let next=index;if(event.key==='ArrowRight')next=(index+1)%workExamples.length;else if(event.key==='ArrowLeft')next=(index+workExamples.length-1)%workExamples.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=workExamples.length-1;else return;event.preventDefault();setExample(next);document.getElementById(`case-tab-${next}`)?.focus();}}>{item.name}</button>)}</div>
        <div id="case-panel" role="tabpanel" aria-labelledby={`case-tab-${example}`} className="case-panel" data-motion-region onPointerMove={trackSurface} onPointerLeave={resetSurface}><div className="case-copy" key={example}><span>试着这样开口</span><h3>{current.prompt}</h3><p>{current.result}</p></div><div className={`case-art case-${current.tone}`} aria-hidden="true"><BotSculpture tone={current.tone}/><div className="case-file"><Icon name="file" size={30}/><span>{current.file}</span><i><Icon name="check" size={15}/></i></div></div></div>
        <div className="everyday-note" data-reveal><span className="calendar-mini" aria-hidden="true"><span>每周</span><strong>五</strong></span><div><h3>每周的老任务，也有人惦记。</h3><p>约好时间，把周报、资料整理安排给伙伴。</p></div><a className="text-link" href="#questions">了解定时工作<Icon name="arrow" size={17}/></a></div>
      </div></section>

      <section className="questions-section section-shell" id="questions"><h2 data-reveal>还有几个小问题。</h2><div className="question-list">{questions.map(item=><details className="question-item" key={item.question}><summary>{item.question}<Icon name="plus" size={18}/></summary><p>{item.answer}</p></details>)}</div></section>

      <section className="download-section" id="download" data-motion-region><div className="download-glow" aria-hidden="true"/><BotSculpture className="download-bot"/><div data-reveal><p className="section-kicker">AelionBot</p><h2>下一件事，<br/>一起做。</h2><a className="button button-primary" href={download} target="_blank" rel="noopener noreferrer"><Icon name="windows" size={18}/>下载 Windows 版<Icon name="arrow" size={18}/></a><p className="download-meta">v{version}<span>·</span><a href={macGuide} target="_blank" rel="noopener noreferrer">Mac 预览版说明</a></p></div></section>
    </main>
    <footer className="site-footer"><div className="section-shell footer-inner"><a href="#" aria-label="AelionBot 首页"><img src={logoLight} width="136" height="39" alt="AelionBot"/></a><p>有想法，就一起动手。</p><nav aria-label="页脚导航"><a href="/blog/">博客</a><a href={site.repository} target="_blank" rel="noopener noreferrer">GitHub</a><a href={`${site.repository}/releases`} target="_blank" rel="noopener noreferrer">版本更新</a><a href={`${site.repository}/issues`} target="_blank" rel="noopener noreferrer">反馈建议</a></nav><span>© {new Date().getFullYear()} AelionBot</span></div></footer>
    <dialog ref={gallery} className="screenshot-dialog" aria-labelledby="gallery-title" onClose={()=>setShot(null)} onClick={event=>{if(event.target===event.currentTarget)setShot(null);}} onKeyDown={event=>{if(event.key==='ArrowLeft'){event.preventDefault();changeShot(-1);}else if(event.key==='ArrowRight'){event.preventDefault();changeShot(1);}}}>
      {shot!==null&&<div className="gallery-content"><header><div><span>真实产品界面 · 示例内容</span><h2 id="gallery-title">{screenshots[shot].title}</h2></div><button className="icon-button" autoFocus onClick={()=>setShot(null)} aria-label="关闭截图"><Icon name="close"/></button></header><img src={screenshots[shot].src} alt={screenshots[shot].alt}/><footer><button className="icon-button previous-shot" onClick={()=>changeShot(-1)} aria-label="上一张截图"><Icon name="arrow"/></button><span>{shot+1} / {screenshots.length}</span><button className="icon-button" onClick={()=>changeShot(1)} aria-label="下一张截图"><Icon name="arrow"/></button></footer></div>}
    </dialog>
  </div>;
}
