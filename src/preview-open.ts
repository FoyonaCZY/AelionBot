export type PreviewOpenTarget={kind:'workspace';botId:string;path:string}|{kind:'attachment';id:string};
export type PreviewOpenAction='default'|'choose'|'folder';
export interface PreviewOpenInput{target:PreviewOpenTarget;action:PreviewOpenAction;}
export function previewOpenTarget(item:{id:string;workspace?:{botId:string;path:string}}):PreviewOpenTarget|undefined{
 if(item.workspace)return {kind:'workspace',...item.workspace};
 if(item.id.startsWith('attachment:'))return {kind:'attachment',id:item.id.slice(11)};
}
