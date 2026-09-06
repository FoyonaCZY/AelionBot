import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import logoLight from '../../docs/assets/logo-light.svg';
import teamScreenshot from '../../docs/assets/screenshots/bot-team.png';
import groupScreenshot from '../../docs/assets/screenshots/group-chat.png';
import computerScreenshot from '../../docs/assets/screenshots/computer.png';
import attachmentsScreenshot from '../../docs/assets/screenshots/attachments.png';
import memoryScreenshot from '../../docs/assets/screenshots/memory.png';
import scheduleScreenshot from '../../docs/assets/screenshots/scheduled-tasks.png';
import {version} from '../../package.json';
import {resetSurface,trackSurface,useMotionPreference,useSiteMotion} from './useSiteMotion';
import site from '../site.json';

const repository=site.repository;
const download=`${repository}/releases/latest`;

const screenshots=[
  {src:teamScreenshot,title:'认识新伙伴',description:'给 Bot 起个名字，说明它负责的事情。'},
  {src:groupScreenshot,title:'把伙伴拉进同一个群',description:'和多位 Bot 一起讨论，让不同的分工接上彼此的进展。'},
  {src:computerScreenshot,title:'伙伴的工作电脑',description:'查看正在使用的浏览器和应用，需要时也可以亲自接管。'},
  {src:attachmentsScreenshot,title:'带着资料沟通',description:'把文件或图片放进对话，让伙伴结合实际材料处理任务。'},
  {src:memoryScreenshot,title:'保留协作中的记忆',description:'已确认的偏好和工作经验，可以留给下一次任务。'},
  {src:scheduleScreenshot,title:'把事情安排进日程',description:'在对话中说明任务和时间，让例行工作按计划执行。'},
];

const examples=[
  {tab:'准备分享',group:'分享准备小组',title:'准备一场分享',description:'资料、提纲和讲稿，交给几位搭档一起准备。',prompt:'这几份资料，帮我整理成一份\n10 分钟的分享稿。',attachment:'分享资料.zip',attachmentMeta:'3 个文件',firstName:'资料助手',firstReply:'我先核对资料，把关键数据和来源整理出来。',handoff:'资料已交给写作伙伴',secondName:'写作伙伴',secondReply:'讲稿已经整理好了，重点放在前三分钟。',file:'周会分享稿.docx',fileMeta:'讲稿与提纲 · 已整理',reviewer:'校对伙伴',review:'正在检查引用和遗漏',color:'#8b6bea'},
  {tab:'整理报表',group:'本周报表小组',title:'读懂一周的数据',description:'先把材料整理清楚，再看看哪些变化值得关注。',prompt:'核对这两份表格，\n整理本周的数据变化。',attachment:'本周业务数据.zip',attachmentMeta:'2 份表格',firstName:'数据助手',firstReply:'先核对日期、重复记录和金额，统一统计口径。',handoff:'汇总数据已交给分析伙伴',secondName:'分析伙伴',secondReply:'汇总表整理好了，我标出了本周变化较大的项目。',file:'本周数据汇总.xlsx',fileMeta:'数据与分析 · 已汇总',reviewer:'检查伙伴',review:'正在复核异常数据',color:'#279a80'},
  {tab:'制作工具',group:'小工具制作小组',title:'做一个顺手的小工具',description:'从一个具体需求开始，和伙伴一起边做边调整。',prompt:'帮我做一个简单的计时网页，\n准备演讲时可以打开用。',attachment:'需求说明.md',attachmentMeta:'需求文件',firstName:'产品伙伴',firstReply:'先明确开始、暂停和重置，让界面保持简单。',handoff:'需求已交给代码伙伴',secondName:'代码伙伴',secondReply:'计时网页已经做好了，可以继续修改文字和配色。',file:'演讲计时器.html',fileMeta:'可继续修改 · 浏览器打开',reviewer:'测试伙伴',review:'正在检查操作和显示效果',color:'#3888d7'},
];

