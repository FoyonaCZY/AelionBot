import {validateSchema} from './tool-schema';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import type {HostPermissionDetails,McpServerView,ScreenReference} from '../../src/shared';
import {publicEndpoint,redactMcp,type McpConfig} from './mcp-config';
import {hostname,networkInterfaces} from 'node:os';

type Transport=StdioClientTransport|StreamableHTTPClientTransport|SSEClientTransport;
interface Connection {client:Client;transport:Transport;tools:Tool[];fingerprint:string;}
export interface McpPreference {enabled:boolean;fingerprint:string;}
export class McpRuntime {
  private configs=new Map<string,McpConfig>();
  private connections=new Map<string,Connection>();
  private pending=new Map<string,Promise<Connection>>();
  private starting=new Map<string,{client:Client;transport:Transport}>();
  private states=new Map<string,{status:McpServerView['status'];issue?:string}>();
  private closing=false;
  constructor(private preferences:Record<string,McpPreference>,private changed:()=>void,private imageSink?:(data:string,mime:string)=>ScreenReference){}
  async replace(configs:McpConfig[]){
    const next=new Map(configs.map(config=>[config.id,config]));
    for(const [id,connection] of this.connections)if(next.get(id)?.fingerprint!==connection.fingerprint)await this.disconnect(id);
    this.configs=next;for(const id of this.states.keys())if(!next.has(id))this.states.delete(id);
  }
  private enabled(config:McpConfig){const preference=this.preferences[config.id];return typeof preference?.enabled==='boolean'&&preference.fingerprint===config.fingerprint?preference.enabled:config.native&&config.enabledBySource;}
  views():McpServerView[]{return [...this.configs.values()].map(config=>{
    const enabled=this.enabled(config),state=this.states.get(config.id),connection=this.connections.get(config.id);
    return {id:config.id,name:config.name,source:config.source,transport:config.transport,endpoint:publicEndpoint(config),enabled,status:config.issue?'needs-config':!enabled?'disabled':state?.status||'available',issue:config.issue||state?.issue,toolCount:connection?.tools.length};
  });}
  private find(id:string){
    if(this.configs.has(id))return this.configs.get(id)!;
    const named=[...this.configs.values()].filter(config=>config.name===id);if(named.length>1)throw new Error('存在同名 MCP 服务，请使用 mcp_list_servers 返回的 ID');if(!named.length)throw new Error('MCP 服务不存在');return named[0];
  }
  hostPermission(id:string){
    const config=this.find(id);
    const address=config.url?new URL(config.url).hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase():'';
    const addresses=new Set(['localhost','0.0.0.0','::1','::',hostname().toLowerCase(),'host.docker.internal',...Object.values(networkInterfaces()).flatMap(items=>(items||[]).map(item=>item.address.toLowerCase()))]);
    const local=config.transport==='stdio'||addresses.has(address)||/^127\./.test(address)||/^::ffff:7f[0-9a-f]{2}:/i.test(address);
    if(!local)return undefined;
    if(config.issue)throw new Error(config.issue);
    if(!this.enabled(config))throw new Error('此 MCP 尚未启用，请先在设置的 MCP 页面启用一次');
    return {server:config.name,command:config.transport==='stdio'?String(redactMcp([config.command,...config.args].join(' '),config)):undefined,cwd:config.cwd,path:config.source.path};
  }
  async setEnabled(id:string,enabled:boolean){const config=this.find(id);this.preferences[config.id]={enabled,fingerprint:config.fingerprint};if(!enabled)await this.disconnect(config.id);this.states.delete(config.id);this.changed();}
  private allowed(config:McpConfig,name:string){return (!config.include||config.include.includes(name))&&!config.exclude.includes(name);}
  private async connect(id:string):Promise<Connection>{
    const config=this.find(id);
    if(this.closing)throw new Error('应用正在关闭');
    if(config.issue)throw new Error(config.issue);
    if(!this.enabled(config))throw new Error('此 MCP 尚未启用，请先在设置的 MCP 页面启用一次');
    const existing=this.connections.get(config.id);if(existing)return existing;
    const running=this.pending.get(config.id);if(running)return running;
    this.states.set(config.id,{status:'connecting'});this.changed();
    const connectOnce=async(mode:'stdio'|'http'|'sse')=>{
      const client=new Client({name:'aelion-bot',version:'0.4.0'});
      const requestInit={headers:config.headers};let transport:Transport;
      if(mode==='stdio'){
        const stdio=new StdioClientTransport({command:config.command!,args:config.args,env:config.env,cwd:config.cwd,stderr:'pipe',maxBufferSize:16*1024*1024});
        // Drain diagnostic output without copying provider credentials into app logs.
        stdio.stderr?.on('data',()=>{});transport=stdio;
      }else if(mode==='sse')transport=new SSEClientTransport(new URL(config.url!),{requestInit,eventSourceInit:{fetch:(url,init)=>fetch(url,{...init,headers:{...Object.fromEntries(new Headers(init?.headers).entries()),...config.headers}})}});
      else transport=new StreamableHTTPClientTransport(new URL(config.url!),{requestInit,reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
      const starting={client,transport};this.starting.set(config.id,starting);
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        await Promise.race([client.connect(transport),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('MCP_STARTUP_TIMEOUT')),config.startupTimeout);})]);
        clearTimeout(timer);
        if(this.closing||!this.enabled(config)||this.configs.get(config.id)?.fingerprint!==config.fingerprint)throw new Error('MCP_DISABLED');
        const tools:Tool[]=[];let cursor:string|undefined;
        if(client.getServerCapabilities()?.tools)do{
          const page=await client.listTools(cursor?{cursor}:{},{timeout:config.startupTimeout});tools.push(...page.tools.filter(tool=>this.allowed(config,tool.name)));cursor=page.nextCursor;
          if(tools.length>1000)throw new Error('MCP_TOOL_LIMIT');
        }while(cursor);
        const connection={client,transport,tools,fingerprint:config.fingerprint};
        client.onclose=()=>{if(this.connections.get(config.id)===connection){this.connections.delete(config.id);this.states.set(config.id,{status:'available',issue:'连接已结束，下次使用会重新连接'});this.changed();}};
        client.onerror=()=>{};
        return connection;
      }catch(error){clearTimeout(timer);await client.close().catch(()=>{});await transport.close().catch(()=>{});throw error;}
      finally{if(this.starting.get(config.id)===starting)this.starting.delete(config.id);}
    };
    const promise=(async()=>{
      try{
        let connection:Connection;
        try{connection=await connectOnce(config.transport as 'stdio'|'http'|'sse');}
        catch(error){const code=Number((error as {code?:number}).code);if(config.transport==='http'&&[404,405,406,415].includes(code))connection=await connectOnce('sse');else throw error;}
        this.connections.set(config.id,connection);this.states.set(config.id,{status:'connected'});this.changed();return connection;
      }catch(error){
        const code=Number((error as {code?:number}).code);const auth=[401,403].includes(code)||(error as Error).name==='UnauthorizedError';
        const issue=auth?'服务需要授权；本应用不自动读取其他 Agent 的 OAuth 登录缓存':'MCP 连接或初始化失败，请检查来源配置、命令依赖及网络';
        this.states.set(config.id,{status:'error',issue});this.changed();throw new Error(issue);
      }finally{this.pending.delete(config.id);}
    })();
    this.pending.set(config.id,promise);return promise;
  }
  async listTools(id:string,query='',offset=0,limit=100){
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>1000)throw Error('工具分页参数无效');
    const config=this.find(id),connection=await this.connect(config.id);const wanted=query.toLowerCase();
    const tools=connection.tools.filter(tool=>!wanted||`${tool.name} ${tool.description||''}`.toLowerCase().includes(wanted));
    const end=Math.min(tools.length,offset+limit);return {server:config.id,name:config.name,location:publicEndpoint(config),total:tools.length,tools:tools.slice(offset,end),nextOffset:end,eof:end>=tools.length};
  }
  async inspectCall(id:string,name:string,args:Record<string,unknown>,requireLocalApproval=false):Promise<{fingerprint:string;permission?:HostPermissionDetails}>{
    const config=this.find(id),connection=await this.connect(config.id),tool=connection.tools.find(tool=>tool.name===name);
    if(!tool||!this.allowed(config,name))throw new Error('工具不存在或已被来源配置禁用');
    validateSchema(tool.inputSchema as Record<string,unknown>,args,name);
    const local=this.hostPermission(config.id);
    if(tool.annotations?.readOnlyHint===true&&tool.annotations.destructiveHint!==true&&(!requireLocalApproval||!local))return {fingerprint:connection.fingerprint};
    return {fingerprint:connection.fingerprint,permission:{operation:'mcp',permissionScope:local?'host':'remote',reason:'确认 MCP 工具操作',server:config.name,tool:name,arguments:redactMcp(args,config) as Record<string,unknown>,...local}};
  }
  async call(id:string,name:string,args:Record<string,unknown>,signal:AbortSignal,expectedFingerprint?:string){
    const config=this.find(id),connection=await this.connect(config.id);
    if(signal.aborted)throw new Error('任务已取消');
    if(connection.fingerprint!==config.fingerprint||expectedFingerprint&&expectedFingerprint!==connection.fingerprint)throw new Error('MCP 配置已变化，请重新核对工具');
    if(!connection.tools.some(tool=>tool.name===name)||!this.allowed(config,name))throw new Error('工具不存在或已被来源配置禁用');
    validateSchema(connection.tools.find(tool=>tool.name===name)!.inputSchema as Record<string,unknown>,args,name);
    try{
      const result=await connection.client.callTool({name,arguments:args},undefined,{signal,timeout:config.toolTimeout});
      if(JSON.stringify(result).length>16*1024*1024)throw new Error('MCP_RESULT_LIMIT');
      const safe=redactMcp(result,config) as any;const images:ScreenReference[]=[];
      safe.content=(safe.content||[]).map((block:any)=>{
        if(block.type!=='image')return block;
        try{if(!this.imageSink)throw new Error('No image sink');const image=this.imageSink(block.data,block.mimeType);images.push(image);return {type:'text',text:`工具图像已附加：${image.width}×${image.height}`};}
        catch{return {type:'text',text:'该工具返回的图像无法加载，文本结果仍可读取。'};}
      });
      return {server:config.id,tool:name,...safe,...(images.length?{images}:{})};
    }catch(error){throw Object.assign(new Error(signal.aborted?'MCP 操作已取消；已发生的操作不会回滚':'MCP 工具调用失败或结果超限；操作可能已经发生，请先核对结果再决定是否重试'),{outcomeUnknown:true});}
  }
  private async safeRequest(config:McpConfig,operation:()=>Promise<unknown>){try{const result=await operation();if(JSON.stringify(result).length>16*1024*1024)throw new Error('Result limit');return redactMcp(result,config);}catch{throw new Error('MCP 资源或模板请求失败，请检查服务状态和参数');}}
  async listResources(id:string,cursor?:string){const config=this.find(id),connection=await this.connect(config.id);if(!connection.client.getServerCapabilities()?.resources)return {resources:[]};return this.safeRequest(config,()=>connection.client.listResources(cursor?{cursor}:{}, {timeout:config.toolTimeout}));}
  async listResourceTemplates(id:string,cursor?:string){const config=this.find(id),connection=await this.connect(config.id);if(!connection.client.getServerCapabilities()?.resources)return {resourceTemplates:[]};return this.safeRequest(config,()=>connection.client.listResourceTemplates(cursor?{cursor}:{},{timeout:config.toolTimeout}));}
  async readResource(id:string,uri:string,signal:AbortSignal){const config=this.find(id),connection=await this.connect(config.id);return this.safeRequest(config,()=>connection.client.readResource({uri},{signal,timeout:config.toolTimeout}));}
  async listPrompts(id:string){const config=this.find(id),connection=await this.connect(config.id);if(!connection.client.getServerCapabilities()?.prompts)return {prompts:[]};return this.safeRequest(config,()=>connection.client.listPrompts({}, {timeout:config.toolTimeout}));}
  async getPrompt(id:string,name:string,args:Record<string,string>,signal:AbortSignal){const config=this.find(id),connection=await this.connect(config.id);return this.safeRequest(config,()=>connection.client.getPrompt({name,arguments:args},{signal,timeout:config.toolTimeout}));}
  async disconnect(id:string){
    const starting=this.starting.get(id);this.starting.delete(id);if(starting){await starting.client.close().catch(()=>{});await starting.transport.close().catch(()=>{});}
    const connection=this.connections.get(id);this.connections.delete(id);this.states.delete(id);
    if(connection){if(connection.transport instanceof StreamableHTTPClientTransport)await connection.transport.terminateSession().catch(()=>{});await connection.client.close().catch(()=>{});await connection.transport.close().catch(()=>{});}
  }
  async dispose(){this.closing=true;await Promise.allSettled([...new Set([...this.connections.keys(),...this.starting.keys()])].map(id=>this.disconnect(id)));await Promise.allSettled([...this.pending.values()]);await Promise.allSettled([...this.connections.keys()].map(id=>this.disconnect(id)));}
}
