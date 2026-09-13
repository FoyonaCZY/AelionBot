export interface MentionFile {path:string;relativePath:string;}
export interface MentionFileSearch {workspaceDir:string;files:MentionFile[];truncated:boolean;}
export function fileMentionText(file:MentionFile){return JSON.stringify(file.path.replaceAll('\\','/'));}
