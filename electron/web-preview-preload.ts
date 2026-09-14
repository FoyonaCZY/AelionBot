import {ipcRenderer} from 'electron';
import {createPreviewDomEditor} from './preview-dom-editor';
const editor=createPreviewDomEditor(state=>ipcRenderer.send('web-preview:editor-state',state),()=>ipcRenderer.send('web-preview:editor-save'));
ipcRenderer.on('web-preview:editor-command',async(_event,input)=>{try{const result=await editor.command(input.command);ipcRenderer.send('web-preview:editor-result',{requestId:input.requestId,result});}catch(error){ipcRenderer.send('web-preview:editor-result',{requestId:input.requestId,error:(error as Error).message});}});
// This preload deliberately exposes no API to the page's main world.
