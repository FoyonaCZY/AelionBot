/** Runs only in the isolated, resource-complete export renderer. */
function captureVectorPage(){
 const ns='http://www.w3.org/2000/svg',warnings=new Set<string>(),defs:string[]=[];
 const esc=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
 const n=(value:number)=>Number.isFinite(value)?Math.round(value*100)/100:0;
 const width=Math.ceil(Math.max(innerWidth,document.documentElement.scrollWidth,document.body?.scrollWidth||0)),height=Math.ceil(Math.max(innerHeight,document.documentElement.scrollHeight,document.body?.scrollHeight||0));
 if(width>20000||height>40000||width*height>100000000)throw Error('页面过大，请缩小画布或使用 PDF 导出');
 const canvas=document.createElement('canvas'),measure=canvas.getContext('2d')!;
 let count=0,characters=0,clipId=0;
 const visibleColor=(color:string)=>color!=='transparent'&&!/rgba\([^)]*,\s*0\s*\)/.test(color);
 const rect=(el:Element)=>{const r=el.getBoundingClientRect();return{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};};
 const safeImage=(url:string)=>/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)(?:;|,)/i.test(url);
 const text=(value:string,x:number,y:number,w:number,h:number,style:CSSStyleDeclaration)=>{
  if(!value.trim()||!w||!h)return '';
  measure.font=style.fontStyle+' '+style.fontWeight+' '+style.fontSize+' '+style.fontFamily;
  const metrics=measure.measureText(value),ascent=metrics.fontBoundingBoxAscent||parseFloat(style.fontSize)*.8,descent=metrics.fontBoundingBoxDescent||parseFloat(style.fontSize)*.2;
  const scale=h/(ascent+descent),fontSize=parseFloat(style.fontSize)*scale,baseline=y+ascent*scale;
  if(style.textTransform==='uppercase')value=value.toUpperCase();else if(style.textTransform==='lowercase')value=value.toLowerCase();else if(style.textTransform==='capitalize')value=value.replace(/\b\p{L}/gu,c=>c.toUpperCase());
  const direction=style.direction==='rtl'?' direction="rtl" text-anchor="end"':'';
  return `<text x="${n(style.direction==='rtl'?x+w:x)}" y="${n(baseline)}" font-family="${esc(style.fontFamily)}" font-size="${n(fontSize)}" font-weight="${esc(style.fontWeight)}" font-style="${esc(style.fontStyle)}" fill="${esc(style.color)}" textLength="${n(w)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve"${direction}${style.textDecorationLine!=='none'?` text-decoration="${esc(style.textDecorationLine)}"`:''}>${esc(value)}</text>`;
 };
 const textNode=(node:Text,style:CSSStyleDeclaration)=>{
  const value=node.textContent||'';characters+=value.length;if(characters>80000)throw Error('页面文字过多，请使用 PDF 或 PNG 导出');
  const range=document.createRange();let offset=0,result='',run:{value:string;x:number;y:number;right:number;height:number}|undefined;
  const flush=()=>{if(run){result+=text(run.value,run.x,run.y,run.right-run.x,run.height,style);run=undefined;}};
  for(const char of value){range.setStart(node,offset);offset+=char.length;range.setEnd(node,offset);const r=range.getClientRects()[0];if(!r||!r.width||!r.height){continue;}
   const x=r.x+scrollX,y=r.y+scrollY;if(run&&(Math.abs(run.y-y)>.7||x<run.x-.7)){flush();}
   if(!run)run={value:char,x,y,right:x+r.width,height:r.height};else{run.value+=char;run.right=Math.max(run.right,x+r.width);}
  }flush();range.detach();return result;
 };
 const visit=(el:Element):string=>{
  if(++count>8000)throw Error('页面元素过多，请使用 PNG 或 PDF 导出');
  if(['SCRIPT','STYLE','LINK','META','HEAD','NOSCRIPT','TEMPLATE'].includes(el.tagName))return '';
  const s=getComputedStyle(el);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0)return '';
  const r=rect(el);if(!r.width||!r.height)return [...el.children].map(visit).join('');
  const name=(el.getAttribute('data-design-id')||el.getAttribute('aria-label')||el.id||el.localName).slice(0,100);
  let body='';
  if(s.transform!=='none'){try{const m=new DOMMatrix(s.transform);if(Math.abs(m.b)>.001||Math.abs(m.c)>.001)warnings.add('旋转或倾斜元素已按显示边界近似');}catch{warnings.add('部分变换效果未保留');}}
  if(s.boxShadow!=='none'||s.textShadow!=='none')warnings.add('SVG 未保留部分阴影效果');
  if(s.filter!=='none'||s.backdropFilter!=='none')warnings.add('SVG 未保留 CSS 滤镜效果');
  const radii=[s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomRightRadius,s.borderBottomLeftRadius].map(value=>parseFloat(value)||0),radius=Math.min(Math.max(...radii),r.width/2,r.height/2);
  if(new Set(radii).size>1)warnings.add('不同角的圆角已近似为统一圆角');
  const box=(fill:string,extra='')=>`<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" rx="${n(radius)}" fill="${esc(fill)}"${extra}/>`;
  if(visibleColor(s.backgroundColor))body+=box(s.backgroundColor);
  if(s.backgroundImage!=='none'){
   const match=/^url\(["']?(data:image\/[\s\S]+?)["']?\)$/.exec(s.backgroundImage);
   if(match&&safeImage(match[1]))body+=`<image x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" href="${esc(match[1])}" preserveAspectRatio="xMidYMid ${s.backgroundSize==='contain'?'meet':'slice'}"/>`;
   else warnings.add('SVG 未保留部分渐变或背景效果');
  }
  const borders=[['Top',r.x,r.y,r.x+r.width,r.y],['Right',r.x+r.width,r.y,r.x+r.width,r.y+r.height],['Bottom',r.x,r.y+r.height,r.x+r.width,r.y+r.height],['Left',r.x,r.y,r.x,r.y+r.height]] as const;
  const widths=borders.map(([side])=>parseFloat(s.getPropertyValue('border-'+side.toLowerCase()+'-width'))||0);
  if(widths.every(w=>w===widths[0])&&widths[0]&&[s.borderTopColor,s.borderRightColor,s.borderBottomColor,s.borderLeftColor].every(c=>c===s.borderTopColor)&&s.borderTopStyle==='solid')body+=box('none',` stroke="${esc(s.borderTopColor)}" stroke-width="${n(widths[0])}"`);
  else for(const [index,[side,x1,y1,x2,y2]]of borders.entries()){const line=widths[index],color=s.getPropertyValue('border-'+side.toLowerCase()+'-color');if(line&&visibleColor(color)&&s.getPropertyValue('border-'+side.toLowerCase()+'-style')!=='none')body+=`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${esc(color)}" stroke-width="${n(line)}"/>`;}
  if(el.localName==='svg'){
   const clone=el.cloneNode(true) as SVGSVGElement;clone.setAttribute('x',String(n(r.x)));clone.setAttribute('y',String(n(r.y)));clone.setAttribute('width',String(n(r.width)));clone.setAttribute('height',String(n(r.height)));clone.removeAttribute('style');
   const originals=[el,...el.querySelectorAll('*')],copies=[clone,...clone.querySelectorAll('*')];
   originals.forEach((original,index)=>{const copy=copies[index];if(!copy)return;const css=getComputedStyle(original);for(const key of ['fill','stroke','stroke-width','opacity','color'])copy.setAttribute(key,css.getPropertyValue(key));for(const attr of [...copy.attributes])if(attr.name.startsWith('on'))copy.removeAttribute(attr.name);});
   for(const unsafe of clone.querySelectorAll('script,foreignObject,iframe')){unsafe.remove();warnings.add('SVG 中的嵌入网页内容未导出');}
   body+=new XMLSerializer().serializeToString(clone);
  }else if(el instanceof HTMLImageElement){const url=el.currentSrc||el.src;if(safeImage(url))body+=`<image x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" href="${esc(url)}" preserveAspectRatio="${s.objectFit==='fill'?'none':'xMidYMid '+(s.objectFit==='cover'?'slice':'meet')}"/>`;else warnings.add('SVG 中有图片无法内嵌');
  }else if(el instanceof HTMLCanvasElement){try{body+=`<image x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" href="${el.toDataURL('image/png')}"/>`;warnings.add('Canvas 图表以图片保留');}catch{warnings.add('部分 Canvas 内容无法导出');}
  }else if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||el instanceof HTMLSelectElement){const value=el instanceof HTMLInputElement&&el.type==='password'?'•'.repeat(Math.min(el.value.length,20)):el instanceof HTMLSelectElement?el.selectedOptions[0]?.textContent||'':el.value||el.getAttribute('placeholder')||'';const left=parseFloat(s.paddingLeft)||0,top=parseFloat(s.paddingTop)||0,size=parseFloat(s.fontSize);measure.font=s.font;const m=measure.measureText(value);body+=text(value,r.x+left,r.y+top,Math.min(r.width-left,m.width),size*1.2,s);warnings.add('表单控件以静态文字保留');
  }else{
   let children='';for(const child of el.childNodes)children+=child instanceof Text?textNode(child,s):child instanceof Element?visit(child):'';
   if(['hidden','clip','scroll','auto'].includes(s.overflowX)||['hidden','clip','scroll','auto'].includes(s.overflowY)){const id='clip-'+(++clipId);defs.push(`<clipPath id="${id}">${box('#fff')}</clipPath>`);children=`<g clip-path="url(#${id})">${children}</g>`;}
   body+=children;
  }
  for(const pseudo of ['::before','::after']){const content=getComputedStyle(el,pseudo).content;if(content&&content!=='none'&&content!=='normal'&&content!=='""')warnings.add('SVG 未保留部分伪元素内容');}
  return `<g data-name="${esc(name)}"${Number(s.opacity)<1?` opacity="${esc(s.opacity)}"`:''}>${body}</g>`;
 };
 let fontCSS='';const sheets=(sheet:CSSStyleSheet,depth=0)=>{if(depth>8)return;try{for(const rule of sheet.cssRules){if(rule instanceof CSSFontFaceRule)fontCSS+=rule.cssText+'\n';else if(rule instanceof CSSImportRule&&rule.styleSheet)sheets(rule.styleSheet,depth+1);}}catch{warnings.add('部分字体样式无法读取');}};for(const sheet of document.styleSheets)sheets(sheet);
 const body=visit(document.body||document.documentElement),rootStyle=getComputedStyle(document.documentElement),background=visibleColor(rootStyle.backgroundColor)?rootStyle.backgroundColor:'#fff';
 if(fontCSS)warnings.add('导入 Figma 时需有相应字体，文字外观可能变化');
 const svg=`<svg xmlns="${ns}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${esc(document.title||'Design')}</title><desc>Static vector export. Text and simple shapes are preserved; complex CSS may differ.</desc><defs>${fontCSS?'<style>'+esc(fontCSS)+'</style>':''}${defs.join('')}</defs><rect width="100%" height="100%" fill="${esc(background)}"/>${body}</svg>`;
 if(svg.length>40*1024*1024)throw Error('SVG 超过大小限制，请使用 PDF 或 PNG');
 return {svg,warnings:[...warnings],width,height};
}
export const CANVAS_SVG_SCRIPT='('+captureVectorPage.toString()+')()';
