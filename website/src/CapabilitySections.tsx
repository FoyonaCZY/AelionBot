import {useState,type CSSProperties} from 'react';
import type {SiteLanguage} from './site-i18n';
import {capabilityCopy,featuredSystems} from './capability-content';
import './capabilities.css';

export function CapabilitySections({language,part='core'}:{language:SiteLanguage;part?:'core'|'design'}){
 const copy=capabilityCopy[language],[selected,setSelected]=useState(3),system=featuredSystems[selected];
 return <div className="capabilities">
  {part==='core'&&<>
  <nav className="capability-jump section-shell" aria-label={language==='en'?'Explore capabilities':'探索功能'}>{copy.nav.map((label,index)=><a key={label} href={'#'+['group-chat','vm','design-systems'][index]}><span>0{index+1}</span>{label}<span aria-hidden="true">↗</span></a>)}</nav>
  <section className="capability-section section-shell" id="group-chat" aria-labelledby="group-chat-title">
   <div className="capability-copy"><p className="section-kicker">{copy.group.kicker}</p><h2 id="group-chat-title">{copy.group.title}</h2><p className="capability-description">{copy.group.description}</p><ul>{copy.group.points.map(point=><li key={point}>{point}</li>)}</ul><p className="capability-note">{copy.group.note}</p></div>
   <figure className="capability-visual cap-group"><div className="cap-group-thread"><header><span className="cap-group-dots" aria-hidden="true"><i/><i/><i/></span><strong>{copy.groupLabel}</strong></header><ol>{[copy.user,copy.researcher,copy.analyst].map((name,index)=><li key={name} className={'cap-chat-'+index}><span className="cap-avatar" aria-hidden="true"><i/><i/></span><div><span className="cap-chat-name">{name}</span><p>{copy.messages[index]}</p>{index>0&&<span className="cap-chat-file">▤ {index===1?'research.md':'comparison.xlsx'}</span>}</div></li>)}</ol><div className="cap-group-footer">{copy.handoff}<span aria-hidden="true">↗</span></div></div><figcaption>{copy.vmStatus}</figcaption></figure>
  </section>  <div className="cap-vm-band"><section className="capability-section section-shell cap-reversed" id="vm" aria-labelledby="vm-title">
   <div className="capability-copy"><p className="section-kicker">{copy.vm.kicker}</p><h2 id="vm-title">{copy.vm.title}</h2><p className="capability-description">{copy.vm.description}</p><ul>{copy.vm.points.map(point=><li key={point}>{point}</li>)}</ul><p className="capability-note">{copy.vm.note}</p></div>
   <figure className="capability-visual cap-computer"><div className="cap-computer-frame"><header><span className="cap-window-dots" aria-hidden="true"><i/><i/><i/></span><span>Linux</span><span>VM</span></header><div className="cap-desktop"><div className="cap-file-window"><span>{copy.workspace}</span><div>▤ <span>sources.csv</span></div><div>▤ <span>research.md</span></div><div>▤ <span>summary.pdf</span></div></div><div className="cap-terminal"><header><span>{copy.terminal}</span><span aria-hidden="true">⌘</span></header><pre><span>$ python summarize.py</span>{'\n\n'}<span className="cap-terminal-muted">3 sources processed</span>{'\n'}<span className="cap-terminal-result">→ research.md</span>{'\n'}<span className="cap-terminal-result">→ sources.csv</span></pre></div><div className="cap-desktop-dock" aria-hidden="true"><i>◎</i><i>▱</i><i>›_</i></div></div></div><figcaption>{copy.vmLabel} · {copy.vmStatus}</figcaption></figure>
  </section></div>
  </>}
  {part==='design'&&<>
  <section className="capability-section section-shell" id="design-systems" aria-labelledby="design-systems-title">
   <div className="capability-copy"><p className="section-kicker">{copy.design.kicker}</p><h2 id="design-systems-title">{copy.design.title}</h2><p className="capability-description">{copy.design.description}</p><ul>{copy.design.points.map(point=><li key={point}>{point}</li>)}</ul><p className="capability-note">{copy.design.note}</p></div>
   <figure className="capability-visual cap-design" style={{'--sample-accent':system.accent,'--sample-surface':system.surface} as CSSProperties}>
    <div className="cap-catalog"><header><strong>152</strong><span>{copy.systemLabel}</span><span className="cap-stack" aria-hidden="true">▱</span></header><div className="cap-system-options" role="group" aria-label={copy.systemLabel}>{featuredSystems.map((item,index)=><button key={item.name} aria-pressed={selected===index} onClick={()=>setSelected(index)}><span className="cap-swatches" aria-hidden="true">{item.colors.map(color=><i key={color} style={{background:color}}/>)}</span><span>{item.name}</span></button>)}</div></div>
    <div className="cap-design-sample"><div className="cap-sample-top"><span>{copy.prototype}</span><span>{copy.deck}</span></div><div className="cap-sample-body"><div><span className="cap-sample-label">{system.name}</span><h3>{copy.sampleTitle}</h3><span className="cap-sample-action">{copy.sampleAction} ↗</span></div><div className="cap-sample-art" aria-hidden="true"><i/><i/><i/></div></div></div>
    <figcaption>{copy.vmStatus} · {copy.systemHint}</figcaption>
   </figure>
  </section>
  </>}
 </div>;
}
