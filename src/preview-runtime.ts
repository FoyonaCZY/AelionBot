import {createContext,useContext} from 'react';
import type {EditorCommand,EditorResult,PreviewAnnotation,PreviewEditorState,PreviewMode,AnnotationTool,DomEdit} from './preview-editor-types';
import type {EditableText} from './editable-text';
export interface WebPreviewControls{state:PreviewEditorState;command:(command:EditorCommand)=>Promise<EditorResult>;save:()=>Promise<boolean>;discard:()=>Promise<void>;sendChanges:()=>Promise<boolean>;busy:boolean;canWrite:boolean;inspect:()=>void;primaryLabel:string;saveLabel:string;}
export interface PreviewRuntime{request:(action:()=>void)=>void;initialAnnotations?:PreviewAnnotation[];rememberAnnotations:(value:PreviewAnnotation[])=>void;mode:PreviewMode;tool:AnnotationTool;setMode:(mode:PreviewMode)=>void;setTool:(tool:AnnotationTool)=>void;web?:WebPreviewControls;setWeb:(controls:WebPreviewControls|undefined)=>void;annotations:PreviewAnnotation[];setFileAnnotations:(value:PreviewAnnotation[])=>void;sendEdits:(edits:DomEdit[])=>Promise<boolean>;saved:(value:EditableText)=>void;}
export const PreviewRuntimeContext=createContext<PreviewRuntime|undefined>(undefined);
export const usePreviewRuntime=()=>useContext(PreviewRuntimeContext);
