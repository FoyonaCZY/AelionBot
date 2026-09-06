import {platformName} from './host-platform';
import {existsSync} from 'node:fs';
import {basename,isAbsolute,join,resolve} from 'node:path';
import type {McpServerView,SkillSource,IntegrationSource} from '../../src/shared';
import {canonical,hashId,mcpSources,parseConfig,sourceView,type IntegrationPaths,type SourceDescriptor} from './integration-paths';

export interface McpConfig {
  id:string;name:string;source:SkillSource;native:boolean;transport:McpServerView['transport'];command?:string;args:string[];env:Record<string,string>;url?:string;headers:Record<string,string>;cwd:string;
  enabledBySource:boolean;startupTimeout:number;toolTimeout:number;include?:string[];exclude:string[];issue?:string;fingerprint:string;secrets:string[];
}
function record(value:any):Record<string,any>{return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function strings(value:any){return Array.isArray(value)?value.filter((item:unknown)=>typeof item==='string'):undefined;}
export function expandConfigString(value:string,options:IntegrationPaths,missing:Set<string>){
  const replacement=(name:string,fallback?:string)=>{
    if(name==='userHome')return options.homeDir;
    if(name==='workspaceFolder'||name==='CLAUDE_PROJECT_DIR')return options.projectDir;
    const key=name.startsWith('env:')?name.slice(4):name;
    if(name.startsWith('input:')){missing.add(name);return '';}
    const found=options.env[key]??(process.platform==='win32'?Object.entries(options.env).find(([k])=>k.toLowerCase()===key.toLowerCase())?.[1]:undefined);
    if(found!==undefined)return found;if(fallback!==undefined)return fallback;missing.add(key);return '';
  };
  return value.replace(/\$\{([^}]+)\}/g,(_whole,expression:string)=>{const at=expression.indexOf(':-');return at>=0?replacement(expression.slice(0,at),expression.slice(at+2)):replacement(expression);}).replace(/\{env:([^}]+)\}/g,(_whole,name:string)=>replacement(name));
}
function expandPath(value:string,options:IntegrationPaths,cwd:string){const expanded=value==='~'?options.homeDir:value.startsWith('~/')||value.startsWith('~\\')?join(options.homeDir,value.slice(2)):value;return isAbsolute(expanded)?resolve(expanded):resolve(cwd,expanded);}
function normalize(name:string,raw:any,source:SourceDescriptor,options:IntegrationPaths):McpConfig{
  raw=record(raw);const missing=new Set<string>();const expand=(value:string)=>expandConfigString(value,options,missing);
  const id=`mcp-${hashId(`${canonical(source.path)}:${source.label}:${name}`)}`;
  const env:Record<string,string>={},headers:Record<string,string>={};
  for(const [key,value] of Object.entries({...record(raw.environment),...record(raw.env)}))if(typeof value==='string')env[key]=expand(value);
  for(const key of strings(raw.env_vars)||[])env[key]=expand(`\${${key}}`);
  for(const [key,value] of Object.entries({...record(raw.http_headers),...record(raw.headers)}))if(typeof value==='string')headers[key]=expand(value);
  for(const [key,value] of Object.entries(record(raw.env_http_headers)))if(typeof value==='string')headers[key]=expand(`\${${value}}`);
  if(typeof raw.bearer_token_env_var==='string')headers.Authorization=`Bearer ${expand(`\${${raw.bearer_token_env_var}}`)}`;
  const commandArray=strings(raw.command);let command=commandArray?.[0]||(typeof raw.command==='string'?expand(raw.command):undefined);
  let args=(commandArray?commandArray.slice(1):strings(raw.args)||[]).map(expand);
  if(commandArray?.[0])command=expand(commandArray[0]);
  const cwd=typeof raw.cwd==='string'?expandPath(expand(raw.cwd),options,options.projectDir):options.projectDir;
  if(command&&(command.startsWith('~/')||command.startsWith('~\\')||command.startsWith('./')||command.startsWith('.\\')))command=expandPath(command,options,cwd);
  const url=typeof raw.url==='string'?expand(raw.url):typeof raw.serverUrl==='string'?expand(raw.serverUrl):undefined;
  let transport:McpConfig['transport']=command?'stdio':url?(raw.type==='sse'||/\/sse(?:\?|$)/.test(url)?'sse':'http'):'unsupported';let issue:string|undefined;
  if(raw.type&&['ws','websocket'].includes(raw.type))transport='unsupported';
  if(command&&url)issue='同时提供了 command 和 url，请保留一种传输配置';
  if(url)try{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))issue='目前支持 stdio、HTTP 和 SSE';if(parsed.username||parsed.password)issue='URL 中的用户名密码请移入 headers 配置';}catch{issue='MCP URL 无效';}
  if(raw.client_cert||raw.client_key)issue='此配置需要 mTLS 客户端证书，本版尚未支持';
  if(raw.type==='local'&&!command)issue='本地服务缺少 command';
  if(transport==='unsupported')issue='未找到受支持的 MCP command / url 配置';
  if(missing.size)issue=`需要配置变量：${[...missing].join('、')}`;
  let include=strings(raw.enabled_tools)||strings(record(raw.tools).include);
  const exclude=[...(strings(raw.disabled_tools)||[]),...(strings(record(raw.tools).exclude)||[])];
  for(const [tool,policy] of Object.entries(record(raw.tools)))if(record(policy).approval_mode==='deny')exclude.push(tool);
  if(raw.default_tools_approval_mode==='deny'){
    const explicitlyAllowed=Object.entries(record(raw.tools)).filter(([,policy])=>record(policy).approval_mode==='approve').map(([tool])=>tool);
    include=include?include.filter(tool=>explicitlyAllowed.includes(tool)):explicitlyAllowed;
    if(!explicitlyAllowed.length)issue='来源将所有工具设为 deny';
  }
  const sourceInfo:SkillSource={label:source.label,path:source.path,scope:source.scope,readonly:!source.native};
  const secrets=[...Object.entries(env).filter(([key])=>/TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL/i.test(key)).map(([,value])=>value),...Object.values(headers)];
  if(url)try{for(const value of new URL(url).searchParams.values())secrets.push(value);}catch{}
  const config:McpConfig={id,name,source:sourceInfo,native:Boolean(source.native),transport,command,args,env,url,headers,cwd,enabledBySource:raw.enabled!==false&&raw.disabled!==true,startupTimeout:Math.min(60000,Math.max(1000,Number(raw.startup_timeout_sec||raw.connect_timeout||20)*1000)),toolTimeout:Math.min(120000,Math.max(1000,Number(raw.tool_timeout_sec||60)*1000)),include,exclude,issue,fingerprint:'',secrets:secrets.filter(value=>value.length>=4)};
  config.fingerprint=hashId(JSON.stringify({...config,secrets:undefined}));return config;
}
export function discoverMcp(options:IntegrationPaths):{configs:McpConfig[];sources:IntegrationSource[]}{
  const configs:McpConfig[]=[],sources:IntegrationSource[]=[];
  for(const source of mcpSources(options)){
    if(!existsSync(source.path)){sources.push(sourceView(source));continue;}
    try{
      const data=parseConfig(source.path,source.format);
      const maps:Array<{value:Record<string,any>;source:SourceDescriptor}>=[{value:record(data.mcpServers||data.mcp_servers||data.servers||data.mcp),source}];
      if(source.format==='claude'){
        for(const [project,config] of Object.entries(record(data.projects)))if(canonical(project)===canonical(options.projectDir))maps.push({value:record(record(config).mcpServers),source:{...source,label:'Claude Code · 项目',scope:'project'}});
      }
      let count=0;for(const map of maps)for(const [name,raw] of Object.entries(map.value)){
        if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
        const config=normalize(name,raw,map.source,options);
        // OpenCode's client-wide tools=false must not silently become an enabled integration.
        const toolSettings=record(data.tools);if(toolSettings[name]===false||toolSettings[`${name}*`]===false)config.enabledBySource=false;
        configs.push(config);count++;
      }
      sources.push(sourceView(source,count));
    }catch(error){sources.push(sourceView(source,0,(error as Error).message));}
  }
  return {configs,sources};
}
export function publicEndpoint(config:McpConfig){
  if(config.transport==='stdio')return `${basename(config.command||'')} · ${platformName()} 本机`;
  if(config.url)try{return new URL(config.url).origin;}catch{}
  return '配置不可用';
}
export function redactMcp(value:unknown,config:McpConfig):unknown{
  if(typeof value==='string'){let text=value;for(const secret of config.secrets)text=text.split(secret).join('[redacted]');return text;}
  if(Array.isArray(value))return value.map(item=>redactMcp(item,config));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redactMcp(item,config)]));return value;
}
