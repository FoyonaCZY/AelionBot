export type SceneColor=[number,number,number,number];
export interface SceneRect{x:number;y:number;width:number;height:number;}
export interface SceneGradient{from:[number,number];to:[number,number];stops:Array<{offset:number;color:SceneColor}>;}
export interface SceneShadow{x:number;y:number;blur:number;spread:number;color:SceneColor;inset:boolean;}
export interface SceneNode extends SceneRect{
 id:string;kind:'group'|'box'|'text'|'path'|'raster';name:string;opacity?:number;children?:SceneNode[];clip?:boolean;
 color?:SceneColor;gradient?:SceneGradient;radii?:number[];border?:{color:SceneColor;width:number};shadows?:SceneShadow[];
 text?:string;family?:string;size?:number;weight?:number;italic?:boolean;letterSpacing?:number;lineHeight?:number;baseline?:number;
 d?:string;matrix?:number[];stroke?:{color:SceneColor;width:number;lineCap?:string;lineJoin?:string};fillRule?:string;reason?:string;
}
export interface SceneFont{family:string;weight:string;style:string;data:string;}
export interface CanvasScene{width:number;height:number;name:string;nodes:SceneNode[];fonts:SceneFont[];warnings:string[];}
function snapshotCanvasScene():CanvasScene{
 const warnings=new Set<string>(),fonts:SceneFont[]=[],colorCanvas=document.createElement('canvas'),colorContext=colorCanvas.getContext('2d',{willReadFrequently:true})!;
 colorCanvas.width=colorCanvas.height=1;
 const color=(value:string):SceneColor=>{colorContext.clearRect(0,0,1,1);colorContext.fillStyle='transparent';colorContext.fillStyle=value;colorContext.fillRect(0,0,1,1);const p=colorContext.getImageData(0,0,1,1).data;return[p[0]/255,p[1]/255,p[2]/255,p[3]/255];};
 const measure=document.createElement('canvas').getContext('2d')!;
 const width=Math.ceil(Math.max(innerWidth,document.documentElement.scrollWidth,document.body?.scrollWidth||0)),height=Math.ceil(Math.max(innerHeight,document.documentElement.scrollHeight,document.body?.scrollHeight||0));
 if(width>16000||height>16000||width*height>32000000)throw Error('页面过大，请分成多个页面后导出 Sketch');
 let serial=0,characters=0;
 const id=()=>String(++serial);
 const rect=(el:Element):SceneRect=>{const r=el.getBoundingClientRect();return{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};};
 const parts=(value:string)=>{let depth=0,start=0;const result:string[]=[];for(let i=0;i<value.length;i++){if(value[i]==='(')depth++;else if(value[i]===')')depth--;else if(value[i]===','&&!depth){result.push(value.slice(start,i).trim());start=i+1;}}result.push(value.slice(start).trim());return result;};
 const gradient=(value:string,width:number,height:number):SceneGradient|undefined=>{
  if(!/^linear-gradient\(/.test(value))return;const list=parts(value.slice(value.indexOf('(')+1,-1));let angle=180;
  if(/deg$/.test(list[0]))angle=parseFloat(list.shift()!);else if(list[0].startsWith('to ')){const directions:Record<string,number>={'to top':0,'to right':90,'to bottom':180,'to left':270,'to top right':45,'to right top':45,'to bottom right':135,'to right bottom':135,'to bottom left':225,'to left bottom':225,'to top left':315,'to left top':315};angle=directions[list.shift()!]??180;}
  if(list.some(stop=>{const match=/^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(stop)!;return !CSS.supports('color',match[1])||match[2]!==undefined&&(Number(match[2])<0||Number(match[2])>100);}))return;
  const stops=list.map((stop,index)=>{const match=/^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(stop)!;return {offset:Math.max(0,Math.min(1,match[2]===undefined?index/Math.max(1,list.length-1):Number(match[2])/100)),color:color(match[1])};});
  if(stops.length<2||stops.length>20)return;const radians=angle*Math.PI/180,dx=Math.sin(radians),dy=-Math.cos(radians),length=Math.abs(width*dx)+Math.abs(height*dy);
  return {from:[.5-dx*length/(width*2),.5-dy*length/(height*2)],to:[.5+dx*length/(width*2),.5+dy*length/(height*2)],stops};
 };
 const shadows=(value:string):SceneShadow[]=>value==='none'?[]:parts(value).slice(0,8).map(part=>{const c=part.match(/rgba?\([^)]*\)|#[a-f0-9]+/i)?.[0]||'black',numbers=part.replace(c,'').replace('inset','').trim().split(/\s+/).map(parseFloat);return{x:numbers[0]||0,y:numbers[1]||0,blur:numbers[2]||0,spread:numbers[3]||0,color:color(c),inset:part.includes('inset')};});
 const textRuns=(node:Text,style:CSSStyleDeclaration):SceneNode[]=>{
  const raw=node.textContent||'';characters+=raw.length;if(characters>20000)throw Error('文字过多，请分成多个页面导出 Sketch');
  const range=document.createRange(),result:SceneNode[]=[];let offset=0,run:{text:string;x:number;y:number;right:number;height:number}|undefined;
  const flush=()=>{if(!run?.text.trim()){run=undefined;return;}let text=run.text;if(style.textTransform==='uppercase')text=text.toUpperCase();else if(style.textTransform==='lowercase')text=text.toLowerCase();else if(style.textTransform==='capitalize')text=text.replace(/\b\p{L}/gu,c=>c.toUpperCase());
   measure.font=style.fontStyle+' '+style.fontWeight+' '+style.fontSize+' '+style.fontFamily;const metrics=measure.measureText(text),ascent=metrics.fontBoundingBoxAscent||parseFloat(style.fontSize)*.8,descent=metrics.fontBoundingBoxDescent||parseFloat(style.fontSize)*.2,scale=run.height/(ascent+descent);
   result.push({id:id(),kind:'text',name:text.trim().slice(0,60),text,x:run.x,y:run.y,width:run.right-run.x,height:run.height,color:color(style.color),family:style.fontFamily,size:parseFloat(style.fontSize)*scale,weight:Number(style.fontWeight)||400,italic:style.fontStyle!=='normal',letterSpacing:(parseFloat(style.letterSpacing)||0)*scale,lineHeight:parseFloat(style.lineHeight)||run.height,baseline:ascent*scale});run=undefined;
  };
  for(const ch of raw){range.setStart(node,offset);offset+=ch.length;range.setEnd(node,offset);const r=range.getClientRects()[0];if(!r?.width||!r.height)continue;const x=r.x+scrollX,y=r.y+scrollY;if(run&&(Math.abs(y-run.y)>.7||x<run.x-.7))flush();if(!run)run={text:ch,x,y,right:x+r.width,height:r.height};else{run.text+=ch;run.right=Math.max(run.right,x+r.width);}}
  flush();range.detach();return result;
 };
 const svgNodes=(svg:SVGSVGElement):SceneNode[]|undefined=>{
  if(svg.querySelector('use,text,image,foreignObject,filter,mask,clipPath'))return;
  const result:SceneNode[]=[];
  for(const el of svg.querySelectorAll('*')){
   if(!(el instanceof SVGGeometryElement))continue;const s=getComputedStyle(el);if(s.display==='none'||s.visibility==='hidden')continue;let d='';
   if(el instanceof SVGPathElement)d=el.getAttribute('d')||'';
   else if(el instanceof SVGRectElement){const x=el.x.baseVal.value,y=el.y.baseVal.value,w=el.width.baseVal.value,h=el.height.baseVal.value,rx=Math.min(el.rx.baseVal.value,w/2),ry=Math.min(el.ry.baseVal.value||rx,h/2);d=rx||ry?`M${x+rx} ${y}H${x+w-rx}Q${x+w} ${y} ${x+w} ${y+ry}V${y+h-ry}Q${x+w} ${y+h} ${x+w-rx} ${y+h}H${x+rx}Q${x} ${y+h} ${x} ${y+h-ry}V${y+ry}Q${x} ${y} ${x+rx} ${y}Z`:`M${x} ${y}h${w}v${h}h${-w}Z`;}
   else if(el instanceof SVGCircleElement||el instanceof SVGEllipseElement){const x=el.cx.baseVal.value,y=el.cy.baseVal.value,rx=el instanceof SVGCircleElement?el.r.baseVal.value:el.rx.baseVal.value,ry=el instanceof SVGCircleElement?rx:el.ry.baseVal.value;d=`M${x-rx} ${y}a${rx} ${ry} 0 1 0 ${rx*2} 0a${rx} ${ry} 0 1 0 ${-rx*2} 0Z`;}
   else if(el instanceof SVGLineElement)d=`M${el.x1.baseVal.value} ${el.y1.baseVal.value}L${el.x2.baseVal.value} ${el.y2.baseVal.value}`;
   else if(el instanceof SVGPolygonElement||el instanceof SVGPolylineElement){if(el.points.numberOfItems>1000)return;d=Array.from({length:el.points.numberOfItems},(_,i)=>{const p=el.points.getItem(i);return(i?'L':'M')+p.x+' '+p.y;}).join('')+(el instanceof SVGPolygonElement?'Z':'');}
   else return;
   const matrix=el.getScreenCTM();if(!matrix||s.fillRule==='evenodd'&&(d.match(/[Mm]/g)||[]).length>1||s.filter!=='none'||s.fill.startsWith('url')||s.stroke.startsWith('url')||s.strokeDasharray!=='none')return;
   let alpha=Number(s.opacity);for(let parent:Element|null=el.parentElement;parent&&parent!==svg;parent=parent.parentElement){if(Number(getComputedStyle(parent).opacity)!==1)return;}
   const fill=s.fill==='none'?undefined:color(s.fill),stroke=s.stroke==='none'?undefined:{color:color(s.stroke),width:(parseFloat(s.strokeWidth)||0)*Math.hypot(matrix.a,matrix.b),lineCap:s.strokeLinecap,lineJoin:s.strokeLinejoin};if(fill)fill[3]*=Number(s.fillOpacity);if(stroke)stroke.color[3]*=Number(s.strokeOpacity);
   result.push({id:id(),kind:'path',name:el.id||el.localName,...rect(el),d,matrix:[matrix.a,matrix.b,matrix.c,matrix.d,matrix.e+scrollX,matrix.f+scrollY],color:fill,stroke,fillRule:s.fillRule,opacity:alpha});
  }return result;
 };
 const visit=(el:Element,depth=0):SceneNode[]=>{
  if(serial>6000||depth>80)throw Error('页面图层过多，请分成多个页面导出');
  if(['SCRIPT','STYLE','LINK','META','HEAD','NOSCRIPT','TEMPLATE'].includes(el.tagName))return[];
  const s=getComputedStyle(el);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return[];
  const r=rect(el),name=(el.getAttribute('data-design-id')||el.getAttribute('aria-label')||el.id||el.localName).slice(0,120);
  if(!r.width||!r.height)return [...el.children].flatMap(child=>visit(child,depth+1));
  let reason=Number(s.opacity)<1?'透明合成':'';const grad=s.backgroundImage==='none'?undefined:gradient(s.backgroundImage,r.width,r.height);
  if(s.filter!=='none'||s.backdropFilter!=='none')reason='滤镜';else if(s.mixBlendMode!=='normal')reason='混合模式';else if(s.clipPath!=='none'||s.maskImage!=='none')reason='蒙版';else if(s.transform!=='none'||s.translate!=='none'||s.rotate!=='none'||s.scale!=='none')reason='变换';else if(s.backgroundImage!=='none'&&!grad)reason='背景图片或复杂渐变';
  for(const pseudo of ['::before','::after']){const css=getComputedStyle(el,pseudo);if(css.content!=='none'&&css.content!=='normal'&&css.display!=='none')reason=reason||'伪元素';}
  if(s.textShadow!=='none')reason=reason||'文字阴影';
  if(s.textDecorationLine!=='none'||s.webkitTextStrokeWidth&&parseFloat(s.webkitTextStrokeWidth)>0||s.backgroundClip==='text')reason=reason||'文字装饰';
  if(s.writingMode!=='horizontal-tb'||s.direction==='rtl'||s.fontVariantCaps!=='normal'||s.fontFeatureSettings!=='normal'||s.fontKerning==='none')reason=reason||'特殊文字排版';
  if([s.borderTopStyle,s.borderRightStyle,s.borderBottomStyle,s.borderLeftStyle].some(value=>!['none','hidden','solid'].includes(value))||s.borderImageSource!=='none'||s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0)reason=reason||'特殊边框';
  if(s.listStyleType!=='none'&&s.display==='list-item')reason=reason||'列表标记';
  if(grad&&(s.backgroundSize!=='auto'||s.backgroundPosition!=='0% 0%'||s.backgroundClip!=='border-box'||grad.stops.some(stop=>stop.color[3]<1)))reason=reason||'复杂渐变';
  if([s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomRightRadius,s.borderBottomLeftRadius].some(value=>value.includes(' ')||value.includes('%')&&Math.abs(r.width-r.height)>.5))reason=reason||'椭圆圆角';
  if(el instanceof HTMLImageElement||el instanceof HTMLCanvasElement||el instanceof HTMLVideoElement||el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||el instanceof HTMLSelectElement)reason=el.localName;
  let vector:SceneNode[]|undefined;if(el instanceof SVGSVGElement){vector=svgNodes(el);if(!vector)reason='复杂 SVG';}
  if(reason){const effects=shadows(s.boxShadow),pad=Math.ceil(Math.max(0,...effects.filter(effect=>!effect.inset).map(effect=>effect.blur*2+Math.max(Math.abs(effect.x),Math.abs(effect.y))+Math.max(0,effect.spread)),...(s.filter.match(/blur\(([^)]+)\)/g)||[]).map(value=>(parseFloat(value.slice(5))||0)*2)));warnings.add(reason+'已按局部图片保留');return[{id:id(),kind:'raster',name:name+' · '+reason,x:r.x-pad-(reason==='列表标记'?parseFloat(s.fontSize)*2:0),y:r.y-pad,width:r.width+pad*2+(reason==='列表标记'?parseFloat(s.fontSize)*2:0),height:r.height+pad*2,reason}];}
  const children:SceneNode[]=[],background=color(s.backgroundColor),radii=[s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomRightRadius,s.borderBottomLeftRadius].map(value=>Math.min((parseFloat(value)||0)*(value.includes('%')?r.width/100:1),r.width/2,r.height/2));
  const borders=[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth].map(parseFloat),uniform=borders.every(v=>v===borders[0])&&[s.borderTopColor,s.borderRightColor,s.borderBottomColor,s.borderLeftColor].every(c=>c===s.borderTopColor);
  if(background[3]||grad||s.boxShadow!=='none'||uniform&&borders[0])children.push({id:id(),kind:'box',name:'背景',...r,color:background,gradient:grad,radii,shadows:shadows(s.boxShadow),...(uniform&&borders[0]?{border:{width:borders[0],color:color(s.borderTopColor)}}:{})});
  if(!uniform){for(const [i,colorValue]of [s.borderTopColor,s.borderRightColor,s.borderBottomColor,s.borderLeftColor].entries()){const w=borders[i];if(!w)continue;const edge=[{x:r.x,y:r.y,width:r.width,height:w},{x:r.x+r.width-w,y:r.y,width:w,height:r.height},{x:r.x,y:r.y+r.height-w,width:r.width,height:w},{x:r.x,y:r.y,width:w,height:r.height}][i];children.push({id:id(),kind:'box',name:'边框',...edge,color:color(colorValue)});}}
  if(vector)children.push(...vector);else{
   const nodes=[...el.childNodes].sort((a,b)=>{const z=(node:Node)=>node instanceof Element?Number(getComputedStyle(node).zIndex)||0:0;return z(a)-z(b);});
   for(const child of nodes)if(child instanceof Text)children.push(...textRuns(child,s));else if(child instanceof Element)children.push(...visit(child,depth+1));
  }
  return [{id:id(),kind:'group',name,...r,opacity:Number(s.opacity),radii,children,clip:el!==document.body&&(['hidden','clip','scroll','auto'].includes(s.overflowX)||['hidden','clip','scroll','auto'].includes(s.overflowY))}];
 };
 const nodes=visit(document.body||document.documentElement);
 const rootStyle=getComputedStyle(document.documentElement),bodyStyle=getComputedStyle(document.body||document.documentElement),rootColor=color(rootStyle.backgroundColor),canvasColor=rootColor[3]?rootColor:color(bodyStyle.backgroundColor);
 if(canvasColor[3])nodes.unshift({id:id(),kind:'box',name:'页面底色',x:0,y:0,width,height,color:canvasColor});
 if(rootStyle.backgroundImage!=='none'){warnings.add('页面背景已按图片保留');nodes.splice(0,nodes.length,{id:id(),kind:'raster',name:'页面背景与内容',x:0,y:0,width,height,reason:'页面背景'});}
 const used=new Set<string>();const collect=(list:SceneNode[])=>{for(const n of list){if(n.family)for(const f of n.family.split(','))used.add(f.trim().replace(/^["']|["']$/g,'').toLowerCase());if(n.children)collect(n.children);}};collect(nodes);
 let fontBytes=0;const sheet=(value:CSSStyleSheet,depth=0)=>{if(depth>8)return;try{for(const rule of value.cssRules){if(rule instanceof CSSImportRule&&rule.styleSheet)sheet(rule.styleSheet,depth+1);else if(rule instanceof CSSFontFaceRule){const family=rule.style.fontFamily.replace(/^["']|["']$/g,'');if(!used.has(family.toLowerCase()))continue;const match=/url\(["']?(data:[^)"']+)["']?\)/.exec(rule.style.getPropertyValue('src'));if(match){fontBytes+=match[1].length;if(fontBytes>64*1024*1024)throw Error('字体资源过大');fonts.push({family,weight:rule.style.fontWeight||'400',style:rule.style.fontStyle||'normal',data:match[1]});}}}}catch(error){if(error instanceof Error&&error.message==='字体资源过大')throw error;warnings.add('部分字体无法转为轮廓，已保留画面参考');}};for(const value of document.styleSheets)sheet(value);
 return {width,height,name:document.title||'Design',nodes,fonts,warnings:[...warnings]};
}
export const CANVAS_SCENE_SCRIPT='('+snapshotCanvasScene.toString()+')()';
