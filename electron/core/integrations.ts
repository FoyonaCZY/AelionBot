import {existsSync,mkdirSync,readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {IntegrationsView,ScreenReference} from '../../src/shared';
import {atomicJson,Store} from './store';
import {canonical,hashId,type IntegrationPaths,type SourceDescriptor} from './integration-paths';
import {SkillLibrary} from './skill-library';
import {discoverMcp} from './mcp-config';
import {McpRuntime,type McpPreference} from './mcp-runtime';
import type {VmController} from './vm';

interface Preferences {version:1;extraSkillDirs:string[];extraMcpFiles:string[];servers:Record<string,McpPreference>;}
export class Integrations {
  readonly skills:SkillLibrary;
  readonly mcp:McpRuntime;
  readonly preferencesFile:string;
  private preferences:Preferences;
  private mcpSources:IntegrationsView['sources']=[];
  private scannedAt='';
  constructor(private store:Store,readonly paths:IntegrationPaths,private changed:()=>void,imageSink?:(data:string,mime:string)=>ScreenReference){
    mkdirSync(paths.configDir,{recursive:true});mkdirSync(join(paths.homeDir,'.agents','skills'),{recursive:true});
    const mcpFile=join(paths.configDir,'mcp.json');if(!existsSync(mcpFile))atomicJson(mcpFile,{mcpServers:{}});
    this.preferencesFile=join(paths.configDir,'integrations.json');
    let saved:Partial<Preferences>={};try{if(existsSync(this.preferencesFile))saved=JSON.parse(readFileSync(this.preferencesFile,'utf8').replace(/^\uFEFF/,''));}catch{/* An invalid preference cache does not prevent discovery. */}
    this.preferences={version:1,extraSkillDirs:Array.isArray(saved.extraSkillDirs)?saved.extraSkillDirs.filter(value=>typeof value==='string'):[],extraMcpFiles:Array.isArray(saved.extraMcpFiles)?saved.extraMcpFiles.filter(value=>typeof value==='string'):[],servers:saved.servers&&typeof saved.servers==='object'?saved.servers:{}};
    paths.extraSkillDirs=this.preferences.extraSkillDirs;paths.extraMcpFiles=this.preferences.extraMcpFiles;
    this.skills=new SkillLibrary(store,paths);this.mcp=new McpRuntime(this.preferences.servers,changed,imageSink);
  }
  async refresh(){this.skills.refresh();const discovered=discoverMcp(this.paths);this.mcpSources=discovered.sources;await this.mcp.replace(discovered.configs);this.scannedAt=new Date().toISOString();this.changed();}
  snapshot():IntegrationsView{return {sharedSkillDir:join(this.paths.homeDir,'.agents','skills'),privateSkillDir:join(this.paths.dataDir,'bots'),mcpFile:join(this.paths.configDir,'mcp.json'),projectDir:this.paths.projectDir,sources:[...this.skills.sources,...this.mcpSources],servers:this.mcp.views(),scannedAt:this.scannedAt};}
  private save(){atomicJson(this.preferencesFile,this.preferences);}
  async add(kind:'skills'|'mcp',path:string){
    path=resolve(path);if(kind==='skills'&&!statSync(path).isDirectory()||kind==='mcp'&&!statSync(path).isFile())throw new Error('请选择有效目录或配置文件');
    const list=kind==='skills'?this.preferences.extraSkillDirs:this.preferences.extraMcpFiles;if(!list.some(value=>canonical(value)===canonical(path)))list.push(path);this.save();await this.refresh();
  }
  path(input:{kind:string;id?:string}){
    const view=this.snapshot();if(input.kind==='shared-skills')return view.sharedSkillDir;if(input.kind==='private-skills'){mkdirSync(view.privateSkillDir,{recursive:true});return view.privateSkillDir;}if(input.kind==='mcp-config')return view.mcpFile;
    const source=view.sources.find(source=>source.id===input.id);if(source)return source.path;
    const skill=this.skills.all().find(skill=>skill.id===input.id);if(skill?.source)return skill.source.path;
    const server=view.servers.find(server=>server.id===input.id);if(server)return server.source.path;
    throw new Error('来源路径不存在');
  }
  async setEnabled(id:string,enabled:boolean){await this.mcp.setEnabled(id,enabled);this.save();}
  async materialize(vm:VmController,botId:string,id:string){
    const bundle=this.skills.bundle(botId,id);const digest=hashId(bundle.files.map(file=>`${file.path}:${hashId(file.bytes.toString('base64'))}`).join('\n'));
    const vmPath=await vm.installSkillPackage(botId,`${bundle.id}-${digest}`,bundle.folder,bundle.files);
    return {id,name:this.skills.read(botId,id).name,vmPath,files:bundle.files.map(file=>file.path),note:'这是技能的工作电脑副本；原 Agent 目录保持只读。请在此目录执行相对脚本，依赖需在工作电脑中可用。'};
  }
  async close(){await this.mcp.dispose();}
}
