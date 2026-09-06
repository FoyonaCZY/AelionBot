import {existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,realpathSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,relative,resolve,sep} from 'node:path';
import {parseDocument,stringify as yamlStringify} from 'yaml';
import type {IntegrationSource,Skill} from '../../src/shared';
import {canonical,hashId,isWithin,skillSources,sourceView,type IntegrationPaths,type SourceDescriptor} from './integration-paths';
import {Store} from './store';

export interface SkillFile {path:string;bytes:Buffer;}
interface Entry {summary:Skill;file:string;root:string;}
export function parseSkill(text:string,fallback:string){
  text=text.replace(/^\uFEFF/,'');const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if(!match)throw new Error('缺少 YAML frontmatter');
  const doc=parseDocument(match[1],{prettyErrors:false,uniqueKeys:true});if(doc.errors.length)throw new Error('SKILL.md 元数据语法错误');
  let metadata:any;try{metadata=doc.toJS({maxAliasCount:50});}catch{throw new Error('SKILL.md 元数据不可解析');}
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata)||typeof metadata.name!=='string'||typeof metadata.description!=='string'||!metadata.name.trim()||!metadata.description.trim())throw new Error('SKILL.md 需要 name 和 description');
  if(metadata.name.length>150||metadata.description.length>4096)throw new Error('技能元数据过长');
  return {name:metadata.name.trim()||fallback,description:metadata.description.trim(),body:match[2].trim(),metadata:metadata.metadata||{},compatibility:typeof metadata.compatibility==='string'?metadata.compatibility:undefined};
}
function slug(name:string,id:string){const base=name.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,42).replace(/-$/,'')||'skill';return `${base}-${hashId(id).slice(0,8)}`;}
function writeAtomic(path:string,text:string){mkdirSync(dirname(path),{recursive:true});const temp=`${path}.${process.pid}.tmp`;writeFileSync(temp,text,{mode:0o600});renameSync(temp,path);}
function sensitiveFile(name:string){return name==='.env'||name.startsWith('.env.')&&name!=='.env.example'||/\.(key|pem|p12|pfx)$/i.test(name);}

