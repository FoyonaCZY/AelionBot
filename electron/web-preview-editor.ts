import {ipcMain,type BrowserWindow,type IpcMainEvent,type WebContents} from 'electron';
import {randomUUID} from 'node:crypto';
import type {EditorCommand,EditorResult,PreviewEditorState} from '../src/preview-editor-types';
export class WebPreviewEditor {
 lastState?:PreviewEditorState;
 get dirty(){return Boolean(this.lastState?.dirty);}
 private current?:{id:string;contents:WebContents};private pending=new Map<string,{resolve:(value:EditorResult)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 constructor(private window:BrowserWindow){ipcMain.on('web-preview:editor-state',this.state);ipcMain.on('web-preview:editor-save',this.save);ipcMain.on('web-preview:editor-result',this.result);window.once('closed',()=>{this.detach();ipcMain.removeListener('web-preview:editor-state',this.state);ipcMain.removeListener('web-preview:editor-save',this.save);ipcMain.removeListener('web-preview:editor-result',this.result);});}
 private trusted(event:IpcMainEvent){return this.current&&event.sender===this.current.contents&&event.senderFrame===this.current.contents.mainFrame;}
 private save=(event:IpcMainEvent)=>{if(this.trusted(event))this.window.webContents.send('web-preview:save',this.current!.id);};
 private state=(event:IpcMainEvent,state:PreviewEditorState)=>{if(!this.trusted(event)||!state||JSON.stringify(state).length>2*1024*1024)return;this.lastState=state;this.window.webContents.send('web-preview:editor-event',{id:this.current!.id,state});};
 private result=(event:IpcMainEvent,value:{requestId:string;result?:EditorResult;error?:string})=>{if(!this.trusted(event))return;const pending=this.pending.get(value?.requestId);if(!pending)return;this.pending.delete(value.requestId);clearTimeout(pending.timer);if(value.error)pending.reject(Error(value.error));else if(!value.result||JSON.stringify(value.result).length>10*1024*1024)pending.reject(Error('编辑结果过大'));else{this.lastState=value.result.state;pending.resolve(value.result);}};
 attach(id:string,contents:WebContents){this.detach();this.current={id,contents};}
 detach(){this.current=undefined;this.lastState=undefined;for(const value of this.pending.values()){clearTimeout(value.timer);value.reject(Error('网页预览已关闭'));}this.pending.clear();}
 command(id:string,command:EditorCommand):Promise<EditorResult>{if(!this.current||this.current.id!==id||this.current.contents.isDestroyed())return Promise.reject(Error('网页预览已关闭'));const requestId=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(requestId);reject(Error('网页未响应编辑请求，请重新加载'));},8000);this.pending.set(requestId,{resolve,reject,timer});this.current!.contents.send('web-preview:editor-command',{requestId,command});});}
}
