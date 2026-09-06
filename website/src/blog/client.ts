import '../styles.css';
import './styles.css';

const root=document.querySelector<HTMLElement>('.blog-site');
const menu=document.querySelector<HTMLButtonElement>('.mobile-menu-button');
const navigation=document.getElementById('main-navigation');

function closeMenu(){navigation?.classList.remove('is-open');menu?.setAttribute('aria-expanded','false');menu?.setAttribute('aria-label','打开导航');}
menu?.addEventListener('click',()=>{
  const open=menu.getAttribute('aria-expanded')!=='true';
  navigation?.classList.toggle('is-open',open);menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'关闭导航':'打开导航');
});
document.addEventListener('pointerdown',event=>{if(!(event.target as Element).closest('.site-header'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
navigation?.querySelectorAll('a').forEach(link=>link.addEventListener('click',closeMenu));

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
  try{await navigator.clipboard.writeText(code);button.textContent='已复制';button.setAttribute('aria-label','代码已复制');if(status)status.textContent='代码已复制到剪贴板。';}
  catch{button.textContent='请手动复制';if(status)status.textContent='未能写入剪贴板，可以选中代码手动复制。';}
  window.setTimeout(()=>{button.textContent='复制代码';button.setAttribute('aria-label','复制代码');},2200);
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
