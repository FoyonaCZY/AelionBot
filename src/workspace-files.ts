export interface WorkspaceFileEntry{name:string;path:string;kind:'directory'|'file';size:number;modifiedAt:string;}
export interface WorkspaceDirectory{path:string;entries:WorkspaceFileEntry[];truncated:boolean;}