export class SkillLibrary {
  private entries:Entry[]=[];
  sources:IntegrationSource[]=[];
  constructor(private store:Store,readonly paths:IntegrationPaths){this.migrate();this.refresh();}
  private ownedPath(skill:Skill){return join(this.paths.dataDir,...(skill.botId?['bots',skill.botId,'skills']:['skills','builtin']),slug(skill.name,skill.id),'SKILL.md');}
  private writeOwned(skill:Skill,path=this.ownedPath(skill)){
    const meta={name:basename(dirname(path)),description:skill.description,metadata:{'aelion-id':skill.id,'aelion-display-name':skill.name,...(skill.botId?{'aelion-bot-id':skill.botId}:{})}};
    writeAtomic(path,`---\n${yamlStringify(meta)}---\n\n${skill.body.trim()}\n`);return path;
  }
  private migrate(){
    if(this.store.data.skillFilesMigrated)return;
    for(const skill of this.store.data.skills){const path=this.ownedPath(skill);if(!existsSync(path))this.writeOwned(skill,path);}
    this.store.data.skillFilesMigrated=true;this.store.save();
  }
  refresh(){
    const entries:Entry[]=[];const sources:IntegrationSource[]=[];const seen=new Set<string>();let walked=0;
    const discover=(source:SourceDescriptor,start:string,botId?:string)=>{
      const issues:string[]=[];let count=0;
      const visit=(dir:string,depth:number)=>{
        if(depth>8||++walked>6000)return;
        let real:string;try{real=realpathSync.native(dir);}catch{return;}
        const key=canonical(real);if(seen.has(key))return;seen.add(key);
        const file=join(real,'SKILL.md');
        if(existsSync(file)){
          try{
            if(!isWithin(real,realpathSync.native(file)))throw new Error('SKILL.md 链接超出了技能目录');
            if(statSync(file).size>256*1024)throw new Error('SKILL.md 超过 256 KB');
            const parsed=parseSkill(readFileSync(file,'utf8'),basename(real));
            const owned=source.scope==='private'||source.scope==='builtin';
            const oldId=owned&&typeof parsed.metadata['aelion-id']==='string'?parsed.metadata['aelion-id']:undefined;
            const id=oldId&&/^[a-zA-Z0-9_-]{1,100}$/.test(oldId)?oldId:`skill-${hashId(key)}`;
            const displayName=owned&&typeof parsed.metadata['aelion-display-name']==='string'?parsed.metadata['aelion-display-name']:parsed.name;
            const summary:Skill={id,name:displayName,description:parsed.description,body:'',...(botId?{botId}:{}),source:{label:source.label,path:file,scope:source.scope,readonly:!owned},compatibility:parsed.compatibility};
            // The source directory, never frontmatter supplied by another agent, determines visibility.
            if(entries.some(entry=>entry.summary.id===id))summary.id=`skill-${hashId(key)}`;
            entries.push({summary,file,root:real});count++;
          }catch(error){issues.push(`${basename(dir)}：${(error as Error).message}`);}
          return;
        }
        try{if(depth>0&&lstatSync(dir).isSymbolicLink())return;for(const item of readdirSync(real,{withFileTypes:true})){if(item.name.startsWith('.')||['node_modules','__pycache__'].includes(item.name))continue;if(item.isDirectory()||item.isSymbolicLink())visit(join(real,item.name),depth+1);}}catch{issues.push('部分子目录无读取权限');}
      };
      if(existsSync(start))visit(start,0);return {count,issues};
    };
    for(const source of skillSources(this.paths)){
      let count=0;const issues:string[]=[];
      if(source.scope==='private'){
        for(const bot of this.store.data.bots){const result=discover(source,join(source.path,bot.id,'skills'),bot.id);count+=result.count;issues.push(...result.issues);}
      }else{const result=discover(source,source.path);count=result.count;issues.push(...result.issues);}
      sources.push(sourceView(source,count,issues.length?issues.slice(0,3).join('；'):undefined));
    }
    this.entries=entries;this.sources=sources;
  }
  all(){return this.entries.map(entry=>({...entry.summary}));}
  forgetBot(botId:string){
    const removed=this.entries.filter(entry=>entry.summary.botId===botId);
    this.entries=this.entries.filter(entry=>entry.summary.botId!==botId);
    this.sources=this.sources.map(source=>source.scope==='private'?{...source,count:Math.max(0,source.count-removed.filter(entry=>isWithin(source.path,entry.file)).length)}:source);
  }
  list(botId:string){this.store.bot(botId);return this.all().filter(skill=>!skill.botId||skill.botId===botId);}
  search(botId:string,query='',limit=100){
    const words=[...new Set(query.normalize('NFKC').toLowerCase().slice(0,300).split(/[\s,，、|]+/).filter(Boolean))].slice(0,12);
    return this.list(botId).map(skill=>{const name=skill.name.normalize('NFKC').toLowerCase(),text=`${name} ${skill.description} ${skill.source?.label||''}`.normalize('NFKC').toLowerCase();const score=words.reduce((sum,word)=>sum+(name.includes(word)?5:text.includes(word)?1:0),0);return {skill,score};}).filter(item=>!words.length||item.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(item=>item.skill);
  }
  externalPath(botId:string,id:string,resource?:string,bundle=false){
    const entry=this.find(botId,id);if(!entry.summary.source?.readonly)return undefined;
    const target=bundle?entry.root:resource===undefined?entry.file:resolve(entry.root,resource);
    if(!isWithin(entry.root,target))throw new Error('技能资源超出了目录');
    const actual=realpathSync.native(target);if(!isWithin(entry.root,actual))throw new Error('技能资源链接超出了目录');return actual;
  }
  private find(botId:string,id:string){
    this.store.bot(botId);const visible=this.entries.filter(entry=>!entry.summary.botId||entry.summary.botId===botId);
    const exact=visible.find(entry=>entry.summary.id===id);if(exact)return exact;
    const named=visible.filter(entry=>entry.summary.name===id);if(named.length>1)throw new Error('存在同名技能，请使用 skills_list 返回的来源 ID');if(!named.length)throw new Error('技能不存在或无权访问');return named[0];
  }
  private fileList(entry:Entry,includeBytes=false):SkillFile[]{
    const files:SkillFile[]=[];let bytes=0;
    const visit=(dir:string,depth:number)=>{
      if(depth>10)throw new Error('技能资源目录过深');
      for(const item of readdirSync(dir,{withFileTypes:true})){
        if((item.name.startsWith('.')&&item.name!=='.env.example')||['node_modules','__pycache__','venv'].includes(item.name)||sensitiveFile(item.name))continue;
        const file=join(dir,item.name);const real=realpathSync.native(file);
        if(!isWithin(entry.root,real))throw new Error('技能资源链接超出了技能目录');
        if(item.isSymbolicLink()){if(statSync(real).isDirectory())continue;}
        if(statSync(real).isDirectory()){visit(real,depth+1);continue;}
        if(!statSync(real).isFile())continue;
        const size=statSync(real).size;bytes+=size;if(files.length>=500){if(includeBytes)throw new Error('技能包超过 500 个文件');break;}if(includeBytes&&bytes>16*1024*1024)throw new Error('技能包超过 16 MB，请仅保留必要资源');
        files.push({path:relative(entry.root,file).split(sep).join('/'),bytes:includeBytes?readFileSync(real):Buffer.alloc(0)});
      }
    };
    visit(entry.root,0);return files;
  }
  read(botId:string,id:string):Skill{
    const entry=this.find(botId,id);if(!isWithin(entry.root,realpathSync.native(entry.file)))throw new Error('技能文件链接超出了技能目录');
    if(statSync(entry.file).size>256*1024)throw new Error('SKILL.md 超过 256 KB');
    const parsed=parseSkill(readFileSync(entry.file,'utf8'),basename(entry.root));
    let files:string[]=[];try{files=this.fileList(entry).map(file=>file.path);}catch{/* Large packages remain readable; explicit materialization reports its limits. */}
    return {...entry.summary,body:parsed.body,compatibility:parsed.compatibility,availableFiles:files};
  }
  readFile(botId:string,id:string,path:string){
    const entry=this.find(botId,id);
    if(!path||path.includes('\\')||path.startsWith('/')||path.split('/').includes('..')||/^[a-z][a-z0-9+.-]*:/i.test(path)||sensitiveFile(basename(path)))throw new Error('请使用技能目录内的相对资源路径');
    const file=realpathSync.native(resolve(entry.root,path));if(!isWithin(entry.root,file)||!statSync(file).isFile())throw new Error('资源不在技能目录内');
    if(statSync(file).size>256*1024)throw new Error('资源过大，可将技能包同步到工作电脑后处理');return {path,content:readFileSync(file,'utf8')};
  }
  bundle(botId:string,id:string){const entry=this.find(botId,id);return {id:hashId(canonical(entry.root)),folder:basename(entry.root),files:this.fileList(entry,true)};}
  fingerprint(botId:string,id:string){const entry=this.find(botId,id);return hashId(readFileSync(entry.file,'utf8'));}
  revisions(botId:string,id:string){const entry=this.find(botId,id);if(entry.summary.botId!==botId)return [];const path=join(this.paths.dataDir,'bots',botId,'skill-history',entry.summary.id,'revisions.json');try{return JSON.parse(readFileSync(path,'utf8')) as Array<{revision:number;hash:string;createdAt:string;sourceRunId?:string;origin:string;file:string}>;}catch{return [];}}
  autoManaged(botId:string,id:string){return this.revisions(botId,id).find(item=>item.revision>0)?.origin==='background_review';}
  save(botId:string,name:string,description:string,body:string,provenance:{sourceRunId?:string;origin?:string;expectedHash?:string;sourceRefs?:string[]}={}){
    this.store.bot(botId);const existing=this.entries.find(entry=>entry.summary.botId===botId&&entry.summary.name===name);
    if(existing&&!isWithin(canonical(this.paths.dataDir),canonical(existing.file)))throw new Error('此技能指向外部目录，不能自动修改');
    if(provenance.expectedHash&&(!existing||this.fingerprint(botId,existing.summary.id)!==provenance.expectedHash))throw new Error('技能在读取后发生了变化，请重新读取再保存');
    const skill:Skill={id:existing?.summary.id||`private-${hashId(`${botId}:${name}`)}`,name,description,body,botId};
    const historyDir=join(this.paths.dataDir,'bots',botId,'skill-history',skill.id);mkdirSync(historyDir,{recursive:true});
    const revisions=existing?this.revisions(botId,existing.summary.id):[];
    if(existing&&!revisions.length){const original=readFileSync(existing.file,'utf8');writeAtomic(join(historyDir,'0.md'),original);revisions.push({revision:0,hash:hashId(original),createdAt:new Date().toISOString(),origin:'imported-private',file:'0.md'});}
    const path=this.writeOwned(skill,existing?.file),content=readFileSync(path,'utf8'),revision=(revisions.at(-1)?.revision??0)+1;
    writeAtomic(join(historyDir,`${revision}.md`),content);revisions.push({revision,hash:hashId(content),createdAt:new Date().toISOString(),origin:provenance.origin||'foreground',sourceRunId:provenance.sourceRunId,file:`${revision}.md`,...((provenance.sourceRefs?.length)?{sourceRefs:provenance.sourceRefs}:{})});
    writeAtomic(join(historyDir,'revisions.json'),JSON.stringify(revisions,null,2));
    this.refresh();return {saved:true,id:skill.id,name,scope:'bot-private',path,revision,hash:hashId(content)};
  }
}
