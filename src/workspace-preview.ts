import type {PreviewItem} from './FilePreviewContext';
import type {WorkspaceFileEntry} from './workspace-files';
import {sourceTextFile} from './source-language';
export function workspacePreviewItem(botId:string,file:Pick<WorkspaceFileEntry,'name'|'path'|'size'>):PreviewItem{
  const input={botId,path:file.path};
  return {id:`artifact:${botId}:${file.path}`,name:file.name,size:file.size,workspace:input,load:()=>window.aelion.previewFile(input),save:()=>window.aelion.exportFile(input),openInComputer:()=>window.aelion.openFile(input),...(sourceTextFile(file.name)?{editor:{read:()=>window.aelion.readEditableFile(input),write:(edit:import('./editable-text').TextEdit)=>window.aelion.saveEditableFile({...input,edit})}}:{})};
}
