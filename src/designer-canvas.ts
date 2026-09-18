import type {DesignComment,DesignSession,DesignTaskKind} from './designer-types';
import type {PreviewAnnotation} from './preview-editor-types';
export interface DesignWorkspaceFile{name:string;path:string;size:number;modifiedAt?:string;}
const htmlFile=(file:DesignWorkspaceFile)=>/\.html?$/i.test(file.name);
const notHidden=(file:DesignWorkspaceFile)=>!file.path.split('/').some(part=>part.startsWith('.')||part==='node_modules');
export function emptyCanvasHtml(kind:DesignTaskKind,title=''){
 const escape=(value:string)=>value.replace(/[&<>"']/g,ch=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));
 const label=kind==='ppt'?'幻灯舞台':kind==='mobile'?'移动端画布':kind==='document'?'文档画布':kind==='clone'?'复刻画布':'网页画布';
 const hint=kind==='ppt'?'生成中的幻灯片会按页出现在这里。':kind==='mobile'?'生成中的页面会放进设备框。':kind==='document'?'多页文档会在这里分页预览。':kind==='clone'?'复刻稿出现后会立刻渲染。':'文件一写入就会出现在这里。';
 const stage=kind==='ppt'
  ?'<div class="stage slide" data-design-id="empty-slide"><em>16:9</em><strong></strong></div>'
  :kind==='mobile'
   ?'<div class="phone" data-design-id="device-frame"><i></i><div class="screen"></div></div>'
   :'<div class="stage page" data-design-id="empty-page"><strong></strong></div>';
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(label)}</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100%;display:grid;place-items:center;background:#ece8de;color:#5c5a52;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
.wrap{text-align:center;padding:32px 24px}.wrap p{margin:10px 0 0;opacity:.72;font-size:13px}
.stage{width:min(72vw,560px);aspect-ratio:${kind==='ppt'?'16/9':'4/3'};margin:22px auto 0;border:1px dashed #c9c3b4;background:#fbfaf5;display:grid;place-items:center;color:#b3ad9f}
.stage.slide{border-radius:4px}.stage.page{border-radius:8px;aspect-ratio:1/1.25;max-height:420px}
.phone{width:220px;height:440px;margin:22px auto 0;padding:18px 12px 24px;border-radius:32px;background:#2c2c28;box-shadow:0 18px 40px #0002}
.phone i{display:block;width:64px;height:8px;margin:0 auto 12px;border-radius:8px;background:#111}
.phone .screen{height:calc(100% - 20px);border-radius:18px;background:#f7f4ea;border:1px dashed #d5d0c4}
</style><body><div class="wrap" data-design-id="empty-canvas"><div>${escape(label)}</div><p>${escape(hint)}${title?` · ${escape(title)}`:''}</p>${stage}</div></body></html>`;
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
export function commentsFromAnnotations(path:string,text:string,annotations:PreviewAnnotation[]=[],existing:DesignComment[]=[]):DesignComment[]{
 const now=new Date().toISOString(),comments:DesignComment[]=[];
 for(const [index,item] of annotations.entries()){
  if(!(item.type==='element'||item.selector||item.text))continue;
  const designId=commentDesignId(item),selector=item.selector?.slice(0,3000),body=(item.text||text).trim().slice(0,4000);
  if(!body||existing.concat(comments).some(comment=>comment.status==='open'&&comment.path===path&&comment.designId===designId&&comment.text===body))continue;
  comments.push({id:`comment-${item.id||index}`,path,text:body,createdAt:now,status:'open',...(designId?{designId}:{}),...(selector?{selector}:{}),...(item.page?{page:item.page}:{})});
 }
 return comments;
}
export function commentScope(comments:DesignComment[]){
 return comments.filter(comment=>comment.status==='open').map(comment=>({id:comment.id,path:comment.path,designId:comment.designId,selector:comment.selector,text:comment.text,page:comment.page}));
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
