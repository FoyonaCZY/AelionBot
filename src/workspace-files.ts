export interface WorkspaceFileEntry{name:string;path:string;kind:'directory'|'file';size:number;modifiedAt:string;}
export interface WorkspaceDirectory{path:string;entries:WorkspaceFileEntry[];truncated:boolean;}
/** Desktop session launchers and hidden session dirs are not user deliverables. */
export function isRunArtifact(path:string){
  const value=path.replaceAll('\\','/').replace(/^\/+/,'');
  if(!value)return false;
  const parts=value.split('/').filter(Boolean);
  if(!parts.length||parts.some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))return false;
  return !(parts.length===2&&parts[0]==='Desktop'&&parts[1].endsWith('.desktop'));
}
