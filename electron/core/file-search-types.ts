export interface FileSearchRequest {
  kind:'find'|'search';root:string;file?:string;dataDir:string;homeDir:string;glob:string;query?:string;regex:boolean;caseSensitive:boolean;respectIgnore:boolean;outputMode:'content'|'files'|'count';contextLines:number;offset:number;limit:number;secrets:string[];
}
export interface FileMatch {path:string;line:number;column:number;offset:number;text:string;textStartColumn:number;truncated:boolean;before?:string[];after?:string[];}
export interface FileSearchResult {
  path:string;files?:string[];matches?:FileMatch[];counts?:Array<{path:string;count:number}>;
  offset:number;nextOffset:number;total:number;eof:boolean;truncated:boolean;scanLimited:boolean;limitReason?:string;
  visitedEntries:number;scannedFiles:number;scannedBytes:number;skipped:{ignored:number;sensitive:number;links:number;binary:number;large:number;unreadable:number};
}
