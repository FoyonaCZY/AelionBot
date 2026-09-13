import type {AttachmentScope} from './attachment-types';
export interface PreviewFeedbackInput {
 requestId:string;scope:AttachmentScope;text:string;language?:'en'|'zh-CN'|'zh-TW';
 file:{name:string;path?:string;attachmentId?:string;page?:number;unsaved?:boolean};
 rect:{x:number;y:number;width:number;height:number};viewport:{width:number;height:number};
}
export function feedbackCaptureRect(rect:PreviewFeedbackInput['rect'],viewport:PreviewFeedbackInput['viewport'],image:{width:number;height:number}){
 const numbers=[rect?.x,rect?.y,rect?.width,rect?.height,viewport?.width,viewport?.height,image.width,image.height];
 if(numbers.some(value=>!Number.isFinite(value))||rect.x<0||rect.y<0||rect.width<1||rect.height<1||viewport.width<1||viewport.height<1||viewport.width>16384||viewport.height>16384||image.width<1||image.height<1||rect.x+rect.width>viewport.width+1||rect.y+rect.height>viewport.height+1)throw Error('预览截图范围无效');
 const sx=image.width/viewport.width,sy=image.height/viewport.height;if(Math.abs(sx/sy-1)>.025)throw Error('窗口尺寸已变化，请重新发送');
 const x=Math.max(0,Math.ceil(rect.x*sx-1e-7)),y=Math.max(0,Math.ceil(rect.y*sy-1e-7));
 const width=Math.min(image.width,Math.floor((rect.x+rect.width)*sx+1e-7))-x,height=Math.min(image.height,Math.floor((rect.y+rect.height)*sy+1e-7))-y;
 if(width<1||height<1)throw Error('预览区域不可见');return {x,y,width,height};
}
export function previewFeedbackMessage(input:Pick<PreviewFeedbackInput,'text'|'file'|'language'>){
 if(typeof input.text!=='string'||!input.text.trim()||input.text.length>12000||!input.file||typeof input.file.name!=='string'||!input.file.name.trim()||input.file.name.length>300||input.file.path!==undefined&&(typeof input.file.path!=='string'||input.file.path.length>1500)||input.file.attachmentId!==undefined&&(typeof input.file.attachmentId!=='string'||input.file.attachmentId.length>100)||input.file.page!==undefined&&(!Number.isInteger(input.file.page)||input.file.page<1||input.file.page>100000))throw Error('修改意见或文件信息无效');
 const clean=(text:string)=>text.replace(/[\r\n\u0000-\u001f]/g,' ');
 const en=input.language==='en',tw=input.language==='zh-TW';
 return (en?'Preview: ':tw?'預覽：':'预览：')+clean(input.file.name)+(input.file.page?(en?' · Page ':' · 第 ')+input.file.page+(en?'':' 页'):'')+'\n'+input.text.trim()+'\n'+(input.file.path?'\n'+(en?'File: ':'文件：')+clean(input.file.path):'')+(input.file.attachmentId?'\n'+(en?'Source attachment: ':tw?'原附件：':'原附件：')+clean(input.file.attachmentId):'')+'\n'+(en?'Screenshot: visible area only.':tw?'截圖僅包含目前可見範圍。':'截图仅包含当前可见范围。')+(input.file.unsaved?(en?' Includes unsaved edits.':tw?'畫面含未儲存的修改。':'画面含未保存的修改。'):'');
}
