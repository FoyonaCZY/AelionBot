export type PreviewMode='browse'|'annotate'|'edit';
export type AnnotationTool='rect'|'arrow'|'pen'|'text'|'element';
export interface AnnotationPoint{x:number;y:number;}
export interface PreviewAnnotation{id:string;type:AnnotationTool;x:number;y:number;w?:number;h?:number;end?:AnnotationPoint;points?:AnnotationPoint[];text?:string;color:string;page?:number;selector?:string;}
export interface DomTarget{tag:string;path:string[];html:string;}
export interface DomEdit{before:DomTarget;after:string;}
export interface PreviewElement{id:string;tag:string;label:string;parentId?:string;path:string[];attributes:Record<string,string>;html:string;truncated:boolean;text:string;leaf:boolean;styles:Record<string,string>;bounds:{x:number;y:number;width:number;height:number};}
export interface PreviewTreeNode{id:string;label:string;tag:string;hasChildren:boolean;}
export interface PreviewEditorState{mode:PreviewMode;tool:AnnotationTool;selected?:PreviewElement;dirty:boolean;canUndo:boolean;canRedo:boolean;annotations:PreviewAnnotation[];revision:number;error?:string;}
export type EditorCommand=(
 |{type:'mode';mode:PreviewMode;tool?:AnnotationTool}
 |{type:'select';id:string}|{type:'parent'}|{type:'children';id?:string;offset?:number}
 |{type:'style';values:Record<string,string>}|{type:'css';value:string}
 |{type:'attributes';values:Record<string,string>}|{type:'text';value:string}
 |{type:'html';value:string;preview?:boolean}|{type:'revert-preview'}
 |{type:'undo'|'redo'|'export'|'commit'|'cancel'|'reset'|'state'}
 |{type:'annotations';annotations:PreviewAnnotation[]}|{type:'capture';hide:boolean}|{type:'lock';locked:boolean})&{targetId?:string};
export interface EditorResult{state:PreviewEditorState;nodes?:PreviewTreeNode[];more?:boolean;edits?:DomEdit[];}
