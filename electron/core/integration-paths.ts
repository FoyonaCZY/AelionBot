import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename,dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {parse as parseToml} from 'smol-toml';
import {parseDocument} from 'yaml';
import {parse as parseJsonc,type ParseError} from 'jsonc-parser';
import type {IntegrationSource} from '../../src/shared';

export interface IntegrationPaths {homeDir:string;projectDir:string;dataDir:string;configDir:string;env:Record<string,string|undefined>;extraSkillDirs?:string[];extraMcpFiles?:string[];}
export interface SourceDescriptor {label:string;path:string;kind:'skills'|'mcp';scope:'user'|'project'|'private'|'builtin';native?:boolean;projectDir?:string;format?:'json'|'toml'|'yaml'|'claude';}
export const hashId=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,20);
export function canonical(path:string){const absolute=resolve(path);let real=absolute;try{real=realpathSync.native(absolute);}catch{}return process.platform==='win32'?real.toLowerCase():real;}
export function isWithin(root:string,path:string){const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`);}
export function parseConfig(path:string,format?:SourceDescriptor['format']):Record<string,any>{
  if(statSync(path).size>8*1024*1024)throw new Error('配置文件超过 8 MB，未读取');
  const text=readFileSync(path,'utf8').replace(/^\uFEFF/,'');const extension=extname(path).toLowerCase();let value:unknown;
  try{
    if(format==='toml'||extension==='.toml')value=parseToml(text);
    else if(format==='yaml'||['.yaml','.yml'].includes(extension)){
      const doc=parseDocument(text,{prettyErrors:false,uniqueKeys:true});if(doc.errors.length)throw new Error('yaml');value=doc.toJS({maxAliasCount:100});
    }else{const errors:ParseError[]=[];value=parseJsonc(text,errors,{allowTrailingComma:true,disallowComments:false});if(errors.length)throw new Error('json');}
  }catch{throw new Error('配置格式不合法，请检查 JSON / JSONC / TOML / YAML 语法');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('配置根节点必须是对象');return value as Record<string,any>;
}
export function sourceView(source:SourceDescriptor,count=0,issue?:string):IntegrationSource{return {id:hashId(`${source.kind}:${canonical(source.path)}:${source.label}`),label:source.label,path:source.path,kind:source.kind,scope:source.scope,exists:existsSync(source.path),count,...(issue?{issue}:{})};}
function projectAncestors(projectDir:string){const roots=[resolve(projectDir)];let current=roots[0];while(!existsSync(join(current,'.git'))){const parent=dirname(current);if(parent===current)break;current=parent;roots.push(current);if(roots.length>16)break;}return existsSync(join(current,'.git'))?roots:[resolve(projectDir)];}
export function skillSources(options:IntegrationPaths):SourceDescriptor[]{
  const {homeDir,projectDir,dataDir,configDir,env}=options;const sources:SourceDescriptor[]=[];
  const add=(label:string,path:string,scope:SourceDescriptor['scope'])=>sources.push({label,path,kind:'skills',scope});
  add('Aelion 内置',join(dataDir,'skills','builtin'),'builtin');
  add('Aelion 私有',join(dataDir,'bots'),'private');
  for(const root of projectAncestors(projectDir))for(const [dir,label] of [['.agents','共享'],['.claude','Claude'],['.codex','Codex'],['.cursor','Cursor'],['.opencode','OpenCode']])add(`${label} · 项目${root===resolve(projectDir)?'':` · ${basename(root)}`}`,join(root,dir,'skills'),'project');
  for(const [dir,label] of [['.agents','共享技能'],['.claude','Claude'],['.cursor','Cursor'],['.codex','Codex 兼容'],['.config/opencode','OpenCode'],['.hermes','Hermes']])add(label,join(homeDir,dir,'skills'),'user');
  if(env.CODEX_HOME)add('Codex 自定义',join(env.CODEX_HOME,'skills'),'user');
  add('Codex 内置',join(env.CODEX_HOME||join(homeDir,'.codex'),'skills','.system'),'user');
  if(env.HERMES_HOME)add('Hermes 自定义',join(env.HERMES_HOME,'skills'),'user');
  add('Hermes Desktop',join(env.LOCALAPPDATA||join(homeDir,'AppData','Local'),'hermes','skills'),'user');
  if(env.XDG_CONFIG_HOME)add('OpenCode 自定义',join(env.XDG_CONFIG_HOME,'opencode','skills'),'user');
  add('Aelion 共享',join(configDir,'skills'),'user');
  for(const path of options.extraSkillDirs||[])add('自选技能目录',path,'user');
  const seen=new Set<string>();return sources.filter(source=>{const key=canonical(source.path);if(seen.has(key))return false;seen.add(key);return true;});
}
export function mcpSources(options:IntegrationPaths):SourceDescriptor[]{
  const {homeDir,projectDir,configDir,env}=options;const sources:SourceDescriptor[]=[];
  const add=(label:string,path:string,scope:'user'|'project',format?:SourceDescriptor['format'],native=false)=>sources.push({label,path,kind:'mcp',scope,format,native,projectDir});
  add('Aelion',join(configDir,'mcp.json'),'user','json',true);
  for(const [file,label,format] of [['.mcp.json','MCP 项目','json'],['.cursor/mcp.json','Cursor 项目','json'],['.vscode/mcp.json','VS Code 项目','json'],['.codex/config.toml','Codex 项目','toml'],['opencode.json','OpenCode 项目','json'],['opencode.jsonc','OpenCode 项目','json']] as const)add(label,join(projectDir,file),'project',format);
  add('Claude Code',join(homeDir,'.claude.json'),'user','claude');
  add('Cursor',join(homeDir,'.cursor','mcp.json'),'user','json');
  add('Codex',join(env.CODEX_HOME||join(homeDir,'.codex'),'config.toml'),'user','toml');
  add('Hermes',join(env.HERMES_HOME||join(homeDir,'.hermes'),'config.yaml'),'user','yaml');
  add('Hermes Desktop',join(env.LOCALAPPDATA||join(homeDir,'AppData','Local'),'hermes','config.yaml'),'user','yaml');
  const xdg=env.XDG_CONFIG_HOME||join(homeDir,'.config');
  for(const file of ['opencode.json','opencode.jsonc'])add('OpenCode',join(xdg,'opencode',file),'user','json');
  const appData=env.APPDATA||join(homeDir,'AppData','Roaming');
  add('Claude Desktop',join(appData,'Claude','claude_desktop_config.json'),'user','json');
  add('VS Code',join(appData,'Code','User','mcp.json'),'user','json');
  for(const path of options.extraMcpFiles||[])add('自选 MCP 配置',path,'user');
  const seen=new Set<string>();return sources.filter(source=>{const key=canonical(source.path);if(seen.has(key))return false;seen.add(key);return true;});
}
