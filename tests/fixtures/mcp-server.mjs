import {createServer} from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import {CallToolRequestSchema,ListToolsRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema,ListPromptsRequestSchema,GetPromptRequestSchema} from '@modelcontextprotocol/sdk/types.js';

export function fixtureServer(){
  const server=new Server({name:'aelion-interop-fixture',version:'1.0.0'},{capabilities:{tools:{},resources:{},prompts:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',description:'Echo a synthetic verification value',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message']},annotations:{readOnlyHint:true}},{name:'denied',description:'Policy test; should never be called',inputSchema:{type:'object'}}]}));
  server.setRequestHandler(CallToolRequestSchema,async request=>({content:[{type:'text',text:JSON.stringify({echo:request.params.arguments?.message||'',platform:process.platform,credential:process.env.MCP_FIXTURE_TOKEN||'none'})}],structuredContent:{echo:request.params.arguments?.message||'',platform:process.platform}}));
  server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:'fixture://readme',name:'fixture readme',mimeType:'text/plain'}]}));
  server.setRequestHandler(ReadResourceRequestSchema,async request=>({contents:[{uri:request.params.uri,text:'fixture resource ready'}]}));
  server.setRequestHandler(ListPromptsRequestSchema,async()=>({prompts:[{name:'verify',description:'Synthetic prompt',arguments:[{name:'value',required:true}]}]}));
  server.setRequestHandler(GetPromptRequestSchema,async request=>({messages:[{role:'user',content:{type:'text',text:`Verify ${request.params.arguments?.value||''}`}}]}));
  return server;
}
export async function httpFixture(){
  const sessions=new Map();const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/auth'&&req.headers.authorization!=='Bearer fixture-secret'){res.writeHead(401).end('unauthorized');return;}
    if((url.pathname==='/sse'||url.pathname==='/legacy')&&req.method==='GET'){
      const transport=new SSEServerTransport('/messages',res);const mcp=fixtureServer();sessions.set(transport.sessionId,{mcp,transport});res.on('close',()=>{sessions.delete(transport.sessionId);void mcp.close();});await mcp.connect(transport);return;
    }
    if(req.method!=='POST'){res.writeHead(405).end();return;}
    let text='';for await(const chunk of req)text+=chunk;let body;try{body=JSON.parse(text);}catch{res.writeHead(400).end();return;}
    if(url.pathname==='/messages'){const session=sessions.get(url.searchParams.get('sessionId'));if(!session){res.writeHead(404).end();return;}await session.transport.handlePostMessage(req,res,body);return;}
    if(!['/mcp','/auth'].includes(url.pathname)){res.writeHead(405).end();return;}
    const mcp=fixtureServer();const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});res.on('close',()=>{void mcp.close();});await mcp.connect(transport);await transport.handleRequest(req,res,body);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();
  return {url:`http://127.0.0.1:${address.port}`,close:async()=>{await Promise.allSettled([...sessions.values()].map(session=>session.mcp.close()));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv.includes('--stdio')){const server=fixtureServer();await server.connect(new StdioServerTransport());}