const questions=[
  {question:'我可以给不同的 Bot 安排不同职责吗？',answer:'可以。为每位 Bot 设置名字和职责，也可以分别选择适合它的模型。你可以单独交代任务，或把几位伙伴拉进同一个群里配合。'},
  {question:'Bot 会直接操作我的电脑吗？',answer:'每位 Bot 都有自己的工作电脑。访问本机文件或执行本机操作时，会按照你的权限设置提出确认；允许的范围可以调整。工作电脑也可以由你随时接管。'},
  {question:'定时任务需要一直开着应用吗？',answer:'需要在执行时保持客户端运行。你可以给单个 Bot 或群聊安排一次性任务，也可以按每天、每周或固定间隔重复执行。'},
  {question:'现在支持什么设备，怎么开始？',answer:'目前提供 Windows 桌面客户端。下载安装后，在设置里连接想使用的模型，再给 Bot 安排职责。首次使用工作电脑时，应用会引导你完成准备。'},
];

type IconName='arrow'|'down'|'windows'|'github'|'message'|'computer'|'file'|'check'|'clock'|'plus'|'close'|'menu'|'folder'|'link'|'expand'|'sparkle'|'replay';
function Icon({name,size=20}:{name:IconName;size?:number}){
  const paths:Record<IconName,ReactNode>={
    arrow:<path d="M4 12h15m-6-6 6 6-6 6"/>,
    down:<path d="M12 4v15m-6-6 6 6 6-6"/>,
    windows:<path d="m3 5 8-1v7H3zm10-1 8-1v8h-8zM3 13h8v7l-8-1zm10 0h8v8l-8-1z" fill="currentColor" stroke="none"/>,
    github:<path d="M9 19c-4 1-4-2-6-2m12 5v-3.4c.1-1-.3-1.7-.7-2.1 2.5-.3 5.2-1.2 5.2-5.7 0-1.3-.5-2.3-1.2-3.1.1-.3.5-1.5-.1-3.1 0 0-1-.3-3.3 1.2a11.4 11.4 0 0 0-6 0C6.6 4.3 5.6 4.6 5.6 4.6c-.6 1.6-.2 2.8-.1 3.1-.7.8-1.2 1.8-1.2 3.1 0 4.5 2.7 5.4 5.2 5.7-.3.3-.7.9-.7 1.7V22"/>,
    message:<><path d="M21 11.5a8 8 0 0 1-8 8H5l-3 2V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8.5Z"/><path d="M7 8.5h9M7 12.5h6"/></>,
    computer:<><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8m-4-4v4"/></>,
    file:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"/><path d="M8 13h8M8 17h5"/></>,
    check:<path d="m5 12 4 4L19 6"/>,
    clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    plus:<path d="M5 12h14M12 5v14"/>,
    close:<path d="m6 6 12 12M18 6 6 18"/>,
    menu:<path d="M4 7h16M4 12h16M4 17h16"/>,
    folder:<path d="M3 6h7l2 3h9v11H3z"/>,
    link:<><path d="m10 13 4-4m-7 6-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m4 0 1-1a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0"/></>,
    expand:<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/>,
    sparkle:<><path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2Z"/><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6Z"/></>,
    replay:<><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function BotAvatar({color='purple',className=''}:{color?:'purple'|'blue'|'green'|'orange';className?:string}){
  const palette={purple:'#8b6bea',blue:'#268bfa',green:'#19a887',orange:'#ed8c35'};
  return <svg className={`bot-avatar ${className}`} viewBox="0 0 60 60" aria-hidden="true"><path d="M31 3C47 3 56 14 56 31C56 46 46 56 29 56C12 56 4 46 4 30C4 14 15 3 31 3Z" fill={palette[color]}/><g className="bot-eye-direction"><g className="bot-eyes"><ellipse cx="24" cy="26" rx="2.5" ry="5" fill="white" transform="rotate(-14 24 26)"/><ellipse cx="36" cy="24" rx="2.5" ry="5" fill="white" transform="rotate(-14 36 24)"/></g></g></svg>;
}

function TeamFaces(){return <span className="team-faces"><BotAvatar color="blue"/><BotAvatar color="green"/><BotAvatar/></span>;}

function DownloadLink({className='',children='下载 Windows 版'}:{className?:string;children?:ReactNode}){
  return <a className={`button button-primary ${className}`} href={download} target="_blank" rel="noreferrer"><Icon name="windows" size={18}/>{children}<Icon name="arrow" size={18}/></a>;
}

function CollaborationPreview({active,onChange}:{active:number;onChange:(index:number)=>void}){
  const example=examples[active];
  const [replay,setReplay]=useState(0);
  return <div className="collaboration-stage" data-reveal="rise" data-delay="2" data-motion-region onPointerMove={trackSurface} onPointerLeave={resetSurface}>
    <div className="visual-halo" aria-hidden="true"/>
    <svg className="collaboration-connections" viewBox="0 0 620 640" fill="none" aria-hidden="true"><path className="connection-base" d="M32 112C100 112 32 205 110 205M571 231C631 301 570 362 510 362M45 552C-15 469 75 444 106 444"/><path className="connection-flow" d="M32 112C100 112 32 205 110 205M571 231C631 301 570 362 510 362M45 552C-15 469 75 444 106 444"/></svg>
    <div className="orbit-node orbit-node-one" aria-hidden="true"><BotAvatar color="blue"/><span>{example.firstName}</span><i/></div>
    <div className="orbit-node orbit-node-two" aria-hidden="true"><BotAvatar color="green"/><span>{example.secondName}</span><i/></div>
    <div className="orbit-node orbit-node-three" aria-hidden="true"><BotAvatar/><span>{example.reviewer}</span><i/></div>
    <div className="collaboration-preview" id="team" aria-label="Bot 团队协作示例">
    <div className="preview-caption"><span><span className="live-dot"/>小组已就位</span><span>协作示例</span><button className="replay-button" onClick={()=>setReplay(value=>value+1)} aria-label="重新播放协作示例" title="重新播放"><Icon name="replay" size={15}/></button></div>
    <div className="demo-tabs" role="tablist" aria-label="选择协作示例">{examples.map((item,index)=><button key={item.tab} id={`demo-tab-${index}`} role="tab" aria-selected={index===active} aria-controls="demo-panel" tabIndex={index===active?0:-1} onClick={()=>onChange(index)} onKeyDown={event=>{
      let next=index;if(event.key==='ArrowRight')next=(index+1)%examples.length;else if(event.key==='ArrowLeft')next=(index+examples.length-1)%examples.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=examples.length-1;else return;
      event.preventDefault();onChange(next);document.getElementById(`demo-tab-${next}`)?.focus();
    }}>{item.tab}</button>)}</div>
    <div className="chat-window" id="demo-panel" role="tabpanel" aria-labelledby={`demo-tab-${active}`}>
      <div className="chat-titlebar"><span className="group-avatar"><BotAvatar color="blue"/><BotAvatar color="green"/><BotAvatar/></span><div><strong>{example.group}</strong><span>你和 3 位工作伙伴</span></div><span className="window-more" aria-hidden="true"><i/><i/><i/></span></div>
      <div className="chat-demo-content" key={`${active}-${replay}`}>
        <div className="demo-user story-step story-step-one"><span className="chat-time">你的一句话，工作的开始。</span><p>{example.prompt}</p><div className="demo-attachment"><Icon name="file" size={15}/>{example.attachment}<span>{example.attachmentMeta}</span></div></div>
        <div className="demo-reply story-step story-step-two"><BotAvatar color="blue"/><div><span className="reply-name">{example.firstName}<span>整理资料</span></span><p>{example.firstReply}</p></div></div>
        <div className="handoff-note story-step story-step-three"><span className="handoff-track" aria-hidden="true"><i/></span><Icon name="link" size={12}/>{example.handoff}<span className="handoff-track" aria-hidden="true"><i/></span></div>
        <div className="demo-reply story-step story-step-four"><BotAvatar color="green"/><div><span className="reply-name">{example.secondName}<span>接力完成</span></span><p>{example.secondReply}</p><div className="demo-file"><span><Icon name="file" size={22}/></span><div><strong>{example.file}</strong><small>{example.fileMeta}</small></div><span className="file-check"><Icon name="check" size={15}/></span></div></div></div>
        <div className="demo-review story-step story-step-five"><BotAvatar/><span><strong>{example.reviewer}</strong> {example.review}<span className="typing-dots" aria-hidden="true"><i/><i/><i/></span></span></div>
      </div>
      <div className="demo-composer"><span>一起讨论，让工作继续。</span><span className="composer-arrow"><Icon name="arrow" size={15}/></span></div>
    </div>
    <div className="preview-footnote"><Icon name="computer" size={16}/><span>各自的工作电脑，共同推进的任务。</span></div>
    </div>
  </div>;
}

function QuestionItem({item,index}:{item:typeof questions[number];index:number}){
  const [open,setOpen]=useState(false);
  return <div className={`question-item ${open?'is-open':''}`}><button aria-expanded={open} aria-controls={`question-answer-${index}`} onClick={()=>setOpen(value=>!value)}>{item.question}<span><Icon name="plus" size={19}/></span></button><div id={`question-answer-${index}`} className="question-answer" aria-hidden={!open}><div><p>{item.answer}</p></div></div></div>;
}

export default function App(){
  const siteRoot=useRef<HTMLDivElement>(null);
  const motion=useMotionPreference();
  useSiteMotion(siteRoot,motion.enabled);
  const [menuOpen,setMenuOpen]=useState(false);
  const [activeExample,setActiveExample]=useState(0);
  const [shot,setShot]=useState<number|null>(null);
  const gallery=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    if(!menuOpen)return;
    const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setMenuOpen(false);};
    const outside=(event:PointerEvent)=>{if(!(event.target as HTMLElement).closest('.site-header'))setMenuOpen(false);};
    document.addEventListener('keydown',close);document.addEventListener('pointerdown',outside);
    return()=>{document.removeEventListener('keydown',close);document.removeEventListener('pointerdown',outside);};
  },[menuOpen]);
  useEffect(()=>{
    const dialog=gallery.current;if(!dialog)return;
    if(shot===null){if(dialog.open)dialog.close();return;}
    if(!dialog.open)dialog.showModal();
    const overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    return()=>{document.body.style.overflow=overflow;};
  },[shot]);
  const showExample=(index:number)=>{setActiveExample(index);document.getElementById('team')?.scrollIntoView({block:'center',behavior:motion.enabled?'smooth':'instant'});};
  const changeShot=(step:number)=>setShot(index=>index===null?0:(index+step+screenshots.length)%screenshots.length);
  return <div ref={siteRoot} className="site-app" data-motion={motion.enabled?'on':'off'}>
    <div className="reading-progress" aria-hidden="true"/>
    <a className="skip-link" href="#main">跳至主要内容</a>
    <header className="site-header"><div className="nav-shell">
      <a href="#" className="brand-link" aria-label="AelionBot 首页"><img src={logoLight} width="163" height="46" alt="AelionBot"/></a>
      <nav id="main-navigation" className={menuOpen?'main-nav is-open':'main-nav'} aria-label="主导航">{site.navigation.map(link=><a key={link.href} href={link.href} onClick={()=>setMenuOpen(false)} {...(link.external?{target:'_blank',rel:'noreferrer'}:{})}>{link.label}{link.external&&<Icon name="arrow" size={14}/>}</a>)}</nav>
      <DownloadLink className="nav-download">下载应用</DownloadLink>
      <button className="mobile-menu-button" aria-label={menuOpen?'关闭导航':'打开导航'} aria-controls="main-navigation" aria-expanded={menuOpen} onClick={()=>setMenuOpen(!menuOpen)}><Icon name={menuOpen?'close':'menu'}/></button>
    </div></header>
    <main id="main">
      <section className="hero-section" aria-labelledby="hero-title" data-motion-region>
        <div className="hero-atmosphere" aria-hidden="true"><div className="aura aura-purple"/><div className="aura aura-blue"/><div className="hero-grid"/><span className="ambient-spark spark-one"/><span className="ambient-spark spark-two"/><span className="ambient-spark spark-three"/></div>
        <div className="hero section-shell">
        <div className="hero-copy">
          <div className="eyebrow" data-reveal="rise"><span className="eyebrow-icon"><Icon name="sparkle" size={13}/></span>YOUR OWN LITTLE TEAM</div>
          <h1 id="hero-title" data-reveal="rise" data-delay="1"><span className="hero-title-line">一个想法，</span><span className="hero-title-line">一群<em>好搭档</em>。</span></h1>
          <p className="hero-description" data-reveal="rise" data-delay="2">让擅长不同事情的 Bot 组成团队。<br className="desktop-break"/>从一段对话开始，一起把事情做出来。</p>
          <div className="hero-actions" data-reveal="rise" data-delay="3"><DownloadLink/><button className="button button-secondary" onClick={()=>setShot(1)}>查看真实界面<Icon name="expand" size={17}/></button></div>
          <div className="hero-meta" data-reveal="rise" data-delay="3"><span>Windows 桌面应用</span><span>v{version}</span><a href={repository} target="_blank" rel="noreferrer">GitHub<Icon name="arrow" size={13}/></a></div>
          <div className="hero-team" data-reveal="rise" data-delay="4"><TeamFaces/><p>各有分工，也有默契。<br/><span>和你的下一支小团队，打个照面。</span></p></div>
        </div>
        <CollaborationPreview active={activeExample} onChange={setActiveExample}/>
        </div>
      </section>
      <div className="intro-strip section-shell" data-reveal="rise"><p><span className="strip-icon"><Icon name="message"/></span><span>把需求说清楚</span></p><span className="strip-connector" aria-hidden="true"><i/></span><p><TeamFaces/><span>让伙伴各展所长</span></p><span className="strip-connector" aria-hidden="true"><i/></span><p><span className="strip-icon"><Icon name="folder"/></span><span>一起把成果做出来</span></p></div>

      <section className="features section-shell" id="features">
        <div className="section-heading" data-reveal="rise"><div><span className="section-kicker">MEET YOUR TEAM</span><h2>各有本事，<br/><span>一起做事。</span></h2></div><p>你提出想法，判断方向。<br/>伙伴们带着分工、记忆和工作电脑，<br className="desktop-break"/>接住接下来的工作。</p></div>
        <div className="computer-feature interactive-surface" data-reveal="rise" data-motion-region onPointerMove={trackSurface} onPointerLeave={resetSurface}>
          <div className="feature-copy"><span className="feature-number">01 / 自己的工作电脑</span><h3>会浏览网页，<br/>也会动手处理文件。</h3><p>每位 Bot 都有独立的工作桌面，可以使用浏览器和应用完成任务。你能看见工作进展，需要时也能亲自接管。</p><ul className="quiet-list"><li><Icon name="check" size={17}/>浏览资料，处理文档与表格</li><li><Icon name="check" size={17}/>各自保留工作文件和记录</li><li><Icon name="check" size={17}/>随时查看，也能交回你的手里</li></ul><button className="text-link" onClick={()=>setShot(2)}>走进伙伴的工作电脑<Icon name="arrow" size={17}/></button></div>
          <button className="computer-visual screenshot-button" onClick={()=>setShot(2)} aria-label="放大查看工作电脑截图"><span className="screen-topline"><span className="screen-dots" aria-hidden="true"><i/><i/><i/></span><span>伙伴的工作电脑</span><Icon name="expand" size={15}/></span><span className="computer-screenshot"><img src={computerScreenshot} width="2560" height="1440" loading="lazy" alt="AelionBot 工作电脑中打开的浏览器和应用入口"/></span><span className="screen-bottomline"><span className="live-dot"/>独立的工作空间<span>真实应用界面</span></span></button>
        </div>
        <div className="continuity-grid">
          <article className="continuity-card memory-feature interactive-surface" data-reveal="rise" data-motion-region onPointerMove={trackSurface} onPointerLeave={resetSurface}><div className="continuity-text"><span className="feature-number"><Icon name="sparkle" size={15}/>02 / 合作中的记忆</span><h3>默契，留给下一次。</h3><p>已经确认的偏好和项目信息，可以留给下一次任务。伙伴也会积累处理同类工作的经验。</p><button className="text-link" onClick={()=>setShot(4)}>看看伙伴记住了什么<Icon name="arrow" size={17}/></button></div><div className="memory-example" aria-label="伙伴记忆示例"><div className="memory-example-heading"><BotAvatar/><span>写作伙伴的笔记</span><span>示例</span></div><p><span className="memory-dot"/>周报先给结论，再补充依据。<span className="memory-tick"><Icon name="check" size={14}/></span></p><p><span className="memory-dot"/>这个项目面向第一次接触产品的读者。<span className="memory-tick"><Icon name="check" size={14}/></span></p><span className="memory-example-footer"><span className="live-dot"/>熟悉的合作方式，会留在这里。</span></div></article>
          <article className="continuity-card schedule-feature interactive-surface" data-reveal="rise" data-delay="1" data-motion-region onPointerMove={trackSurface} onPointerLeave={resetSurface}><div className="continuity-text"><span className="feature-number"><Icon name="clock" size={15}/>03 / 按时开始的任务</span><h3>例行工作，提前安排。</h3><p>给单个 Bot 或群聊约定任务和时间。一次执行，或每天、每周重复，都能在同一个地方管理。</p><button className="text-link" onClick={()=>setShot(5)}>看看怎样安排任务<Icon name="arrow" size={17}/></button></div><div className="schedule-example" aria-label="每周任务示例"><div className="schedule-week" aria-hidden="true">{['一','二','三','四','五','六','日'].map(day=><span key={day} className={day==='五'?'is-scheduled':''}>{day==='五'&&<i/>}{day}</span>)}</div><div className="schedule-event"><div className="schedule-date"><span>每周五</span><strong>16<span>:00</span></strong></div><div className="schedule-task"><span>整理本周项目记录</span><p>汇总进展，列出下周待办。</p><div><BotAvatar color="green"/><span>交给项目伙伴</span><Icon name="check" size={15}/></div></div></div></div><p className="schedule-note">按计划执行时，需要保持客户端开启。</p></article>
        </div>
        <div className="feature-note" data-reveal="rise"><span><Icon name="file" size={20}/>把资料带进对话，把成果保存下来。</span><button className="text-link" onClick={()=>setShot(3)}>查看文件与附件<Icon name="arrow" size={16}/></button></div>
      </section>

      <section className="scenarios-section" id="scenarios"><div className="section-shell">
        <div className="section-heading" data-reveal="rise"><div><span className="section-kicker">START WITH SOMETHING REAL</span><h2>下一件事，<br/><span>可以这样开始。</span></h2></div><p>从手头的一件具体工作开始。<br/>在讨论中补充，在配合中调整，<br/>让想法一步步有了样子。</p></div>
        <div className="scenario-grid">{examples.map((example,index)=><article key={example.tab} className="scenario-card interactive-surface" data-reveal="rise" data-delay={index} onPointerMove={trackSurface} onPointerLeave={resetSurface} style={{'--case-accent':example.color} as CSSProperties}><div className="scenario-top"><span>0{index+1}</span><span className="scenario-mascot"><BotAvatar color={index===0?'purple':index===1?'green':'blue'}/></span></div><h3>{example.title}</h3><p>{example.description}</p><blockquote>{example.prompt.replace('\n','')}</blockquote><button onClick={()=>showExample(index)}>看看如何分工<span><Icon name="arrow" size={19}/></span></button></article>)}</div>
        <div className="scenario-footnote"><TeamFaces/><span>一位伙伴也能开始，多位伙伴可以一起配合。</span></div>
      </div></section>

      <section className="questions-section section-shell" id="questions"><div className="questions-intro" data-reveal="rise"><span className="section-kicker">GOOD TO KNOW</span><h2>开始之前，<br/>你可能想知道。</h2><p>还有其他想法？<br/>欢迎在 <a href={`${repository}/issues`} target="_blank" rel="noreferrer">GitHub</a> 和我们聊聊。</p></div><div className="question-list" data-reveal="rise" data-delay="1">{questions.map((item,index)=><QuestionItem key={item.question} item={item} index={index}/>)}</div></section>

      <section className="closing-section section-shell" data-reveal="rise" data-motion-region><div className="closing-inner"><div className="closing-orbits" aria-hidden="true"><i/><i/><i/></div><div className="closing-avatars"><BotAvatar color="blue"/><BotAvatar color="green"/><BotAvatar/></div><span className="section-kicker">LET'S GET SOMETHING DONE</span><h2>给下一个想法，<br/>找几位好搭档。</h2><p>你的桌面，可以多一个工作团队。</p><DownloadLink>和伙伴一起开始</DownloadLink><span className="closing-meta">AelionBot v{version} · Windows</span></div></section>
    </main>
    <footer className="site-footer"><div className="section-shell footer-inner"><a href="#" aria-label="返回 AelionBot 首页"><img src={logoLight} width="145" height="41" alt="AelionBot"/></a><p>好想法，值得一起做。</p><nav aria-label="页脚导航"><a href="/blog/">博客</a><a href={repository} target="_blank" rel="noreferrer">GitHub<Icon name="arrow" size={13}/></a><a href={`${repository}/releases`} target="_blank" rel="noreferrer">版本更新</a><a href={`${repository}/issues`} target="_blank" rel="noreferrer">反馈建议</a></nav><span>© {new Date().getFullYear()} AelionBot</span></div></footer>

    <dialog ref={gallery} className="screenshot-dialog" aria-labelledby="gallery-title" onClose={()=>setShot(null)} onClick={event=>{if(event.target===event.currentTarget)setShot(null);}} onKeyDown={event=>{if(event.key==='ArrowLeft'){event.preventDefault();changeShot(-1);}else if(event.key==='ArrowRight'){event.preventDefault();changeShot(1);}}}>
      {shot!==null&&<div className="gallery-content"><header className="gallery-header"><div><span>真实应用截图 · {shot+1} / {screenshots.length}</span><h2 id="gallery-title">{screenshots[shot].title}</h2></div><button className="icon-button gallery-close" autoFocus onClick={()=>setShot(null)} aria-label="关闭截图"><Icon name="close" size={22}/></button></header><div className="gallery-image"><img src={screenshots[shot].src} alt={screenshots[shot].description}/></div><div className="gallery-description"><button className="icon-button previous-shot" onClick={()=>changeShot(-1)} aria-label="上一张截图"><Icon name="arrow"/></button><p>{screenshots[shot].description}</p><button className="icon-button" onClick={()=>changeShot(1)} aria-label="下一张截图"><Icon name="arrow"/></button></div><nav className="gallery-navigation" aria-label="选择应用截图">{screenshots.map((item,index)=><button key={item.src} onClick={()=>setShot(index)} className={index===shot?'is-active':''} aria-current={index===shot?'true':undefined}>{['创建伙伴','团队群聊','工作电脑','文件附件','协作记忆','定时任务'][index]}</button>)}</nav></div>}
    </dialog>
  </div>;
}
