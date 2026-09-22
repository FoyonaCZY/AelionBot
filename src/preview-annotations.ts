import type {PreviewAnnotation} from './preview-editor-types';
export function validateAnnotations(value:unknown):PreviewAnnotation[]{
 if(!Array.isArray(value)||value.length>100||JSON.stringify(value).length>1_000_000)throw Error('标注过多');
 const ids=new Set<string>();
 return value.map(raw=>{
  if(!raw||typeof raw.id!=='string'||!raw.id||raw.id.length>100||ids.has(raw.id)||!['rect','arrow','pen','text','element'].includes(raw.type)||!/^#[\da-f]{6}$/i.test(raw.color))throw Error('标注无效');ids.add(raw.id);
  const point=(p:any)=>{if(!p||![p.x,p.y].every(n=>Number.isFinite(n)&&n>=-1&&n<=100))throw Error('标注坐标无效');return{x:p.x,y:p.y};};
  const p=point(raw);
  if(raw.w!==undefined&&(!Number.isFinite(raw.w)||raw.w<0||raw.w>100)||raw.h!==undefined&&(!Number.isFinite(raw.h)||raw.h<0||raw.h>100))throw Error('标注范围无效');
  for(const key of ['sourceWidth','sourceHeight'] as const)if(raw[key]!==undefined&&(!Number.isFinite(raw[key])||raw[key]<1||raw[key]>10_000_000))throw Error('标注画布尺寸无效');
  if(raw.points!==undefined&&(!Array.isArray(raw.points)||raw.points.length>3000))throw Error('画笔点数过多');
  for(const [key,limit] of [['text',1000],['selector',3000],['designId',120],['elementLabel',160],['elementText',1000]] as const)if(raw[key]!==undefined&&(typeof raw[key]!=='string'||raw[key].length>limit))throw Error('标注文字过长');
  return {id:raw.id,type:raw.type,...p,color:raw.color,...(raw.w!==undefined?{w:raw.w}:{}),...(raw.h!==undefined?{h:raw.h}:{}),...(raw.end?{end:point(raw.end)}:{}),...(raw.points?{points:raw.points.map(point)}:{}),...(raw.text?{text:raw.text}:{}),...(raw.selector?{selector:raw.selector}:{}),...(raw.designId?{designId:raw.designId}:{}),...(raw.sourceWidth?{sourceWidth:raw.sourceWidth}:{}),...(raw.sourceHeight?{sourceHeight:raw.sourceHeight}:{}),...(raw.elementLabel?{elementLabel:raw.elementLabel}:{}),...(raw.elementText?{elementText:raw.elementText}:{}),...(Number.isInteger(raw.page)&&raw.page>0?{page:raw.page}:{})};
 });
}
export function annotationContext(annotations:PreviewAnnotation[]){return validateAnnotations(annotations).map((a,i)=>`#${i+1} ${a.type}${a.page?' · page '+a.page:''}${a.designId?' · data-design-id='+a.designId:''}${a.selector?' · '+a.selector:''}${a.elementLabel?' · element='+JSON.stringify(a.elementLabel):''}${a.elementText?' · content='+JSON.stringify(a.elementText):''}${a.text?' · note='+JSON.stringify(a.text):''} [${[a.x,a.y,a.w??0,a.h??0].map(n=>n.toFixed(4)).join(', ')}]${a.sourceWidth&&a.sourceHeight?' · source '+a.sourceWidth+'×'+a.sourceHeight+' CSS px':''}${a.end?' · end ['+a.end.x.toFixed(4)+', '+a.end.y.toFixed(4)+']':''}`).join('\n');}
