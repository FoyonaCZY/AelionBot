import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,existsSync,mkdirSync,writeFileSync,readdirSync,statSync,copyFileSync} from 'node:fs';
import {join,relative,isAbsolute,basename,dirname,resolve} from 'node:path';
import {atomicJson} from './store';
import type {DesignSystemCatalog,DesignSystemDetail,DesignSystemManifest,DesignSystemOrigin,DesignSystemSummary} from '../../src/designer-types';
const ALLOWED=/^(DESIGN\.md|tokens\.css|design-tokens\.json|USAGE\.md|components\.html|components\.manifest\.json|assets\/[A-Za-z0-9._/-]+\.(?:css|html|md|json|svg|woff2|png|jpg|jpeg|webp))$/;
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+String.fromCharCode(92))&&!rel.startsWith('../');};
function slug(value:string){return (value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,32)||'pack');}
function walk(root:string,dir:string,files:{path:string;abs:string}[]=[]){
 for(const entry of readdirSync(dir,{withFileTypes:true})){
  if(entry.isSymbolicLink()||entry.name.startsWith('.'))continue;
  const abs=join(dir,entry.name);
  if(entry.isDirectory()){if(files.length<80)walk(root,abs,files);continue;}
  if(!entry.isFile())continue;
  const path=relative(root,abs).replaceAll('\\','/');
  if(!ALLOWED.test(path))continue;
  files.push({path,abs});
  if(files.length>80)throw Error('自定义设计系统文件过多');
 }
 return files;
}
export class DesignSystems {
 readonly catalog:DesignSystemCatalog;
 private customCatalog:DesignSystemCatalog;
 private summaries?:DesignSystemSummary[];
 private describe(catalog:DesignSystemCatalog,origin:DesignSystemOrigin):DesignSystemSummary[]{
  return catalog.systems.map(({files,...summary})=>{
   let description=summary.description;
   try{
    const source=this.read(summary.id,'DESIGN.md').toString('utf8');
    const paragraphs=source.split(/\r?\n\s*\r?\n/).map(p=>p.trim()).filter(p=>p&&!/^(#|>|[-*] |```|\|)/.test(p));
    const text=paragraphs[0]?.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*`_]/g,'').replace(/\s+/g,' ');
    if(text)description=text.length>260?text.slice(0,257).replace(/\s+\S*$/,'')+'…':text;
   }catch{}
   return {...summary,description,origin};
  });
 }
 constructor(readonly root:string,readonly archiveRoot?:string,readonly customRoot?:string){
  this.catalog=JSON.parse(readFileSync(join(root,'catalog.json'),'utf8'));
  if(this.catalog.version!==1||!Array.isArray(this.catalog.systems)||!this.catalog.systems.length)throw Error('设计系统资源清单无效');
  this.customCatalog=this.loadCustom();
 }
 private customFile(){return this.customRoot?join(this.customRoot,'catalog.json'):'';}
 private loadCustom():DesignSystemCatalog{
  const file=this.customFile();
  if(!file||!existsSync(file))return {version:1,sourceCommit:'custom',sourceUrl:'local',systems:[]};
  const data=JSON.parse(readFileSync(file,'utf8')) as DesignSystemCatalog;
  if(data.version!==1||!Array.isArray(data.systems))throw Error('自定义设计系统清单无效');
  return data;
 }
 private saveCustom(){if(!this.customRoot)throw Error('当前环境不能保存自定义设计系统');mkdirSync(this.customRoot,{recursive:true});atomicJson(this.customFile(),this.customCatalog);this.summaries=undefined;}
 private originOf(id:string,version?:string):DesignSystemOrigin{
  if(this.customCatalog.systems.some(s=>s.id===id&&(!version||s.version===version)))return 'custom';
  return 'bundled';
 }
 list(){return this.summaries??=[...this.describe(this.catalog,'bundled'),...this.describe(this.customCatalog,'custom')];}
 get(id:string,version?:string):DesignSystemManifest{
  const custom=this.customCatalog.systems.find(s=>s.id===id);
  if(custom&&(!version||custom.version===version))return custom;
  const system=this.catalog.systems.find(s=>s.id===id);
  if(system&&(!version||system.version===version))return system;
  if(this.archiveRoot&&version&&/^[a-f0-9]{40}$/.test(version)&&/^[a-z0-9-]+$/.test(id)){
   const file=join(this.archiveRoot,version,id,'pinned-manifest.json');
   if(existsSync(file)){const pinned=JSON.parse(readFileSync(file,'utf8'));if(pinned.id===id&&pinned.version===version)return pinned;}
  }
  throw Error('所选设计系统版本不在本地资源库中');
 }
 private sourceRoot(system:DesignSystemManifest){
  if(this.catalog.systems.some(s=>s.id===system.id&&s.version===system.version))return this.root;
  if(this.customCatalog.systems.some(s=>s.id===system.id&&s.version===system.version)){
   if(!this.customRoot)throw Error('自定义设计系统目录不可用');
   return this.customRoot;
  }
  return join(this.archiveRoot!,system.version);
 }
 read(id:string,path:string,version?:string){
  const system=this.get(id,version),file=system.files.find(f=>f.path===path);if(!file)throw Error('文件不在设计系统资源清单中');
  const base=this.sourceRoot(system),root=realpathSync(join(base,id)),target=realpathSync(join(root,path)),rel=relative(root,target);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+String.fromCharCode(92))||rel.startsWith('../'))throw Error('设计资源路径越界');
  const bytes=readFileSync(target);
  if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error(this.originOf(id,system.version)==='custom'?'自定义设计系统文件已变化，请重新导入':'设计系统资源已变化，请修复应用安装');
  return bytes;
 }
 pin(id:string,version?:string){
  const system=this.get(id,version);if(!this.archiveRoot)return system;
  const target=join(this.archiveRoot,system.version,id);if(existsSync(join(target,'pinned-manifest.json')))return system;
  for(const file of system.files){const bytes=this.read(id,file.path,system.version),path=join(target,file.path);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,bytes);}
  writeFileSync(join(target,'pinned-manifest.json'),JSON.stringify(system));return system;
 }
 detail(id:string):DesignSystemDetail{
  const {files,...summary}=this.get(id);const origin=this.originOf(id,summary.version);
  const read=(path:string)=>files.some(f=>f.path===path)?this.read(id,path).toString('utf8'):'';
  return {...summary,origin,design:read('DESIGN.md'),tokens:read('tokens.css'),components:read('components.html')};
 }
 context(id:string,version?:string){
  const system=this.get(id,version);
  const text=(path:string,max:number,css=false)=>{const raw=system.files.some(f=>f.path===path)?this.read(id,path,version).toString('utf8'):'';const content=css?raw.replace(/\/\*[\s\S]*?\*\//g,'').trim():raw;return {content:content.slice(0,max),truncated:content.length>max};};
  const design=text('DESIGN.md',24000),tokens=text('tokens.css',12000,true),usage=text('USAGE.md',4000),components=text('components.manifest.json',3500);
  return {id,version:system.version,origin:this.originOf(id,system.version),source:system.source,license:system.license,design:design.content,tokens:tokens.content,usage:usage.content,components:components.content,referenceTruncated:{design:design.truncated,tokens:tokens.truncated,usage:usage.truncated,components:components.truncated},files:system.files.map(f=>f.path)};
 }
 importFolder(source:string){
  if(!this.customRoot)throw Error('当前环境不能导入自定义设计系统');
  if(typeof source!=='string'||!source.trim())throw Error('请选择包含 DESIGN.md 的文件夹');
  const root=realpathSync(resolve(source));
  if(!statSync(root).isDirectory())throw Error('请选择文件夹');
  const design=join(root,'DESIGN.md');
  if(!existsSync(design))throw Error('目录需要包含 DESIGN.md');
  const collected=walk(root,root);
  if(!collected.some(file=>file.path==='DESIGN.md'))throw Error('目录需要包含 DESIGN.md');
  let total=0;const files=collected.map(file=>{
   const bytes=readFileSync(file.abs);total+=bytes.length;if(bytes.length>2*1024*1024||total>8*1024*1024)throw Error('自定义设计系统超过大小限制');
   return {path:file.path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  });
  const baseId='custom-'+slug(basename(root));
  let id=baseId,n=2;while(this.catalog.systems.some(s=>s.id===id)||this.customCatalog.systems.some(s=>s.id===id)){id=`${baseId}-${n++}`;if(n>20)throw Error('自定义设计系统标识冲突');}
  if(!/^[a-z0-9-]+$/.test(id))throw Error('自定义设计系统标识无效');
  const version=createHash('sha1').update(files.map(file=>file.sha256).join()).digest('hex');
  const title=(readFileSync(design,'utf8').match(/^#\s+(.+)$/m)?.[1]||basename(root)).trim().slice(0,80);
  const colors=(existsSync(join(root,'tokens.css'))?(readFileSync(join(root,'tokens.css'),'utf8').match(/#[0-9a-fA-F]{6}\b/g)||[]):[]).filter((value,index,all)=>all.indexOf(value)===index).slice(0,6);
  const target=join(this.customRoot,id);
  mkdirSync(target,{recursive:true});
  for(const file of collected){
   const dest=join(target,file.path);
   if(!inside(target,dest))throw Error('自定义设计系统路径越界');
   mkdirSync(dirname(dest),{recursive:true});
   copyFileSync(file.abs,dest);
  }
  const manifest:DesignSystemManifest={id,name:title,category:'Custom',description:'Imported local DESIGN.md package',version,bytes:total,colors,source:'local:'+basename(root),license:'local',origin:'custom',files};
  this.customCatalog.systems=this.customCatalog.systems.filter(s=>s.id!==id).concat(manifest);
  this.saveCustom();
  return this.pin(id,version);
 }
}
