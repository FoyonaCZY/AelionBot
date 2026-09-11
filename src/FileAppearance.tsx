import './file-cards.css';
import {useI18n} from './i18n';

type FileKind='document'|'slides'|'sheet'|'pdf'|'code'|'image'|'archive'|'audio'|'video'|'file';
const formats:Record<string,[FileKind,string]>={
  pdf:['pdf','PDF 文档'],
  ppt:['slides','演示文稿'],pptx:['slides','演示文稿'],key:['slides','演示文稿'],odp:['slides','演示文稿'],
  doc:['document','Word 文档'],docx:['document','Word 文档'],odt:['document','文档'],rtf:['document','文档'],txt:['document','文本文件'],md:['document','Markdown'],
  xls:['sheet','电子表格'],xlsx:['sheet','电子表格'],csv:['sheet','CSV 表格'],ods:['sheet','电子表格'],
  py:['code','Python'],js:['code','JavaScript'],jsx:['code','React'],ts:['code','TypeScript'],tsx:['code','React'],html:['code','HTML'],css:['code','CSS'],json:['code','JSON'],yaml:['code','YAML'],yml:['code','YAML'],sh:['code','Shell'],sql:['code','SQL'],ipynb:['code','Notebook'],
  png:['image','图片'],jpg:['image','图片'],jpeg:['image','图片'],gif:['image','图片'],webp:['image','图片'],svg:['image','矢量图片'],avif:['image','图片'],bmp:['image','图片'],heic:['image','图片'],
  zip:['archive','压缩文件'],rar:['archive','压缩文件'],'7z':['archive','压缩文件'],tar:['archive','压缩文件'],gz:['archive','压缩文件'],
  mp3:['audio','音频'],wav:['audio','音频'],m4a:['audio','音频'],flac:['audio','音频'],ogg:['audio','音频'],
  mp4:['video','视频'],mov:['video','视频'],webm:['video','视频'],mkv:['video','视频'],avi:['video','视频']
};
const mimeFormats:Record<string,[FileKind,string,string]>={
  'application/pdf':['pdf','PDF 文档','PDF'],
  'application/msword':['document','Word 文档','DOC'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['document','Word 文档','DOCX'],
  'application/vnd.ms-powerpoint':['slides','演示文稿','PPT'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':['slides','演示文稿','PPTX'],
  'application/vnd.ms-excel':['sheet','电子表格','XLS'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['sheet','电子表格','XLSX']
};
function appearance(name:string,mime=''){
  const suffix=name.match(/(?<=.)\.([a-z\d]{1,10})$/i)?.[1]||'';
  const format=formats[suffix.toLowerCase()];
  const mimeType=mime.split(';')[0].toLowerCase();
  const fallback=mimeFormats[mimeType]||(mimeType.startsWith('image/')?['image','图片','IMG']:mimeType.startsWith('audio/')?['audio','音频','AUDIO']:mimeType.startsWith('video/')?['video','视频','VIDEO']:mimeType.startsWith('text/')?['document','文本文件','TXT']:['file','文件','FILE']) as [FileKind,string,string];
  return {kind:format?.[0]||fallback[0],label:format?.[1]||fallback[1],badge:suffix.length>0&&suffix.length<=5?suffix.toUpperCase():fallback[2],suffix:suffix?`.${suffix}`:''};
}
export const fileSize=(value:number)=>value<1024?`${value} B`:value<1048576?`${Math.round(value/102.4)/10} KB`:`${Math.round(value/104857.6)/10} MB`;

export function FileTypeBadge({name,mime}:{name:string;mime?:string}){
  const {kind,badge}=appearance(name,mime);
  return <span className={`file-type-badge file-type-${kind}`} aria-hidden="true">
    <svg viewBox="0 0 36 44" fill="none"><path d="M5 1h17l13 13v25a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4Z" className="file-type-paper"/><path d="M22 1v9a4 4 0 0 0 4 4h9" className="file-type-fold"/><path d="M9 20h13M9 24h9" className="file-type-lines"/></svg>
    <span className="file-type-label">{badge}</span>
  </span>;
}

export function FileInfo({name,size,mime,compact=false}:{name:string;size:number;mime?:string;compact?:boolean}){
  const {t}=useI18n();
  const {label,suffix}=appearance(name,mime);
  return <span className="file-tile-copy">
    <strong className="file-tile-name" title={name}><span>{suffix?name.slice(0,-suffix.length):name}</span>{suffix&&<span className="file-tile-extension">{suffix}</span>}</strong>
    {!compact&&<small className="file-tile-meta"><span>{t(label)}</span><span aria-hidden="true">·</span><span>{fileSize(size)}</span></small>}
  </span>;
}

export function FilePreviewHint(){
  return <svg className="file-preview-hint" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>;
}
