import {basename,dirname,join} from 'node:path';
import {writeFileSync,renameSync,unlinkSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {CANVAS_EXPORT_FORMATS,canvasExportViewport,type CanvasExportInput,type CanvasExportResult} from '../../src/canvas-export';
import type {DesignSession} from '../../src/designer-types';
import type {DesignerFiles} from './designer-files';
import type {DesignFonts} from './design-fonts';
import {designHtmlPath} from './design-font-application';
import {prepareDesignHtml,exportDesignHtmlBundle} from './design-export';
export class CanvasExports{
 constructor(private ops:{getSession:(id:string)=>DesignSession;files:DesignerFiles;fonts:DesignFonts;choosePath:(input:{title:string;name:string;extension:string})=>Promise<string|null>;render:(html:string,format:'pdf'|'png'|'svg'|'sketch',viewport:{width:number;height:number},licenses?:Record<string,Buffer>)=>Promise<{bytes:Buffer;warnings:string[]}>;}){}
 async export(input:CanvasExportInput):Promise<CanvasExportResult|null>{
  if(!input||!CANVAS_EXPORT_FORMATS.includes(input.format)||typeof input.id!=='string'||typeof input.path!=='string')throw Error('导出参数无效');
  const session=this.ops.getSession(input.id),path=await designHtmlPath(this.ops.files,session,input.path),viewport=canvasExportViewport(input.viewport),format=input.format;
  const labels={pdf:'PDF 文档',png:'PNG 图片',svg:'SVG 矢量图',sketch:'Sketch 设计文件',html:'独立 HTML',zip:'项目 ZIP'};
  const target=await this.ops.choosePath({title:'导出'+labels[format],name:basename(path).replace(/\.html?$/i,'')+'.'+format,extension:format});if(!target)return null;
  if(!target.toLowerCase().endsWith('.'+format))throw Error('文件扩展名必须为 .'+format);
  if(this.ops.getSession(input.id)!==session)throw Error('设计任务已更改，请重新导出');
  const source={rootDir:session.workspaceDir!,htmlPath:this.ops.files.absolute(session,path)};let bytes:Buffer,warnings:string[]=[];
  if(format==='zip')bytes=await exportDesignHtmlBundle(source);
  else{const html=await prepareDesignHtml(source);if(format==='html')bytes=Buffer.from(html);else{
   const licenses:Record<string,Buffer>={};if(format==='sketch')for(const font of this.ops.fonts.list(session)){const license=font.license.path;if(license&&/^assets\/fonts\/[a-zA-Z0-9_-]+\/LICENSE\.txt$/.test(license)&&font.files.some(file=>dirname(file.path)===dirname(license)))licenses[font.id+'.txt']=await this.ops.files.read(session.botId,this.ops.files.virtual(session,license),256*1024);}
   const result=await this.ops.render(html,format,viewport,licenses);bytes=result.bytes;warnings=result.warnings;
  }}
  if(!bytes.length||bytes.length>120*1024*1024)throw Error('导出文件为空或超过大小限制');
  const temporary=join(dirname(target),'.aelion-export-'+randomUUID()+'.tmp');
  try{writeFileSync(temporary,bytes,{flag:'wx'});renameSync(temporary,target);}finally{if(existsSync(temporary))unlinkSync(temporary);}
  return {path:target,format,warnings};
 }
}
