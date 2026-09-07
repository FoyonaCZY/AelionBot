export interface DiagnosticPreview {
  id:string;createdAt:string;fileName:string;summary:string;archiveBytes:number;
  files:Array<{name:string;bytes:number;truncated?:boolean}>;
}
