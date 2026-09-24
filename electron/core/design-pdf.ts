export function printReadyHtml(html:string){
 if(!html.trim())throw Error('没有可打印的 HTML');
 if(/<html[\s>]/i.test(html))return html;
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Export</title><body>${html}</body></html>`;
}
export async function renderDesignPdf(html:string,print:(document:string)=>Promise<Buffer>){
 const document=printReadyHtml(html);
 const bytes=await print(document);
 if(!bytes.length||bytes.length>40*1024*1024)throw Error('PDF 为空或过大');
 if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('导出结果不是 PDF');
 return bytes;
}

/** Executed in the isolated print renderer after loadURL and before printToPDF. */
async function waitForDesignResources(){
 let timeout:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([
  (async()=>{
   // Exports include the entire page; below-fold lazy images must load without scrolling.
   for(const image of document.images)image.loading='eager';
   // Trigger font loads for the actual text and requested weights, including print-only text.
   const requests=new Map<string,{font:string;text:string}>();
   const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);
   let textNode:Node|null,characters=0;
   while((textNode=walker.nextNode())){
    const parent=textNode.parentElement,text=textNode.textContent||'';
    if(!parent||!text.trim()||['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(parent.tagName))continue;
    characters+=text.length;if(characters>2*1024*1024)throw Error('页面文字过多，无法校验导出字体');
    const style=getComputedStyle(parent),font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const key=font+'\n'+text;if(!requests.has(key))requests.set(key,{font,text});
   }
   for(const element of document.querySelectorAll('*'))for(const pseudo of ['::before','::after']){
    const style=getComputedStyle(element,pseudo),content=style.content;
    if(!content||content==='none'||content==='normal'||content==='""')continue;
    const text=/^["']/.test(content)?content.slice(1,-1):content;
    const font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    requests.set(font+'\n'+text,{font,text});
   }
   if(requests.size>10000)throw Error('页面字体组合过多，无法完成字体校验');
   await Promise.all([...requests.values()].map(async({font,text})=>{
    const faces=await document.fonts.load(font,text);if(faces.some(face=>face.status!=='loaded')||!document.fonts.check(font,text))throw Error('字体加载失败：'+font);
   }));
   await document.fonts.ready;
   const failed=[...document.fonts].filter(face=>face.status==='error');if(failed.length)throw Error('字体加载失败：'+failed.map(face=>face.family).join('、'));
   await Promise.all([...document.images].map(async image=>{
    if(!image.getAttribute('src')&&!image.getAttribute('srcset'))return;
    try{await image.decode();}catch{throw Error('图片加载失败：'+(image.getAttribute('alt')||image.getAttribute('src')||'').slice(0,100));}
    if(!image.naturalWidth)throw Error('图片未能加载');
   }));
   // Let Chromium commit the layout using the loaded font metrics.
   await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
   return {fonts:[...document.fonts].filter(face=>face.status==='loaded').length,images:document.images.length};
  })(),
  new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('字体或图片加载超过 30 秒，请检查项目资源')),30000);})
 ]);}finally{if(timeout)clearTimeout(timeout);}
}
export const DESIGN_PDF_READY_SCRIPT='('+waitForDesignResources.toString()+')()';
