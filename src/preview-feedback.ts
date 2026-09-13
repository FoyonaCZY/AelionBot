import {feedbackWebUrl} from './web-preview';
import type {AttachmentScope} from './attachment-types';
export interface PreviewFeedbackInput {
 requestId:string;scope:AttachmentScope;text:string;language?:'en'|'zh-CN'|'zh-TW';
 file:{name:string;url?:string;path?:string;attachmentId?:string;page?:number;unsaved?:boolean};
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
 if(typeof input.text!=='string'||!input.text.trim()||input.text.length>12000||!input.file||typeof input.file.name!=='string'||!input.file.name.trim()||input.file.name.length>300||input.file.path!==undefined&&(typeof input.file.path!=='string'||input.file.path.length>1500)||input.file.attachmentId!==undefined&&(typeof input.file.attachmentId!=='string'||input.file.attachmentId.length>100)||input.file.url!==undefined&&(typeof input.file.url!=='string'||input.file.url.length>4096)||input.file.page!==undefined&&(!Number.isInteger(input.file.page)||input.file.page<1||input.file.page>100000))throw Error('修改意见或文件信息无效');
 const clean=(text:string)=>text.replace(/[\r\n\u0000-\u001f]/g,' ');
 const en=input.language==='en',tw=input.language==='zh-TW';
 return (en?'Preview: ':tw?'預覽：':'预览：')+clean(input.file.name)+(input.file.page?(en?' · Page ':' · 第 ')+input.file.page+(en?'':' 页'):'')+'\n'+input.text.trim()+'\n'+(input.file.path?'\n'+(en?'File: ':'文件：')+clean(input.file.path):'')+(input.file.url?'\nURL: '+clean(feedbackWebUrl(input.file.url)):'')+(input.file.attachmentId?'\n'+(en?'Source attachment: ':tw?'原附件：':'原附件：')+clean(input.file.attachmentId):'')+'\n'+(en?'Screenshot: visible area only.':tw?'截圖僅包含目前可見範圍。':'截图仅包含当前可见范围。')+(input.file.unsaved?(en?' Includes unsaved edits.':tw?'畫面含未儲存的修改。':'画面含未保存的修改。'):'');
}

/** Presentation only: keep the original message content available to the Agent. */
export function previewFeedbackDisplay(message:{content:string;previewPrompt?:string;attachments?:Array<{name:string;mime:string}>;mentions?:Array<import('./peer-types').BotMention>;role?:string;sender?:{kind:string}}){
 const original={content:message.content,mentions:message.mentions};
 if(message.role&&message.role!=='user'||message.sender&&message.sender.kind!=='user')return original;
 let prompt=message.previewPrompt,offset=0;
 if(prompt===undefined){
  // Recognize only our old screenshot-feedback envelope, not ordinary user prose.
  if(!message.attachments?.some(file=>/^preview-[a-f0-9]{8}\.png$/.test(file.name)&&file.mime==='image/png'))return original;
  const header=/^(?:预览：|預覽：|Preview: )[^\r\n]+\r?\n/.exec(message.content);if(!header)return original;
  const rest=message.content.slice(header[0].length).replaceAll('\r\n','\n'),split=rest.lastIndexOf('\n\n');if(split<0)return original;
  const tail=rest.slice(split+2).split('\n').filter(Boolean),footer=tail.at(-1)||'';
  if(!/^(?:截图仅包含当前可见范围。|截圖僅包含目前可見範圍。|Screenshot: visible area only\.)(?:画面含未保存的修改。|畫面含未儲存的修改。| Includes unsaved edits\.)?$/.test(footer))return original;
  if(tail.slice(0,-1).some(line=>!(/^(?:文件：|File: )\S.+$/.test(line)||/^(?:原附件：|Source attachment: )[a-f0-9-]{36}$/.test(line))))return original;
  prompt=rest.slice(0,split).trimEnd();offset=header[0].length;
 }else if(prompt!==message.content){offset=message.content.indexOf(prompt,message.content.indexOf('\n')+1);if(offset<0)offset=0;}
 if(prompt===message.content)return original;
 return {content:prompt,mentions:message.mentions?.filter(item=>item.start>=offset&&item.end<=offset+prompt!.length).map(item=>({...item,start:item.start-offset,end:item.end-offset}))};
}