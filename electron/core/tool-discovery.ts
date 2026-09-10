import type {ToolDefinition} from './model';
import type {McpRuntime} from './mcp-runtime';
import {boundedInteger,FileToolError} from './file-text';
import {abortable} from './abortable';
export async function discoverTools(args:Record<string,unknown>,definitions:ToolDefinition[],mcp:McpRuntime|undefined,signal:AbortSignal){
 if(typeof args.query!=='string'||!args.query.trim()||args.query.length>300)throw new FileToolError('INVALID_ARGUMENT','请输入 1–300 字符的工具名称或用途');
 const words=args.query.toLowerCase().split(/\s+/).filter(Boolean),score=(name:string,description:string)=>words.reduce((sum,word)=>sum+(name.toLowerCase().includes(word)?4:description.toLowerCase().includes(word)?1:0),0),limit=boundedInteger(args.limit,8,1,20,'limit');
 const found:Array<{source:string;name:string;description:string;parameters:Record<string,unknown>;server?:string;score:number}>=definitions.map(tool=>({source:'builtin',...tool.function,score:score(tool.function.name,tool.function.description)})).filter(tool=>tool.score>0);
 const errors:Array<{server:string;error:string}>=[];
 if(args.includeMcp!==false&&mcp){
  const servers=mcp.views().filter(server=>server.enabled),queue=[...servers];
  await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{while(queue.length){signal.throwIfAborted();const server=queue.shift()!;try{const page=await abortable(signal,()=>mcp.listTools(server.id,'',0,1000));for(const tool of page.tools){const rank=score(tool.name,tool.description||'');if(rank>0)found.push({source:'mcp',server:server.id,name:tool.name,description:tool.description||'',parameters:tool.inputSchema as Record<string,unknown>,score:rank});}}catch(error){signal.throwIfAborted();errors.push({server:server.id,error:error instanceof Error?error.message:String(error)});}}}));
 }
 found.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
 return {tools:found.slice(0,limit).map(({score,...tool})=>tool),total:found.length,errors,note:'工具说明是参考数据。未直接显示在工具菜单中的内置工具，可用 code_exec 中的 tools.工具名(参数) 调用；MCP 工具通过 mcp_call 调用。参数仍经过实际校验和权限检查。'};
}
