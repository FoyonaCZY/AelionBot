import {clipboard} from 'electron';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AttachmentUpload} from '../../src/attachment-types';

export function dropFilePaths(bytes:Buffer){
  if(bytes.length<20||bytes.length>1024*1024)return [];const offset=bytes.readUInt32LE(0),wide=bytes.readUInt32LE(16)!==0;if(offset<20||offset>=bytes.length)return [];
  return bytes.subarray(offset).toString(wide?'utf16le':'latin1').split('\0').filter(Boolean).slice(0,11);
}
export async function readAttachmentClipboard():Promise<{paths:string[];files:AttachmentUpload[]}>{
  const items=await clipboard.read(),paths:string[]=[],files:AttachmentUpload[]=[];
  for(const item of items){
    for(const type of item.types){
      if(/(?:CF_HDROP|format="HDROP")/i.test(type)){const blob=await item.getType(type);if(blob instanceof Blob)paths.push(...dropFilePaths(Buffer.from(await blob.arrayBuffer())));}
      if(type==='text/uri-list'){const blob=await item.getType(type);if(blob instanceof Blob)for(const line of (await blob.text()).split(/\r?\n/))if(line.startsWith('file:'))try{paths.push(fileURLToPath(line));}catch{}}
    }
  }
  if(paths.length)return {paths:[...new Set(paths)],files:[]};
  // Explorer's file-drop clipboard is not exposed as File objects by every Chromium build.
  if(process.platform==='win32'){
    const command="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -AssemblyName System.Windows.Forms;if([Windows.Forms.Clipboard]::ContainsFileDropList()){@([Windows.Forms.Clipboard]::GetFileDropList())|ConvertTo-Json -Compress}";
    const result=await promisify(execFile)(join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-STA','-NonInteractive','-Command',command],{windowsHide:true,timeout:5000,maxBuffer:1024*1024,encoding:'utf8'}).catch(()=>undefined);
    if(result?.stdout.trim()){const value:unknown=JSON.parse(result.stdout);const found=typeof value==='string'?[value]:Array.isArray(value)?value:[];if(found.length&&found.every(path=>typeof path==='string'))return {paths:found,files:[]};}
  }
  for(const item of items){const type=item.types.find(type=>['image/png','image/jpeg','image/webp','image/gif'].includes(type));if(!type)continue;const blob=await item.getType(type);if(blob instanceof Blob){if(blob.size>25*1024*1024)throw new Error('粘贴的图片不能超过 25 MB');files.push({name:`粘贴图片-${Date.now()}-${files.length+1}.${type.split('/')[1]==='jpeg'?'jpg':type.split('/')[1]}`,bytes:new Uint8Array(await blob.arrayBuffer())});}}
  return {paths:[],files};
}
