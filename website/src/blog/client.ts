import '../styles.css';
import './styles.css';
import '../site-i18n.css';
import {readSiteLanguage,rememberSiteLanguage} from '../locale.mjs';
import {blogText} from './labels.mjs';

let language=readSiteLanguage();
const languageSwitcher=document.querySelector<HTMLSelectElement>('.site-language-switcher');
const ui=(en:string,zh:string,tw=zh)=>language==='en'?en:language==='zh-TW'?tw:zh;
function localize(){
  document.documentElement.lang=language;
  if(languageSwitcher)languageSwitcher.value=language;
  document.querySelectorAll<HTMLElement>('[data-blog-label]').forEach(element=>{element.textContent=blogText(element.dataset.blogLabel!,language,element.dataset.count||'');});
  document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(link=>{
    const url=new URL(link.href);if(url.origin!==location.origin||!/^\/(?:blog(?:\/|$)|$)/.test(url.pathname))return;
    url.searchParams.set('lang',language);link.href=url.href;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-copy-code]').forEach(button=>{button.textContent=ui('Copy code','复制代码','複製程式碼');button.setAttribute('aria-label',button.textContent);});
  document.querySelectorAll<HTMLTimeElement>('time[datetime]').forEach(time=>{time.textContent=new Date(`${time.dateTime}T00:00:00Z`).toLocaleDateString(language,{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'});});
  const heading=document.querySelector('h1');
  if(heading)document.title=`${heading.innerText.replaceAll('\n',' ')} — AelionBot`;
  const description=document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if(!document.querySelector('.article-body')&&description)description.content=blogText('description',language);
  menu?.setAttribute('aria-label',ui('Open navigation','打开导航','開啟導覽'));
  rememberSiteLanguage(language);
}
languageSwitcher?.addEventListener('change',()=>{language=languageSwitcher.value;localize();});

const root=document.querySelector<HTMLElement>('.blog-site');
const menu=document.querySelector<HTMLButtonElement>('.mobile-menu-button');
const navigation=document.getElementById('main-navigation');

function closeMenu(){navigation?.classList.remove('is-open');menu?.setAttribute('aria-expanded','false');menu?.setAttribute('aria-label',ui('Open navigation','打开导航','開啟導覽'));}
menu?.addEventListener('click',()=>{
  const open=menu.getAttribute('aria-expanded')!=='true';
  navigation?.classList.toggle('is-open',open);menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?ui('Close navigation','关闭导航','關閉導覽'):ui('Open navigation','打开导航','開啟導覽'));
});
document.addEventListener('pointerdown',event=>{if(!(event.target as Element).closest('.site-header'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
navigation?.querySelectorAll('a').forEach(link=>link.addEventListener('click',closeMenu));
localize();

let frame=0;
function updateProgress(){
  frame=0;const distance=document.documentElement.scrollHeight-innerHeight;
  root?.style.setProperty('--scroll-progress',String(distance>0?Math.min(1,Math.max(0,scrollY/distance)):0));
  if(root)root.dataset.scrolled=String(scrollY>28);
}
function onScroll(){if(!frame)frame=requestAnimationFrame(updateProgress);}
addEventListener('scroll',onScroll,{passive:true});addEventListener('resize',onScroll,{passive:true});updateProgress();

document.querySelectorAll<HTMLButtonElement>('[data-copy-code]').forEach(button=>button.addEventListener('click',async()=>{
  const code=button.closest('.code-block')?.querySelector('code')?.textContent;if(code===undefined||code===null)return;
  const status=document.querySelector<HTMLElement>('.copy-status');
  try{await navigator.clipboard.writeText(code);button.textContent=ui('Copied','已复制','已複製');button.setAttribute('aria-label',button.textContent);if(status)status.textContent=button.textContent;}
  catch{button.textContent=ui('Select to copy','请手动复制','請手動複製');if(status)status.textContent=button.textContent;}
  window.setTimeout(()=>{button.textContent=ui('Copy code','复制代码','複製程式碼');button.setAttribute('aria-label',button.textContent);},2200);
}));

if('IntersectionObserver' in window){
  const links=[...document.querySelectorAll<HTMLAnchorElement>('.article-toc a')];
  const observer=new IntersectionObserver(entries=>{
    const current=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top)[0];
    if(!current)return;
    links.forEach(link=>{if(decodeURIComponent(link.hash.slice(1))===current.target.id)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');});
  },{rootMargin:'-110px 0px -55% 0px',threshold:0});
  document.querySelectorAll('.article-body h2[id],.article-body h3[id]').forEach(heading=>observer.observe(heading));
}
