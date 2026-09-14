import type {PreviewAnnotation} from './preview-editor-types';
export function validateAnnotations(value:unknown):PreviewAnnotation[]{
 if(!Array.isArray(value)||value.length>100||JSON.stringify(value).length>1_000_000)throw Error('标注过多');
 return value.map(raw=>{if(!raw||typeof raw.id!=='string'||raw.id.length>100||!['rect','arrow','pen','text','element'].includes(raw.type)||!/^#[\da-f]{6}$/i.test(raw.color))throw Error('标注无效');
 const point=(p:any)=>{if(!p||![p.x,p.y].every(n=>Number.isFinite(n)&&n>=-1&&n<=100))throw Error('标注坐标无效');return{x:p.x,y:p.y};};
 const p=point(raw);if(raw.w!==undefined&&(!Number.isFinite(raw.w)||raw.w<0||raw.w>100)||raw.h!==undefined&&(!Number.isFinite(raw.h)||raw.h<0||raw.h>100))throw Error('标注范围无效');
 if(raw.points!==undefined&&(!Array.isArray(raw.points)||raw.points.length>3000))throw Error('画笔点数过多');
 if(raw.text!==undefined&&(typeof raw.text!=='string'||raw.text.length>1000)||raw.selector!==undefined&&(typeof raw.selector!=='string'||raw.selector.length>3000))throw Error('标注文字过长');
 return {id:raw.id,type:raw.type,...p,color:raw.color,...(raw.w!==undefined?{w:raw.w}:{}),...(raw.h!==undefined?{h:raw.h}:{}),...(raw.end?{end:point(raw.end)}:{}),...(raw.points?{points:raw.points.map(point)}:{}),...(raw.text?{text:raw.text}:{}),...(raw.selector?{selector:raw.selector}:{}),...(Number.isInteger(raw.page)&&raw.page>0?{page:raw.page}:{})};});
}
export function annotationContext(annotations:PreviewAnnotation[]){return validateAnnotations(annotations).map((a,i)=>`#${i+1} ${a.type}${a.page?' · page '+a.page:''}${a.selector?' · '+a.selector:''}${a.text?' · '+a.text:''} [${[a.x,a.y,a.w??0,a.h??0].map(n=>n.toFixed(4)).join(', ')}]`).join('\n');}
