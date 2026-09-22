import type {DesignComment,DesignSession,DesignTaskKind} from './designer-types';
import type {PreviewAnnotation} from './preview-editor-types';
export interface DesignWorkspaceFile{name:string;path:string;size:number;modifiedAt?:string;}
const htmlFile=(file:DesignWorkspaceFile)=>/\.html?$/i.test(file.name);
const notHidden=(file:DesignWorkspaceFile)=>!file.path.split('/').some(part=>part.startsWith('.')||part==='node_modules');
export function emptyCanvasHtml(_kind?:DesignTaskKind,_title=''){
 return '<!doctype html><html><meta charset="utf-8"><title></title><style>html,body{margin:0;height:100%;background:#fff}</style><body data-design-id="empty-canvas"></body></html>';
}
export function pickDesignPreviewFiles(kind:DesignTaskKind,files:DesignWorkspaceFile[],artifacts:{path:string;name:string;kind:string}[]=[]){
 const live=files.filter(file=>notHidden(file)&&htmlFile(file));
 const published=artifacts.filter(item=>item.kind==='html').map(item=>({name:item.name,path:item.path,size:0}));
 const pool=[...live,...published.filter(item=>!live.some(file=>file.path===item.path))];
 if(!pool.length)return [] as DesignWorkspaceFile[];
 const index=pool.find(file=>/^index\.html?$/i.test(file.name));
 if(kind==='ppt'){
  const deck=pool.find(file=>/deck|slides|presentation/i.test(file.name))||pool.find(file=>htmlFile(file));
  return deck?[deck,...pool.filter(file=>file.path!==deck.path)]:[];
 }
 if(kind==='document'){
  const doc=pool.find(file=>/document|article|index/i.test(file.name))||index||pool[0];
  return [doc,...pool.filter(file=>file.path!==doc.path)];
 }
 const entry=index||pool[0];
 return [entry,...pool.filter(file=>file.path!==entry.path)];
}
export function designPreviewSignature(files:DesignWorkspaceFile[]){return files.map(file=>file.path+':'+file.size).join('|');}
export function commentDesignId(annotation:Pick<PreviewAnnotation,'selector'|'text'>&{designId?:string}){
 if(annotation.designId&&annotation.designId.length<=120)return annotation.designId;
 const match=annotation.selector?.match(/data-design-id\s*=\s*['"]([^'"]+)['"]/i)||annotation.selector?.match(/\[data-design-id=["']([^"']+)["']\]/i);
 return match?.[1];
}
/** Keep repeated submissions idempotent without merging different marked regions. */
export function sameOpenDesignComment(existing:DesignComment,comment:DesignComment){
 if(existing.status!=='open'||existing.path!==comment.path||existing.text!==comment.text)return false;
 const a=existing.annotation,b=comment.annotation;
 if(a?.id&&b?.id)return a.id===b.id;
 if(a?.id||b?.id)return false;
 const target=(value:DesignComment)=>{
  const mark=value.annotation;
  const geometry=mark?{type:mark.type,x:mark.x,y:mark.y,w:mark.w,h:mark.h,end:mark.end,points:mark.points,sourceWidth:mark.sourceWidth,sourceHeight:mark.sourceHeight}:undefined;
  return JSON.stringify({designId:value.designId,selector:value.selector,page:value.page,geometry});
 };
 return target(existing)===target(comment);
}
export function commentsFromAnnotations(path:string,text:string,annotations:PreviewAnnotation[]=[],existing:DesignComment[]=[]):DesignComment[]{
 const now=new Date().toISOString(),comments:DesignComment[]=[];
 for(const item of annotations){
  const designId=commentDesignId(item),selector=item.selector?.slice(0,3000),body=(item.text?.trim()||text).trim().slice(0,4000);
  if(!body)continue;
  const comment:DesignComment={id:'comment-'+crypto.randomUUID(),path,text:body,createdAt:now,status:'open',annotation:structuredClone(item),...(designId?{designId}:{}),...(selector?{selector}:{}),...(item.page?{page:item.page}:{})};
  if(existing.concat(comments).some(previous=>sameOpenDesignComment(previous,comment)))continue;
  comments.push(comment);
 }
 return comments;
}
export function commentScope(comments:DesignComment[]){
 return comments.filter(comment=>comment.status==='open').map(comment=>({id:comment.id,path:comment.path,designId:comment.designId,selector:comment.selector,text:comment.text,page:comment.page,annotation:comment.annotation}));
}
export function deviceFrameKind(kind:DesignTaskKind):'phone'|'slide'|'page'|undefined{
 if(kind==='mobile')return 'phone';
 if(kind==='ppt')return 'slide';
 if(kind==='document')return 'page';
}
export function previewFeedbackAlwaysVisible(_modal?:boolean){return true;}
export function primaryDesignArtifact(kind:DesignTaskKind,path:string){
 if(kind==='ppt')return /\.pptx$/i.test(path);
 return /\.html?$/i.test(path);
}
