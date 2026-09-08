import {createHash} from 'node:crypto';
import type {VmController} from './vm';
import type {ArtifactPreview} from '../../src/shared';

export const officeExtensions=new Set(['.ppt','.pptx','.odp','.doc','.docx','.odt']);
export const OFFICE_PREVIEW_LIMIT=8*1024*1024;
// Separate profiles keep previews away from the user's open LibreOffice session.
// Conversion uses a temporary copy, blocks document macros and cleans up afterward.
export function officePreviewScript(extension:string){
  if(!officeExtensions.has(extension))throw new Error('不支持的文档格式');
  return `import sys,pathlib,tempfile,subprocess,shutil,base64
tool=shutil.which('libreoffice') or shutil.which('soffice')
if not tool: raise RuntimeError('请先完成工作电脑的办公应用安装，再预览此文档')
with tempfile.TemporaryDirectory(prefix='aelion-preview-') as temp:
    root=pathlib.Path(temp); source=root/'document${extension}'
    data=sys.stdin.buffer.read(${OFFICE_PREVIEW_LIMIT+1})
    if len(data)>${OFFICE_PREVIEW_LIMIT}: raise RuntimeError('此文档较大，请保存原文件后查看')
    source.write_bytes(data)
    profile=root/'profile'; (profile/'user').mkdir(parents=True)
    (profile/'user'/'registrymodifications.xcu').write_text('''<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateLinks" oor:op="fuse"><value>0</value></prop></item></oor:items>''')
    try:
        result=subprocess.run([tool,'-env:UserInstallation='+profile.as_uri(),'--headless','--nologo','--nodefault','--norestore','--convert-to','pdf','--outdir',str(root),str(source)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=65)
    except subprocess.TimeoutExpired: raise RuntimeError('文档转换超时，可以重试或保存原文件查看')
    target=root/'document.pdf'
    if result.returncode!=0 or not target.is_file(): raise RuntimeError('无法转换此文档，请检查文件是否损坏或需要密码')
    if target.stat().st_size>20*1024*1024: raise RuntimeError('预览内容较大，请保存原文件后查看')
    print(base64.b64encode(target.read_bytes()).decode())`;
}
const cache=new Map<string,Promise<ArtifactPreview>>();
export function officePreview(vm:VmController,botId:string,extension:string,bytes:Buffer):Promise<ArtifactPreview>{
  if(bytes.length>OFFICE_PREVIEW_LIMIT)return Promise.reject(new Error('此文档超过 8 MB，请保存原文件或在工作电脑中打开。'));
  if(vm.state.status!=='ready')return Promise.reject(new Error('启动工作电脑后，即可预览此文档。也可以先保存原文件。'));
  const key=extension+createHash('sha256').update(bytes).digest('hex');
  const existing=cache.get(key);if(existing)return existing;
  const task=vm.executePython(officePreviewScript(extension),bytes,botId,undefined,29*1024*1024).then(result=>{
    if(result.exitCode!==0)throw new Error(result.stderr.split('\n').filter(Boolean).at(-1)?.replace(/^\w*Error: /,'')||'文档预览失败');
    const encoded=result.stdout.trim();if(!/^[A-Za-z0-9+/=]+$/.test(encoded)||!Buffer.from(encoded.slice(0,12),'base64').toString().startsWith('%PDF-'))throw new Error('没有生成可读取的文档预览');
    return {kind:'pdf' as const,dataUrl:'data:application/pdf;base64,'+encoded};
  }).catch(error=>{cache.delete(key);throw error;});
  if(cache.size>=4)cache.delete(cache.keys().next().value!);cache.set(key,task);return task;
}
