export type CanvasExportFormat='pdf'|'png'|'svg'|'html'|'zip'|'sketch';
export interface CanvasExportInput{id:string;path:string;format:CanvasExportFormat;viewport?:{width:number;height:number};}
export interface CanvasExportResult{path:string;format:CanvasExportFormat;warnings:string[];}
export const CANVAS_EXPORT_FORMATS:readonly CanvasExportFormat[]=['sketch','pdf','png','svg','html','zip'];
export function canvasExportViewport(value?:{width:number;height:number}){
 if(!value)return {width:1280,height:900};
 if(!Number.isFinite(value.width)||!Number.isFinite(value.height))throw Error('导出画布尺寸无效');
 return {width:Math.max(320,Math.min(2560,Math.round(value.width))),height:Math.max(320,Math.min(1600,Math.round(value.height)))};
}
export function canvasDesignSource(item:{name:string;designSessionId?:string;workspace?:{botId:string;path:string}}){
 if(!/\.html?$/i.test(item.name)||!item.workspace)return;
 const match=/^designers\/([^/]+)\/([^/]+)\//.exec(item.workspace.path);
 const id=item.designSessionId||match?.[2];if(!id||match&&match[1]!==item.workspace.botId)return;
 return {id,path:item.workspace.path};
}
