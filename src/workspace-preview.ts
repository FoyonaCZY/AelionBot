import type {PreviewItem} from './FilePreviewContext';
import type {WorkspaceFileEntry} from './workspace-files';
export function workspacePreviewItem(botId:string,file:Pick<WorkspaceFileEntry,'name'|'path'|'size'>):PreviewItem{
  const input={botId,path:file.path};
  return {id:`artifact:${botId}:${file.path}`,name:file.name,size:file.size,workspace:input,load:()=>window.aelion.previewFile(input),save:()=>window.aelion.exportFile(input),openInComputer:()=>window.aelion.openFile(input)};
}
