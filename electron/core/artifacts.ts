import { randomUUID } from 'node:crypto';
import { extname, basename } from 'node:path';
import type { Artifact, ArtifactPreview } from '../../src/shared';
import { Store } from './store';
import { VmController, shQuote } from './vm';

export function artifactPath(value:string){
  if(!value||value.length>500||value.startsWith('/')||value.includes('\\')||/^[a-z][a-z0-9+.-]*:/i.test(value)||value.split('/').includes('..')||value.includes('\0'))throw new Error('文件必须位于当前 Bot 工作目录');
  return value;
}
export class ArtifactService {
  constructor(private store:Store,private vm:VmController){}
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
    if(this.vm.state.status!=='ready')return;
    const run=this.store.data.runs.find(item=>item.id===runId&&item.botId===botId);if(!run)return;
    const files=await this.list(botId);
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
    const payload=Buffer.from(JSON.stringify({path,maxBytes})).toString('base64');
    const script=`import pathlib,base64,json; a=json.loads(base64.b64decode('${payload}')); root=pathlib.Path.cwd().resolve(); p=(root/a['path']).resolve(); assert p.is_relative_to(root) and p.is_file(), 'File is outside workspace or missing'; assert p.stat().st_size<=a['maxBytes'], 'File exceeds preview/export limit'; data=p.open('rb').read(a['maxBytes']+1); assert len(data)<=a['maxBytes']; print(base64.b64encode(data).decode())`;
    const result=await this.vm.execute(`python3 -c ${shQuote(script)}`,botId,undefined,Math.ceil(maxBytes*1.4)+10000);
    if(result.exitCode!==0)throw new Error(result.stderr||'无法读取文件');return Buffer.from(result.stdout.trim(),'base64');
  }
  async preview(botId:string,path:string):Promise<ArtifactPreview>{
    const extension=extname(artifactPath(path)).toLowerCase();
    const imageTypes:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'};
    const isText=['.md','.txt','.csv','.tsv','.json','.py','.js','.ts','.tsx','.jsx','.css','.html','.yml','.yaml','.xml','.log','.sh','.sql'].includes(extension);
    if(!isText&&!imageTypes[extension]&&extension!=='.pdf')return {kind:'unsupported'};
    const bytes=await this.read(botId,path,isText?2*1024*1024:15*1024*1024);
    if(imageTypes[extension])return {kind:'image',dataUrl:`data:${imageTypes[extension]};base64,${bytes.toString('base64')}`};
    if(extension==='.pdf')return {kind:'pdf',dataUrl:`data:application/pdf;base64,${bytes.toString('base64')}`};
    return {kind:extension==='.md'?'markdown':extension==='.html'?'html':'text',content:bytes.toString('utf8').slice(0,120000),truncated:bytes.toString('utf8').length>120000};
  }
  async open(botId:string,path:string){
    this.store.bot(botId);path=artifactPath(path);
    const payload=Buffer.from(path).toString('base64');
    const script=`import pathlib,base64,subprocess; root=pathlib.Path.cwd().resolve(); p=(root/base64.b64decode('${payload}').decode()).resolve(); assert p.is_relative_to(root) and p.is_file(); subprocess.Popen(['/usr/local/bin/aelion-session','xdg-open',str(p)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)`;
    const result=await this.vm.execute(`python3 -c ${shQuote(script)}`,botId);if(result.exitCode!==0)throw new Error(result.stderr);
  }
}
