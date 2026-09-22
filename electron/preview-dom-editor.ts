import {previewHistoryShortcut,previewTextInput} from '../src/preview-shortcuts';
import type {AnnotationTool,DomEdit,DomTarget,EditorCommand,EditorResult,PreviewAnnotation,PreviewEditorState,PreviewElement,PreviewMode,PreviewTreeNode} from '../src/preview-editor-types';
import {annotationDocumentSize,resizeElementBox,translateComponents} from '../src/preview-element-geometry';
import {validateAnnotations} from '../src/preview-annotations';
const LIMIT=1_048_576;
interface Change{patch:DomEdit;undo:()=>void;redo:()=>void;}
export function createPreviewDomEditor(notify:(state:PreviewEditorState)=>void,onSave?:()=>void){
 let mode:PreviewMode='browse',tool:AnnotationTool='rect',selected:Element|undefined,serial=0,revision=0,cursor=0,history:Change[]=[],temporary:Change|undefined;
 let locked=false;let annotations:PreviewAnnotation[]=[],capture=false,selectedAnnotationId:string|undefined;
 type MarkSnapshot={annotations:PreviewAnnotation[];selectedId?:string};
 let annotationHistory:MarkSnapshot[]=[],annotationCursor=0;
 let gesture:{id:string;tool:AnnotationTool;pointerId:number;sourceWidth:number;sourceHeight:number;start:{x:number;y:number};last:{x:number;y:number};points:{x:number;y:number}[]}|undefined;
 let editGesture:{el:Element;before:DomTarget;attrs:ReturnType<typeof attrSnapshot>;style:string|null;pointerId:number;handle:string;startX:number;startY:number;left:number;top:number;width:number;height:number;scaleX:number;scaleY:number;translate:readonly[string,string,string];svgScale:[number,number];svgShape:boolean;moved:boolean}|undefined;
 let ignoreClickUntil=0;
 let textEdit:{el:HTMLElement;before:DomTarget;text:string;editable:string|null}|undefined;
 const ids=new WeakMap<Element,string>(),nodes=new Map<string,Element>(),annotationNodes=new Map<string,Element>();
 let host:HTMLElement|undefined,shadow:ShadowRoot|undefined,svg:SVGSVGElement|undefined,box:HTMLDivElement|undefined,hover:HTMLDivElement|undefined;
 const token=crypto.randomUUID(),ns='http://www.w3.org/2000/svg';
 const own=(el:Element)=>el===host||Boolean(host?.contains(el))||el.getRootNode()===shadow;
 const id=(el:Element)=>{let value=ids.get(el);if(!value){value='node-'+(++serial);ids.set(el,value);nodes.set(value,el);}return value;};
 const html=(el:Element)=>{const clone=el.cloneNode(true) as Element;clone.querySelectorAll('[data-aelion-preview-ui="'+token+'"]').forEach(el=>el.remove());if(textEdit?.el===el){if(textEdit.editable===null)clone.removeAttribute('contenteditable');else clone.setAttribute('contenteditable',textEdit.editable);}return clone.outerHTML;};
 const path=(el:Element)=>{const parts:string[]=[];let node:Element|null=el;while(node&&parts.length<64){const parent:Element|null=node.parentElement;const siblings=parent?[...parent.children].filter(c=>c.localName===node!.localName&&!own(c)):[node];parts.unshift(node.localName+':'+(siblings.indexOf(node)+1));if(!parent&&node.getRootNode() instanceof ShadowRoot){parts.unshift('::shadow');node=(node.getRootNode() as ShadowRoot).host;}else node=parent;}return parts;};
 const descriptor=(el:Element):DomTarget=>{const value=html(el);if(value.length>LIMIT)throw Error('该元素 HTML 超过 1 MB，请选中更小的元素或使用源码编辑');return{tag:el.localName,path:path(el),html:value};};
 const label=(el:Element)=>(el.localName+(el.id?'#'+el.id:el.getAttribute('class')?'.'+el.getAttribute('class')!.trim().split(/\s+/).slice(0,2).join('.'):'' )).slice(0,160);
 function element(el:Element):PreviewElement{const r=el.getBoundingClientRect(),css=getComputedStyle(el),value=html(el),attrs:Record<string,string>={};for(const attr of [...el.attributes].slice(0,200))attrs[attr.name]=attr.value.slice(0,32000);const styles:Record<string,string>={};for(const key of ['font-size','font-weight','font-family','line-height','letter-spacing','color','background-color','width','height','padding','margin','border-radius','display','opacity'])styles[key]=css.getPropertyValue(key);styles.cssText=el.getAttribute('style')||'';return{id:id(el),tag:el.localName,label:label(el),parentId:el.parentElement?id(el.parentElement):undefined,path:path(el),attributes:attrs,html:value.slice(0,LIMIT),truncated:value.length>LIMIT,text:(el.textContent||'').slice(0,100000),leaf:!el.children.length,styles,bounds:{x:r.x,y:r.y,width:r.width,height:r.height}};}
 function state():PreviewEditorState{return{mode,tool,selected:selected?.isConnected?element(selected):undefined,dirty:cursor>0||Boolean(temporary)||Boolean(textEdit)||Boolean(editGesture?.moved),canUndo:cursor>0,canRedo:cursor<history.length,viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY,documentWidth:docSize().width,documentHeight:docSize().height},annotations:currentAnnotations(),selectedAnnotationId,annotationCanUndo:annotationCursor>0,annotationCanRedo:annotationCursor<annotationHistory.length-1,revision};}
 function emit(){revision++;draw();notify(state());}
 function feedbackViewportReady(){return new Promise<void>((resolve,reject)=>{
  let frame=0,finished=false;
  const finish=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timeout);if(frame)cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',hidden);if(error)reject(error);else resolve();};
  const hidden=()=>finish(Error('画布当前不可见，请打开预览后重试'));
  const visibility=()=>{if(document.visibilityState==='hidden')hidden();};
  const timeout=setTimeout(()=>finish(Error('画布尺寸尚未稳定，请稍后重试')),1800);
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',hidden,{once:true});
  if(document.visibilityState==='hidden'){hidden();return;}
  frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>{if(document.visibilityState==='hidden')hidden();else finish();});});
 });}
 function visibleText(root:Element|null,region?:{left:number;top:number;right:number;bottom:number}){
  if(!root)return '';const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),parts:string[]=[];let node:Node|null,visited=0,length=0;
  while((node=walker.nextNode())&&visited++<2000&&length<1000){const parent=node.parentElement,value=node.textContent?.replace(/\s+/g,' ').trim();if(!parent||!value||own(parent)||parent.closest('script,style,noscript,input,textarea,select,[hidden],[aria-hidden="true"]'))continue;const css=getComputedStyle(parent);if(css.visibility==='hidden'||css.display==='none')continue;const range=document.createRange();range.selectNodeContents(node);const r=range.getBoundingClientRect();if(!r.width||!r.height||region&&(r.right<=region.left||r.left>=region.right||r.bottom<=region.top||r.top>=region.bottom))continue;parts.push(value);length+=value.length+1;}
  return parts.join(' ').slice(0,1000);
 }
 function currentAnnotations(){return annotations.map(a=>{const target=annotationNodes.get(a.id);if(!target?.isConnected)return a;const r=target.getBoundingClientRect(),size=annotationDocumentSize(a,docSize());return {...a,x:(r.x+scrollX)/size.width,y:(r.y+scrollY)/size.height,w:r.width/size.width,h:r.height/size.height};});}
 function markSnapshot():MarkSnapshot{return {annotations:currentAnnotations(),selectedId:selectedAnnotationId};}
 function updateAnnotations(next:PreviewAnnotation[],nextId=selectedAnnotationId){
  if(JSON.stringify(next)===JSON.stringify(annotations)){selectedAnnotationId=nextId;return;}
  if(!annotationHistory.length)annotationHistory=[markSnapshot()];
  annotationHistory=annotationHistory.slice(0,annotationCursor+1);annotations=next;selectedAnnotationId=nextId&&next.some(a=>a.id===nextId)?nextId:next.at(-1)?.id;
  annotationHistory.push(markSnapshot());if(annotationHistory.length>101)annotationHistory.shift();annotationCursor=annotationHistory.length-1;
 }
 function annotationHistoryMove(direction:number){const next=annotationCursor+direction;if(next<0||next>=annotationHistory.length)return;annotationCursor=next;const value=annotationHistory[next];annotations=value.annotations;selectedAnnotationId=value.selectedId;}
 function cancelMarkGesture(){const previous=gesture;gesture=undefined;if(previous&&svg?.hasPointerCapture(previous.pointerId))svg.releasePointerCapture(previous.pointerId);draw();}
 function finishMarkGesture(event:PointerEvent){
  if(!gesture||gesture.pointerId!==event.pointerId)return;event.preventDefault();event.stopImmediatePropagation();
  const g=gesture;g.last=point(event,g);if(g.points.length<3000)g.points.push(g.last);gesture=undefined;
  if(svg?.hasPointerCapture(event.pointerId))svg.releasePointerCapture(event.pointerId);
  const dx=(g.last.x-g.start.x)*g.sourceWidth,dy=(g.last.y-g.start.y)*g.sourceHeight;
  const valid=g.tool==='text'||g.tool==='pen'&&g.points.length>2&&g.points.some(p=>Math.hypot((p.x-g.start.x)*g.sourceWidth,(p.y-g.start.y)*g.sourceHeight)>=3)||g.tool==='arrow'&&Math.hypot(dx,dy)>=4||g.tool==='rect'&&Math.abs(dx)>=4&&Math.abs(dy)>=4;
  if(valid&&!locked){const mark=gestureMark(g);if(g.tool==='rect')mark.elementText=visibleText(document.body,{left:mark.x*g.sourceWidth-scrollX,top:mark.y*g.sourceHeight-scrollY,right:(mark.x+(mark.w||0))*g.sourceWidth-scrollX,bottom:(mark.y+(mark.h||0))*g.sourceHeight-scrollY});updateAnnotations([...annotations,mark],mark.id);emit();}else draw();
 }
 function get(value?:string){const el=value?nodes.get(value):selected;if(!el?.isConnected||own(el))throw Error('元素已变化，请重新选中');return el;}
 function attrSnapshot(el:Element){return [...el.attributes].map(a=>[a.name,a.value] as const);}
 function restoreAttrs(el:Element,attrs:readonly(readonly[string,string])[]){for(const a of [...el.attributes])el.removeAttribute(a.name);for(const [name,value]of attrs)el.setAttribute(name,value);}
 function ensure(el:Element,expected:string){if(!el.isConnected||html(el)!==expected)throw Error('网页在修改后发生变化，请重新加载后编辑');}
 function record(change:Change){if(history.slice(0,cursor).reduce((n,c)=>n+c.patch.before.html.length+c.patch.after.length,0)+change.patch.before.html.length+change.patch.after.length>8*1024*1024||cursor>=64){change.undo();throw Error('本轮修改较多，请先保存或发送修改');}history=history.slice(0,cursor);history.push(change);cursor++;}
 function finishText(){const editing=textEdit;if(!editing)return;textEdit=undefined;if(editing.editable===null)editing.el.removeAttribute('contenteditable');else editing.el.setAttribute('contenteditable',editing.editable);const after=html(editing.el),text=editing.el.textContent||'';if(text===editing.text)return;record({patch:{before:editing.before,after},undo:()=>{ensure(editing.el,after);editing.el.textContent=editing.text;selected=editing.el;},redo:()=>{ensure(editing.el,editing.before.html);editing.el.textContent=text;selected=editing.el;}});emit();}
 function mutate(command:Extract<EditorCommand,{type:'style'|'css'|'attributes'|'text'|'html'}>):Change{
  const el=get(),before=descriptor(el),attrs=attrSnapshot(el),children=[...el.childNodes];
  if(command.type==='html'){
   if(typeof command.value!=='string'||command.value.length>LIMIT)throw Error('HTML 过长');const parent=el.parentNode;if(!parent)throw Error('元素没有父节点');const next=el.nextSibling;let added:Node[];
   if(['html','head','body'].includes(el.localName)){const parsed=new DOMParser().parseFromString(command.value,'text/html');const node=el.localName==='html'?parsed.documentElement:el.localName==='head'?parsed.head:parsed.body;added=[document.importNode(node,true)];}
   else if(el.namespaceURI&&el.namespaceURI!=='http://www.w3.org/1999/xhtml'){const wrapper=document.createElementNS(el.namespaceURI,el.parentElement?.namespaceURI===el.namespaceURI?el.parentElement.localName:'svg');wrapper.innerHTML=command.value;added=[...wrapper.childNodes];}
   else{const template=document.createElement('template');template.innerHTML=command.value;added=[...template.content.childNodes];}
   const first=added.find(n=>n instanceof Element) as Element|undefined;if(!first)throw Error('HTML 需要至少包含一个元素');
   el.replaceWith(...added);selected=first;id(first);const rendered=added.map(n=>n instanceof Element?html(n):n.textContent||'').join('');
   const checkAdded=()=>{if(added.some(n=>n.parentNode!==parent)||added.map(n=>n instanceof Element?html(n):n.textContent||'').join('')!==rendered)throw Error('网页结构已变化，无法安全撤销');};
   return{patch:{before,after:rendered},undo:()=>{checkAdded();for(const n of added)parent.removeChild(n);parent.insertBefore(el,next?.parentNode===parent?next:null);selected=el;},redo:()=>{ensure(el,before.html);el.replaceWith(...added);selected=first;}};
  }
  try{
   if(command.type==='text'){if(el.children.length)throw Error('容器请使用 HTML 编辑，以保留子元素');if(command.value.length>100000)throw Error('文字过长');el.textContent=command.value;if(el instanceof HTMLTextAreaElement)el.value=command.value;}
   else if(command.type==='attributes'){const entries=Object.entries(command.values);if(entries.length>200)throw Error('属性过多');for(const [key,value]of entries){if(!/^[^\s"'<>/=]+$/.test(key)||value.length>32000)throw Error('属性名称或内容无效');}restoreAttrs(el,entries);if(el instanceof HTMLInputElement){if('value'in command.values)el.value=command.values.value;el.checked='checked'in command.values;}}
   else{const style=(el as HTMLElement).style;if(!style)throw Error('此节点没有内联样式');if(command.type==='css'){if(command.value.length>100000)throw Error('CSS 过长');style.cssText=command.value;}else for(const [name,value]of Object.entries(command.values)){if(name.length>200||value.length>8000||!name.startsWith('--')&&value&&!CSS.supports(name,value))throw Error('无效 CSS 属性：'+name);if(value)style.setProperty(name,value,style.getPropertyPriority(name));else style.removeProperty(name);}}
   const after=html(el),afterAttrs=attrSnapshot(el),afterChildren=[...el.childNodes];if(after.length>LIMIT)throw Error('修改后的 HTML 过长');
   return{patch:{before,after},undo:()=>{ensure(el,after);restoreAttrs(el,attrs);if(command.type==='text'){el.replaceChildren(...children);if(el instanceof HTMLTextAreaElement)el.value=el.textContent||'';}selected=el;},redo:()=>{ensure(el,before.html);restoreAttrs(el,afterAttrs);if(command.type==='text'){el.replaceChildren(...afterChildren);if(el instanceof HTMLTextAreaElement)el.value=el.textContent||'';}selected=el;}};
  }catch(error){restoreAttrs(el,attrs);if(command.type==='text')el.replaceChildren(...children);throw error;}
 }

 function translated(style:CSSStyleDeclaration,base:readonly[string,string,string],x:number,y:number){style.setProperty('translate','calc('+base[0]+' + '+x+'px) calc('+base[1]+' + '+y+'px)'+(base[2]?' '+base[2]:''),'important');}
 function finishGesture(commit:boolean){const g=editGesture;if(!g)return;editGesture=undefined;
  try{if(g.moved){ignoreClickUntil=performance.now()+350;if(!commit){if(g.style===null)g.el.removeAttribute('style');else g.el.setAttribute('style',g.style);}else{
   const after=html(g.el),afterAttrs=attrSnapshot(g.el);if(after.length>LIMIT){if(g.style===null)g.el.removeAttribute('style');else g.el.setAttribute('style',g.style);throw Error('修改后的 HTML 过长');}
   record({patch:{before:g.before,after},undo:()=>{ensure(g.el,after);restoreAttrs(g.el,g.attrs);selected=g.el;},redo:()=>{ensure(g.el,g.before.html);restoreAttrs(g.el,afterAttrs);selected=g.el;}});
  }}}catch(error){notify({...state(),error:(error as Error).message});}
  finally{if(box?.hasPointerCapture(g.pointerId))box.releasePointerCapture(g.pointerId);emit();}
 }
 function beginGesture(event:PointerEvent,handle:string){if(locked||!selected||mode!=='edit'||event.button!==0||!event.isTrusted)return;
  try{finishText();if(temporary){temporary.undo();temporary=undefined;}const el=get(),css=getComputedStyle(el),r=el.getBoundingClientRect();if(!r.width||!r.height||!(el as HTMLElement).style)return;
   const svgShape=el instanceof SVGElement&&!(el instanceof SVGSVGElement);
   const width=el instanceof HTMLElement?el.offsetWidth:r.width,height=el instanceof HTMLElement?el.offsetHeight:r.height;
   const scales=css.scale==='none'?[]:css.scale.split(/\s+/).map(v=>parseFloat(v)/(v.endsWith('%')?100:1));
   editGesture={el,before:descriptor(el),attrs:attrSnapshot(el),style:el.getAttribute('style'),pointerId:event.pointerId,handle,startX:event.clientX,startY:event.clientY,left:r.left,top:r.top,width:width||r.width,height:height||r.height,scaleX:r.width/(width||r.width),scaleY:r.height/(height||r.height),translate:translateComponents(css.translate),svgScale:[scales[0]||1,scales[1]||scales[0]||1],svgShape,moved:false};
   window.focus();box?.setPointerCapture(event.pointerId);event.preventDefault();event.stopImmediatePropagation();
  }catch(error){notify({...state(),error:(error as Error).message});}
 }
 function moveGesture(event:PointerEvent){const g=editGesture;if(!g||event.pointerId!==g.pointerId)return;event.preventDefault();event.stopImmediatePropagation();
  if(!g.el.isConnected){finishGesture(false);return;}const dx=(event.clientX-g.startX)/g.scaleX,dy=(event.clientY-g.startY)/g.scaleY;if(!g.moved&&Math.hypot(event.clientX-g.startX,event.clientY-g.startY)<3)return;
  const first=!g.moved;g.moved=true;const style=(g.el as HTMLElement).style;
  if(g.handle==='move')translated(style,g.translate,dx,dy);else{
   const size=resizeElementBox(g,g.handle,dx,dy,event.shiftKey);
   if(g.svgShape){style.setProperty('scale',(g.svgScale[0]*size.width/g.width)+' '+(g.svgScale[1]*size.height/g.height),'important');}
   else{if(getComputedStyle(g.el).display==='inline')style.setProperty('display','inline-block');style.setProperty('box-sizing','border-box','important');for(const axis of ['width','height'] as const){style.setProperty(axis,size[axis]+'px','important');style.setProperty('min-'+axis,'0','important');style.setProperty('max-'+axis,'none','important');}style.setProperty('flex-shrink','0','important');}
   translated(style,g.translate,size.x,size.y);
   // Flex/grid centering and SVG scale origins may shift the box when its size
   // changes. Compensate so the opposite edge remains anchored to the canvas.
   const actual=g.el.getBoundingClientRect();translated(style,g.translate,size.x+(g.left+size.x*g.scaleX-actual.left)/g.scaleX,size.y+(g.top+size.y*g.scaleY-actual.top)/g.scaleY);
  }draw();if(first)notify(state());
 }
 function overlay(){if(!document.documentElement)return;if(!host){host=document.createElement('div');host.dataset.aelionPreviewUi=token;host.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict;';shadow=host.attachShadow({mode:'closed'});const style=document.createElement('style');style.textContent='*{box-sizing:border-box}.box{position:fixed;border:1.5px solid #3975c6;pointer-events:none}.handle{position:absolute;width:10px;height:10px;background:#fff;border:1.5px solid #3975c6;border-radius:2px;pointer-events:auto;touch-action:none;transform:translate(-50%,-50%)}.hover{border:1px dashed #6b9ad7}.label{position:absolute;bottom:100%;left:-1px;background:#3975c6;color:white;border-radius:3px;font:11px/18px sans-serif;padding:0 5px;white-space:nowrap;max-width:300px;overflow:hidden;pointer-events:auto;cursor:move;touch-action:none}svg{position:fixed;inset:0;width:100%;height:100%;touch-action:none;pointer-events:none}';svg=document.createElementNS(ns,'svg');box=document.createElement('div');box.className='box';const tag=document.createElement('span');tag.className='label';tag.dataset.handle='move';box.append(tag);for(const [name,x,y]of [['nw',0,0],['n',50,0],['ne',100,0],['e',100,50],['se',100,100],['s',50,100],['sw',0,100],['w',0,50]] as const){const grip=document.createElement('span');grip.className='handle';grip.dataset.handle=name;grip.style.cssText='left:'+x+'%;top:'+y+'%;cursor:'+name+'-resize';box.append(grip);}box.addEventListener('pointerdown',event=>{const grip=event.composedPath().find(n=>n instanceof HTMLElement&&n.dataset.handle) as HTMLElement|undefined;if(grip)beginGesture(event,grip.dataset.handle!);});hover=document.createElement('div');hover.className='box hover';shadow.append(style,svg,hover,box);
   svg.addEventListener('pointerdown',event=>{
    if(!event.isTrusted||locked||capture||mode!=='annotate'||event.button!==0||!event.isPrimary)return;
    const badge=event.composedPath().find(n=>n instanceof Element&&n.hasAttribute('data-annotation-id')) as Element|undefined;
    if(badge){selectedAnnotationId=badge.getAttribute('data-annotation-id')||undefined;emit();event.preventDefault();event.stopImmediatePropagation();return;}
    if(tool==='element')return;
    if(annotations.length>=100){notify({...state(),error:'最多添加 100 条标注，请先删除部分标注'});return;}
    const size=docSize(),p=point(event,size);gesture={id:crypto.randomUUID(),tool,pointerId:event.pointerId,sourceWidth:size.width,sourceHeight:size.height,start:p,last:p,points:[p]};
    svg!.setPointerCapture(event.pointerId);event.preventDefault();event.stopImmediatePropagation();draw();
   });
   svg.addEventListener('pointermove',event=>{if(!gesture||gesture.pointerId!==event.pointerId)return;event.preventDefault();gesture.last=point(event,gesture);if(gesture.points.length<3000)gesture.points.push(gesture.last);draw();});
   svg.addEventListener('pointerup',finishMarkGesture);svg.addEventListener('pointercancel',cancelMarkGesture);
   svg.addEventListener('lostpointercapture',()=>{if(gesture)cancelMarkGesture();});
  }if(!host.isConnected)document.documentElement.append(host);}
 function docSize(){return{width:Math.max(innerWidth,document.documentElement?.scrollWidth||0),height:Math.max(innerHeight,document.documentElement?.scrollHeight||0)};}
 function point(event:PointerEvent,source:{width?:number;height?:number;sourceWidth?:number;sourceHeight?:number}=docSize()){const size={width:source.width||source.sourceWidth||innerWidth,height:source.height||source.sourceHeight||innerHeight};return{x:Math.max(0,(event.clientX+scrollX)/size.width),y:Math.max(0,(event.clientY+scrollY)/size.height)};}
 function gestureMark(g:NonNullable<typeof gesture>):PreviewAnnotation{return{id:g.id,type:g.tool,sourceWidth:g.sourceWidth,sourceHeight:g.sourceHeight,x:Math.min(g.start.x,g.last.x),y:Math.min(g.start.y,g.last.y),w:Math.abs(g.last.x-g.start.x),h:Math.abs(g.last.y-g.start.y),...(g.tool==='arrow'?{x:g.start.x,y:g.start.y,end:g.last}:{}),...(g.tool==='pen'?{x:g.start.x,y:g.start.y,points:g.points}:{}),color:'#3975c6'};}
 const markElement=(tag:string,attrs:Record<string,string|number>)=>{const el=document.createElementNS(ns,tag);for(const [name,value]of Object.entries(attrs))el.setAttribute(name,String(value));return el;};
 function draw(){overlay();if(!svg||!box||!hover)return;host!.style.pointerEvents='none';svg.style.pointerEvents=!locked&&!capture&&mode==='annotate'&&tool!=='element'?'auto':'none';svg.style.cursor=tool==='text'?'text':'crosshair';svg.setAttribute('viewBox',`0 0 ${innerWidth} ${innerHeight}`);svg.replaceChildren();const documentSize=docSize();const list=gesture?[...annotations,gestureMark(gesture)]:annotations;
  for(const [i,a]of list.entries()){const size=annotationDocumentSize(a,documentSize);let x=a.x*size.width-scrollX,y=a.y*size.height-scrollY,w=(a.w||0)*size.width,h=(a.h||0)*size.height;const target=annotationNodes.get(a.id);if(target?.isConnected){const b=target.getBoundingClientRect();x=b.x;y=b.y;w=b.width;h=b.height;}
   if(a.type==='rect'||a.type==='element')svg.append(markElement('rect',{x,y,width:w,height:h,fill:a.color+'0c',stroke:a.color,'stroke-width':a.id===selectedAnnotationId?3:2}));
   if(a.type==='arrow'&&a.end){const ex=a.end.x*size.width-scrollX,ey=a.end.y*size.height-scrollY,angle=Math.atan2(ey-y,ex-x);svg.append(markElement('line',{x1:x,y1:y,x2:ex,y2:ey,stroke:a.color,'stroke-width':2}),markElement('polyline',{points:`${ex-10*Math.cos(angle-.45)},${ey-10*Math.sin(angle-.45)} ${ex},${ey} ${ex-10*Math.cos(angle+.45)},${ey-10*Math.sin(angle+.45)}`,fill:'none',stroke:a.color,'stroke-width':2}));}
   if(a.type==='pen')svg.append(markElement('polyline',{points:(a.points||[]).map(p=>`${p.x*size.width-scrollX},${p.y*size.height-scrollY}`).join(' '),fill:'none',stroke:a.color,'stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round'}));
   if(a.type==='text'){const text=markElement('text',{x:x+8,y:y+20,fill:a.color,'font-size':15,'font-family':'sans-serif'});text.textContent=(a.text||'添加注释').slice(0,52);svg.append(markElement('rect',{x:x+24,y,width:Math.max(80,(text.textContent.length)*15+16),height:29,rx:4,fill:'#fff',stroke:a.id===selectedAnnotationId?a.color:'none'}),text);text.setAttribute('x',String(x+32));}
   if(i<annotations.length){const t=markElement('text',{x:x+9,y:y+13,fill:'#fff','font-size':11,'font-family':'sans-serif','text-anchor':'middle'});t.textContent=String(i+1);const badge=markElement('g',{'data-annotation-id':a.id,style:!capture&&mode==='annotate'?'pointer-events:all;cursor:pointer':'pointer-events:none'});badge.append(markElement('circle',{cx:x+9,cy:y+9,r:a.id===selectedAnnotationId?11:9,fill:a.color,stroke:'#fff','stroke-width':2}),t);svg.append(badge);}
  }
  box.hidden=capture||mode!=='edit'||!selected?.isConnected;hover.hidden=true;if(!box.hidden&&selected){const r=selected.getBoundingClientRect();Object.assign(box.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});const tag=box.querySelector<HTMLElement>('.label')!;tag.textContent=label(selected);tag.style.top=r.top<22?'0':'auto';tag.style.bottom=r.top<22?'auto':'100%';for(const grip of box.querySelectorAll<HTMLElement>('.handle'))grip.style.pointerEvents=locked?'none':'auto';}if(mode==='edit')svg.style.visibility='hidden';else svg.style.visibility='visible';
 }
 const clicked=(event:MouseEvent)=>{
  if(event.composedPath().some(n=>n instanceof Element&&own(n))||performance.now()<ignoreClickUntil){if(mode==='edit'){event.preventDefault();event.stopImmediatePropagation();}return;}
  if(locked&&mode!=='browse'){event.preventDefault();event.stopImmediatePropagation();return;}
  if(textEdit&&event.composedPath().includes(textEdit.el))return;if(!event.isTrusted||mode==='browse'||mode==='annotate'&&tool!=='element')return;
  const el=event.composedPath().find(n=>n instanceof Element&&!own(n)) as Element|undefined;if(!el||own(el))return;
  event.preventDefault();event.stopImmediatePropagation();finishText();selected=event.altKey&&el.parentElement?el.parentElement:el;id(selected);
  if(mode==='annotate'){
   const existing=annotations.find(a=>a.type==='element'&&annotationNodes.get(a.id)===selected);
   if(existing){selectedAnnotationId=existing.id;emit();return;}
   if(annotations.length>=100){notify({...state(),error:'最多添加 100 条标注，请先删除部分标注'});return;}
   const r=selected.getBoundingClientRect(),size=docSize(),designId=selected.getAttribute('data-design-id')||undefined,mark:PreviewAnnotation={id:crypto.randomUUID(),type:'element',sourceWidth:size.width,sourceHeight:size.height,x:(r.x+scrollX)/size.width,y:(r.y+scrollY)/size.height,w:r.width/size.width,h:r.height/size.height,color:'#3975c6',selector:path(selected).map(p=>p.replace(/:(\d+)$/,':nth-of-type($1)')).join(' > '),elementLabel:label(selected),elementText:visibleText(selected),...(designId?{designId}:{})};
   annotationNodes.set(mark.id,selected);updateAnnotations([...annotations,mark],mark.id);
  }emit();
 };
 window.addEventListener('pointerdown',event=>{if(!event.isTrusted||mode!=='edit'||locked||textEdit)return;const path=event.composedPath(),grip=path.find(n=>n instanceof HTMLElement&&n.dataset.handle&&n.getRootNode()===shadow) as HTMLElement|undefined;if(grip){beginGesture(event,grip.dataset.handle!);return;}if(path.some(n=>n instanceof Element&&own(n)))return;const el=path.find(n=>n instanceof Element) as Element|undefined;if(el===selected)beginGesture(event,'move');},true);
 window.addEventListener('pointermove',moveGesture,true);
 window.addEventListener('pointerup',event=>{if(editGesture?.pointerId===event.pointerId){event.preventDefault();event.stopImmediatePropagation();finishGesture(true);}},true);
 window.addEventListener('pointercancel',()=>finishGesture(false),true);
 window.addEventListener('blur',()=>{finishGesture(false);if(gesture)cancelMarkGesture();});
 window.addEventListener('keydown',event=>{if(event.isTrusted&&mode==='edit'&&(event.ctrlKey||event.metaKey)&&!event.altKey&&!event.isComposing&&event.key.toLowerCase()==='s'){event.preventDefault();event.stopImmediatePropagation();if(!locked&&!event.repeat)try{finishGesture(true);finishText();onSave?.();}catch(error){notify({...state(),error:(error as Error).message});}return;}if(event.isTrusted&&mode==='annotate'&&!previewTextInput(event)){if(event.key==='Escape'&&gesture){event.preventDefault();event.stopImmediatePropagation();cancelMarkGesture();return;}const markAction=previewHistoryShortcut(event);if(markAction){event.preventDefault();event.stopImmediatePropagation();if(!locked)void api.command({type:markAction==='undo'?'annotation-undo':'annotation-redo'});return;}if((event.key==='Delete'||event.key==='Backspace')&&selectedAnnotationId&&!locked){event.preventDefault();event.stopImmediatePropagation();updateAnnotations(annotations.filter(a=>a.id!==selectedAnnotationId));emit();return;}}if(event.key==='Escape'&&editGesture){event.preventDefault();event.stopImmediatePropagation();finishGesture(false);return;}const action=previewHistoryShortcut(event);if(!action||!event.isTrusted||mode!=='edit'||previewTextInput(event))return;event.preventDefault();event.stopImmediatePropagation();if(!locked)void api.command({type:action}).catch(error=>notify({...state(),error:error.message}));},true);
 window.addEventListener('DOMContentLoaded',emit,{once:true});
 window.addEventListener('click',clicked,true);
 window.addEventListener('dblclick',event=>{if(locked||!event.isTrusted||mode!=='edit'||event.composedPath().some(n=>n instanceof Element&&own(n)))return;event.preventDefault();event.stopImmediatePropagation();const el=event.composedPath().find(n=>n instanceof HTMLElement&&!own(n)) as HTMLElement|undefined;if(!el||el.children.length||['script','style','input','textarea','select'].includes(el.localName))return;finishText();selected=el;textEdit={el,before:descriptor(el),text:el.textContent||'',editable:el.getAttribute('contenteditable')};el.contentEditable='true';el.focus();const range=document.createRange();range.selectNodeContents(el);getSelection()?.removeAllRanges();getSelection()?.addRange(range);emit();},true);
 window.addEventListener('focusout',event=>{if(textEdit&&event.target===textEdit.el){try{finishText();}catch(error){notify({...state(),error:(error as Error).message});}}},true);
 window.addEventListener('scroll',draw,true);window.addEventListener('resize',()=>{draw();if(selected)notify(state());});
 window.addEventListener('pointermove',event=>{if((mode!=='edit'&&(mode!=='annotate'||tool!=='element'))||capture||locked||!hover||editGesture)return;const eventPath=event.composedPath();if(eventPath.some(n=>n instanceof Element&&own(n))){hover.hidden=true;return;}const el=eventPath.find(n=>n instanceof Element) as Element|undefined;if(!el||mode==='edit'&&el===selected){hover.hidden=true;return;}const r=el.getBoundingClientRect();hover.hidden=false;Object.assign(hover.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});},true);
 const api={async command(command:EditorCommand):Promise<EditorResult>{
  if(!command||typeof command.type!=='string')throw Error('编辑命令无效');if(editGesture&&!['state','children'].includes(command.type))finishGesture(!['cancel','reset','mode'].includes(command.type));finishText();
  if(command.type==='feedback-state'){await feedbackViewportReady();}
  else if(command.type==='mode'){if(gesture)cancelMarkGesture();mode=command.mode;tool=command.tool||tool;if(!['browse','annotate','edit'].includes(mode)||!['rect','arrow','pen','text','element'].includes(tool))throw Error('无效编辑模式');selected=undefined;}
  else if(command.type==='select'){selected=get(command.id);}
  else if(command.type==='parent'){selected=get().parentElement||selected;}
  else if(command.type==='children'){const parent=command.id?get(command.id):undefined;const list=parent?[...parent.children,...(parent.shadowRoot?.children||[])].filter(el=>!own(el)):[document.documentElement];const offset=Math.max(0,Math.trunc(command.offset||0));return{state:state(),nodes:list.slice(offset,offset+200).map(el=>({id:id(el),label:label(el),tag:el.localName,hasChildren:el.children.length>0||Boolean(el.shadowRoot?.children.length)})),more:list.length>offset+200};}
  else if(['style','css','attributes','text','html'].includes(command.type)){if(mode!=='edit'||locked)throw Error('编辑器正在保存或尚未进入编辑模式');if(command.targetId&&(!selected||id(selected)!==command.targetId))throw Error('选中元素已变化，请重试');if(temporary){temporary.undo();temporary=undefined;}const change=mutate(command as Extract<EditorCommand,{type:'style'|'css'|'attributes'|'text'|'html'}>);if(command.type==='html'&&command.preview)temporary=change;else record(change);}
  else if(command.type==='revert-preview'){if(locked)throw Error('正在保存，请稍候');temporary?.undo();temporary=undefined;}
  else if(command.type==='undo'){if(locked)throw Error('正在保存，请稍候');if(temporary){temporary.undo();temporary=undefined;}else if(cursor){history[cursor-1].undo();cursor--;}}
  else if(command.type==='redo'){if(locked)throw Error('正在保存，请稍候');if(cursor<history.length){history[cursor].redo();cursor++;}}
  else if(command.type==='commit'){if(temporary)throw Error('请先应用 HTML 预览');history=[];cursor=0;}
  else if(command.type==='reset'){if(locked)throw Error('正在保存，请稍候');history=[];cursor=0;temporary=undefined;mode='browse';selected=undefined;}
  else if(command.type==='cancel'){if(locked)throw Error('正在保存，请稍候');if(temporary){temporary.undo();temporary=undefined;}while(cursor){history[cursor-1].undo();cursor--;}history=[];mode='browse';selected=undefined;}
  else if(command.type==='export'){if(temporary)throw Error('请先应用或撤回 HTML 预览');return{state:state(),edits:history.slice(0,cursor).map(c=>c.patch)};}
  else if(command.type==='annotations'){
   if(locked)throw Error('正在保存，请稍候');const next=validateAnnotations(command.annotations);updateAnnotations(next);
   for(const a of next){if(a.type!=='element'||annotationNodes.get(a.id)?.isConnected)continue;try{const target=a.designId?document.querySelector('[data-design-id="'+CSS.escape(a.designId)+'"]'):a.selector?document.querySelector(a.selector):null;if(target&&!own(target))annotationNodes.set(a.id,target);}catch{/* A stale selector still retains its drawn coordinates. */}}
  }
  else if(command.type==='annotation-select'){selectedAnnotationId=annotations.some(a=>a.id===command.id)?command.id:undefined;}
  else if(command.type==='annotation-undo'||command.type==='annotation-redo'){if(locked)throw Error('正在保存，请稍候');annotationHistoryMove(command.type==='annotation-undo'?-1:1);}
  else if(command.type==='capture'){capture=command.hide;}else if(command.type==='lock'){locked=command.locked;if(locked&&gesture)cancelMarkGesture();}
  emit();return{state:state()};
 }};
 return api;
}
