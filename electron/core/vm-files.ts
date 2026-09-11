import {vmPython} from './vm-python';
import type {VmController} from './vm';
import type {FileCheckpoints} from './file-checkpoints';
import {decodeText,editText,expectedHash,FileToolError,textPage} from './file-text';

const VM_READ=String.raw`
import base64,json,pathlib
try:
    root=pathlib.Path.cwd().resolve(); p=(root/a['path']).resolve()
    if not p.is_relative_to(root): raise ValueError('PATH_OUTSIDE_WORKSPACE: 文件路径超出当前 Bot 工作目录')
    with p.open('rb') as source:
        fdpath=pathlib.Path('/proc/self/fd')/str(source.fileno())
        actual=fdpath.resolve() if fdpath.exists() else p.resolve()
        if actual!=p or not actual.is_relative_to(root): raise ValueError('PATH_CHANGED: 文件路径已变化')
        data=source.read(2097153)
    if len(data)>2097152: raise ValueError('FILE_TOO_LARGE: 文本文件超过 2 MB，请用命令按需处理')
    print(json.dumps({'path':str(p),'data':base64.b64encode(data).decode()}))
except FileNotFoundError: print(json.dumps({'errorCode':'FILE_NOT_FOUND','error':'文件不存在，请先核对目录和路径'}))
except IsADirectoryError: print(json.dumps({'errorCode':'IS_DIRECTORY','error':'这是目录，不能作为文本文件读取'}))
except PermissionError: print(json.dumps({'errorCode':'ACCESS_DENIED','error':'操作系统拒绝访问文件'}))
except ValueError as error:
    code,_,message=str(error).partition(': ');print(json.dumps({'errorCode':code,'error':message}))
`;

export const VM_WRITE=String.raw`
import hashlib,json,os,pathlib,stat,tempfile
root=pathlib.Path.cwd().resolve();p=(root/a['path']).resolve()
assert p.is_relative_to(root), 'PATH_OUTSIDE_WORKSPACE: 文件路径超出当前 Bot 工作目录'
assert not a.get('expectedPath') or str(p)==a['expectedPath'], 'PATH_CHANGED: 文件路径已变化'
exists=p.exists();assert not exists or p.is_file(), 'IS_DIRECTORY: 目标不是文件'
expected=a.get('expectedSha256')
def digest():
    if not p.exists(): return None
    value=hashlib.sha256()
    with p.open('rb') as source:
        while True:
            chunk=source.read(65536)
            if not chunk: break
            value.update(chunk)
    return value.hexdigest()
assert not expected or digest()==expected, 'FILE_CHANGED: 文件自上次读取后已变化，请重新读取'
mode=stat.S_IMODE(p.stat().st_mode) if exists else None
p.parent.mkdir(parents=True,exist_ok=True);parent=p.parent.resolve();data=a['content'].encode('utf-8');temporary=None
try:
    with tempfile.NamedTemporaryFile(dir=parent,prefix='.aelion-',suffix='.tmp',delete=False) as output:
        temporary=pathlib.Path(output.name);output.write(data);output.flush();os.fsync(output.fileno())
    if mode is None:
        mask=os.umask(0);os.umask(mask);mode=0o666 & ~mask
    os.chmod(temporary,mode)
    assert p.parent.resolve()==parent and p.resolve()==p, 'PATH_CHANGED: 文件路径在保存前已变化'
    assert not expected or digest()==expected, 'FILE_CHANGED: 文件在保存前已变化，请重新读取'
    if exists: os.replace(temporary,p)
    else: os.link(temporary,p)
finally:
    if temporary is not None: temporary.unlink(missing_ok=True)
print(json.dumps({'path':str(p),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'written':True}))
`;

export async function readVmBytes(vm:VmController,botId:string,path:string,signal:AbortSignal){
  const command=await vmPython(vm,botId,{path},VM_READ,signal,3*1024*1024);signal.throwIfAborted();
  if(command.exitCode!==0)throw new FileToolError('VM_FILE_ERROR',command.stderr||'工作电脑文件读取失败');
  let result:any;try{result=JSON.parse(command.stdout);}catch{throw new FileToolError('VM_FILE_ERROR','工作电脑未返回完整的文件读取结果');}
  if(result.errorCode)throw new FileToolError(result.errorCode,result.error);
  if(typeof result.path!=='string'||typeof result.data!=='string')throw new FileToolError('VM_FILE_ERROR','工作电脑文件读取结果无效');
  return {path:result.path as string,bytes:Buffer.from(result.data,'base64'),command};
}
export async function readVmFile(vm:VmController,botId:string,path:string,args:Record<string,unknown>,signal:AbortSignal,redact:(text:string)=>string=text=>text){
  const range={offset:args.offset,startLine:args.startLine,lineCount:args.lineCount,maxChars:args.maxChars,withLineNumbers:args.withLineNumbers};textPage('',range);
  const source=await readVmBytes(vm,botId,path,signal),decoded=decodeText(source.bytes),safe=redact(decoded.text),{content,...page}=textPage(safe,range);
  return {...source.command,stdout:content,path:source.path,location:'vm',...page,sha256:decoded.sha256,bytes:decoded.bytes,bom:decoded.bom,redacted:safe!==decoded.text};
}
export async function patchVmFile(vm:VmController,checkpoints:FileCheckpoints,botId:string,runId:string,path:string,args:Record<string,unknown>,signal:AbortSignal,redact:(text:string)=>string=text=>text){
  const expected=expectedHash(args.expectedSha256,true)!;
  if(typeof args.oldText!=='string'||!args.oldText.length||args.oldText.length>256000||typeof args.newText!=='string'||args.newText.length>256000)throw new FileToolError('INVALID_ARGUMENT','oldText 不能为空，oldText 和 newText 最长为 256000 字符');
  if(args.replaceAll!==undefined&&typeof args.replaceAll!=='boolean')throw new FileToolError('INVALID_ARGUMENT','replaceAll 必须是布尔值');
  const edit={oldText:args.oldText,newText:args.newText,expectedSha256:expected,replaceAll:args.replaceAll},source=await readVmBytes(vm,botId,path,signal);
  const original=decodeText(source.bytes).text;if((edit.oldText.includes('[redacted')||edit.newText.includes('[redacted'))&&redact(original)!==original)throw new FileToolError('REDACTED_EDIT','不能把凭据占位符写回文件，请只修改未脱敏片段');
  const changed=editText(source.bytes,edit),checkpoint=await checkpoints.vmBefore(botId,runId,source.path,signal);
  const command=await vmPython(vm,botId,{path:source.path,expectedPath:source.path,content:changed.content,expectedSha256:expected},VM_WRITE,signal);
  if(command.exitCode!==0)return command;signal.throwIfAborted();await checkpoints.vmAfter(checkpoint,signal,changed.content);
  return {...command,path:source.path,location:'vm',sha256:changed.sha256,bytes:changed.bytes,replacements:changed.replacements,written:true};
}
