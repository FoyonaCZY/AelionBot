import { randomUUID } from 'node:crypto';
import { extname, basename } from 'node:path';
import type { Artifact, ArtifactPreview } from '../../src/shared';
import { Store } from './store';
import {officeExtensions,officePreview,OFFICE_PREVIEW_LIMIT} from './office-preview';
import { VmController, shQuote } from './vm';
import {WORKSPACE_DIRECTORY_SCRIPT} from './workspace-directory';
import type {WorkspaceDirectory} from '../../src/workspace-files';
import {sourceTextFile} from '../../src/source-language';
import type {TextEdit} from '../../src/editable-text';
import {editableText,editedBytes} from './preview-editing';
import {readVmBytes,VM_WRITE} from './vm-files';
import {vmPython} from './vm-python';
import {decodeText} from './file-text';
import {FileCheckpoints} from './file-checkpoints';

export function artifactPath(value:string){
  if(!value||value.length>500||value.startsWith('/')||value.includes('\\')||/^[a-z][a-z0-9+.-]*:/i.test(value)||value.split('/').includes('..')||value.includes('\0'))throw new Error('文件必须位于当前 Bot 工作目录');
  return value;
}
import type {DesignerFiles} from './designer-files';
export class ArtifactService {
  designerFiles?:DesignerFiles;
  openLocal?:(path:string)=>Promise<string>;
  isLocal(botId:string,path:string){return Boolean(this.designerFiles?.owns(botId,path));}
  private local(botId:string,path=''){if(this.isLocal(botId,path)||this.store.bot(botId).type==='designer'||path.startsWith('designers/')){if(!this.designerFiles)throw Error('本机设计文件服务未就绪');return this.designerFiles;}}
  constructor(private store:Store,private vm:VmController){}
  async readEditable(botId:string,path:string){
    this.store.bot(botId);path=artifactPath(path);if(!sourceTextFile(path))throw Error('此格式暂不支持文本编辑');
    const local=this.local(botId,path);if(local)return local.readEditable(botId,path);
    const source=await readVmBytes(this.vm,botId,path,new AbortController().signal);
    return editableText(source.bytes,source.path);
  }
  async saveEditable(botId:string,path:string,edit:TextEdit){
    this.store.bot(botId);path=artifactPath(path);if(!sourceTextFile(path)||typeof edit?.revision!=='string'||!/^[a-f0-9]{64}$/.test(edit.revision))throw Error('无效的文本保存请求');
    const local=this.local(botId,path);if(local)return local.saveEditable(botId,path,edit);
    const signal=new AbortController().signal,source=await readVmBytes(this.vm,botId,path,signal);
    if(editableText(source.bytes,source.path).revision!==edit.revision)throw Error('文件已被其他操作修改，未覆盖原文件。请保留草稿或重新加载后再编辑。');
    const bytes=editedBytes(edit.content,source.bytes),checkpoints=new FileCheckpoints(this.store,this.vm),checkpoint=await checkpoints.vmBefore(botId,'preview-edit-'+randomUUID(),source.path,signal);
    const result=await vmPython(this.vm,botId,{path,expectedPath:source.path,expectedSha256:decodeText(source.bytes).sha256,content:bytes.toString('utf8')},VM_WRITE,signal);
    if(result.exitCode!==0){if(/FILE_CHANGED|PATH_CHANGED/.test(result.stderr))throw Error('文件在保存前发生变化，未覆盖原文件。请保留草稿或重新加载后再编辑。');throw Error('保存失败，请确认工作电脑连接正常且文件可写。');}
    const receipt=JSON.parse(result.stdout);if(checkpoint)checkpoints.vmReceipt(checkpoint,receipt.sha256);
    return editableText(bytes,source.path);
  }
  async directory(botId:string,path=''):Promise<WorkspaceDirectory>{
    this.store.bot(botId);if(path)path=artifactPath(path);
    const local=this.local(botId,path);if(local)return local.directory(botId,path);
    const result=await this.vm.executePython(WORKSPACE_DIRECTORY_SCRIPT,Buffer.from(JSON.stringify({path})),botId,undefined,600_000);
    if(result.exitCode!==0)throw new Error('无法读取目录，请确认工作电脑已启动且目录仍然存在。');
    return JSON.parse(result.stdout);
  }
  importKnown(botId:string,files:Array<{name:string;path:string;size:number;modifiedAt:string}>){
    let added=0;
    for(const file of files){
      if(this.store.data.artifacts.some(item=>item.botId===botId&&item.path===file.path&&item.modifiedAt===file.modifiedAt))continue;
      const source=[...this.store.data.messages,...this.store.data.peerMessages,...this.store.data.groupRunMessages].reverse().find(message=>{
        if(message.botId!==botId||message.tool!=='file_write'||message.status!=='done'||!message.runId)return false;
        try{return JSON.parse(JSON.parse(message.content).result.stdout).path===`/work/${botId}/${file.path}`;}catch{return false;}
      });
      if(source){this.store.data.artifacts.push({id:randomUUID(),botId,runId:source.runId!,...file});added++;}
    }
    if(added)this.store.save();return added;
  }
  async list(botId:string):Promise<Array<{name:string;path:string;size:number;modifiedAt:string}>>{
    this.store.bot(botId);
    const local=this.local(botId);if(local)return local.list(botId);
    const script=String.raw`import os,json,pathlib,datetime
root=pathlib.Path.cwd().resolve(); files=[]
for directory, dirs, names in os.walk(root,followlinks=False):
    dirs[:]=[d for d in dirs if not d.startswith('.') and d not in ['node_modules','__pycache__','venv'] and not (pathlib.Path(directory)/d).is_symlink()]
    if len(pathlib.Path(directory).relative_to(root).parts)>=3: dirs[:]=[]
    for name in names:
        path=pathlib.Path(directory)/name
        if name.startswith('.') or path.is_symlink() or not path.is_file(): continue
        stat=path.stat()
        files.append({'name':name,'path':str(path.relative_to(root)),'size':stat.st_size,'modifiedAt':datetime.datetime.fromtimestamp(stat.st_mtime,datetime.timezone.utc).isoformat()})
        if len(files)>=200: break
    if len(files)>=200: break
print(json.dumps(files,ensure_ascii=False))`;
    const result=await this.vm.execute(`python3 -c ${shQuote(script)}`,botId);if(result.exitCode!==0)throw new Error(result.stderr||'无法读取工作文件');
    return JSON.parse(result.stdout);
  }
  async collect(botId:string,runId:string){
    if(!this.local(botId)&&this.vm.state.status!=='ready')return;
    const run=this.store.data.runs.find(item=>item.id===runId&&item.botId===botId);if(!run)return;
    const files=this.local(botId)?await this.designerFiles!.list(botId,run.designSessionId):await this.list(botId);
    for(const file of files){
      if(file.path.startsWith('attachments/')&&this.store.data.attachments.some(attachment=>file.path.startsWith(`attachments/${attachment.id}/`)))continue;
      if(Date.parse(file.modifiedAt)<Date.parse(run.startedAt)-2000)continue;
      if(this.store.data.artifacts.some(item=>item.botId===botId&&item.path===file.path&&item.modifiedAt===file.modifiedAt))continue;
      this.store.data.artifacts.push({id:randomUUID(),botId,runId,...file});
    }
    this.store.save();
  }
  async read(botId:string,path:string,maxBytes=25*1024*1024):Promise<Buffer>{
    this.store.bot(botId);path=artifactPath(path);
    const local=this.local(botId,path);if(local)return local.read(botId,path,maxBytes);
    const payload=Buffer.from(JSON.stringify({path,maxBytes})).toString('base64');
    const script=`import pathlib,base64,json; a=json.loads(base64.b64decode('${payload}')); root=pathlib.Path.cwd().resolve(); p=(root/a['path']).resolve(); assert p.is_relative_to(root) and p.is_file(), 'File is outside workspace or missing'; assert p.stat().st_size<=a['maxBytes'], 'File exceeds preview/export limit'; data=p.open('rb').read(a['maxBytes']+1); assert len(data)<=a['maxBytes']; print(base64.b64encode(data).decode())`;
    const result=await this.vm.execute(`python3 -c ${shQuote(script)}`,botId,undefined,Math.ceil(maxBytes*1.4)+10000);
    if(result.exitCode!==0)throw new Error(result.stderr||'无法读取文件');return Buffer.from(result.stdout.trim(),'base64');
  }
  async previewLocalOffice(botId:string,name:string,size?:number){
    if(!this.local(botId))return;
    const files=await this.designerFiles!.list(botId),stem=basename(name).replace(/\.[^.]+$/,'');
    const pptx=files.find(file=>file.name===name&&(size===undefined||file.size===size))||files.find(file=>file.name===name);
    if(pptx)return this.preview(botId,pptx.path);
    const html=files.find(file=>file.name===stem+'.html'||file.name===stem+'.htm');
    if(html)return this.preview(botId,html.path);
  }
  private async localOfficeCompanion(botId:string,path:string){
    const normalized=artifactPath(path),stem=basename(normalized).replace(/\.[^.]+$/,'');
    const parent=normalized.includes('/')?normalized.slice(0,normalized.lastIndexOf('/')):'';
    for(const ext of ['.html','.htm']){
      const companion=parent?parent+'/'+stem+ext:stem+ext;
      try{const bytes=await this.read(botId,companion,2*1024*1024);return {kind:'web' as const,web:{kind:'document' as const,format:'html' as const,name:basename(companion),content:bytes.toString('utf8'),workspace:{botId,path:companion}}};}catch{}
    }
  }
  async preview(botId:string,path:string):Promise<ArtifactPreview>{
    const extension=extname(artifactPath(path)).toLowerCase();
    if(officeExtensions.has(extension)&&this.local(botId,path))return (await this.localOfficeCompanion(botId,path))||{kind:'unsupported'};
    if(officeExtensions.has(extension))return officePreview(this.vm,botId,extension,await this.read(botId,path,OFFICE_PREVIEW_LIMIT));
    const imageTypes:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.bmp':'image/bmp','.avif':'image/avif'};
    const isText=!imageTypes[extension]&&sourceTextFile(path);
    if(!isText&&!imageTypes[extension]&&extension!=='.pdf')return {kind:'unsupported'};
    const bytes=await this.read(botId,path,isText?2*1024*1024:15*1024*1024);
    if(imageTypes[extension])return {kind:'image',dataUrl:`data:${imageTypes[extension]};base64,${bytes.toString('base64')}`};
    if(extension==='.pdf')return {kind:'pdf',dataUrl:`data:application/pdf;base64,${bytes.toString('base64')}`};
    return {kind:extension==='.md'?'markdown':['.html','.htm'].includes(extension)?'html':'text',content:bytes.toString('utf8').slice(0,120000),truncated:bytes.toString('utf8').length>120000};
  }
  async open(botId:string,path:string){
    this.store.bot(botId);path=artifactPath(path);
    const local=this.local(botId,path);if(local){if(!this.openLocal)throw Error('请使用应用内预览或下载本机设计文件');await local.read(botId,path);const error=await this.openLocal(local.hostPath(botId,path));if(error)throw Error(error);return;}
    const payload=Buffer.from(path).toString('base64');
    const script=`import pathlib,base64,subprocess; root=pathlib.Path.cwd().resolve(); p=(root/base64.b64decode('${payload}').decode()).resolve(); assert p.is_relative_to(root) and p.is_file(); subprocess.Popen(['/usr/local/bin/aelion-session','xdg-open',str(p)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)`;
    const result=await this.vm.execute(`python3 -c ${shQuote(script)}`,botId);if(result.exitCode!==0)throw new Error(result.stderr);
  }
}
