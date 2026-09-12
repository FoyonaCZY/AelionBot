import test from 'node:test';
import assert from 'node:assert/strict';
import {contextOverview} from '../electron/core/context-overview';
import {estimateRequest} from '../electron/core/context-budget';
import {protocolRequest} from '../electron/core/model-protocol';
import type {ToolDefinition} from '../electron/core/model';
import type {WireMessage,ModelConfig} from '../src/shared';
const model:ModelConfig={model:'fixture',providerId:'p',contextTokens:128000,baseUrl:'http://localhost:1/v1',hasKey:false};
const tools:ToolDefinition[]=['file_read','mcp_call_tool'].map(name=>({type:'function',function:{name,description:'Read documented resources',parameters:{type:'object',properties:{}}}}));
const messages:WireMessage[]=[
 {role:'system',content:'System instructions'},
 {role:'system',content:'当前可用技能清单：'+JSON.stringify({name:'PDF',description:'Create a PDF'})},
 {role:'user',content:'Prepare a report'},
 {role:'assistant',content:'Inspecting sources',tool_calls:[{id:'s',type:'function',function:{name:'skill_read',arguments:'{}'}},{id:'m',type:'function',function:{name:'mcp_call_tool',arguments:'{}'}},{id:'f',type:'function',function:{name:'file_read',arguments:'{}'}}]},
 {role:'tool',tool_call_id:'s',content:'Skill body with detailed workflow'},
 {role:'tool',tool_call_id:'m',content:'MCP tool description and resource result'},
 {role:'tool',tool_call_id:'f',content:'File contents'},
 {role:'user',content:'Image',images:[{id:'i',width:768,height:768}]},
];
test('context categories account for prepared input once and never change request/cache payloads',()=>{
 const before=structuredClone(messages),wire=protocolRequest(model,messages,tools,2048,'',()=> 'data:image/png;base64,AA==').body;
 const result=contextOverview(messages,tools,model);
 assert.equal(result.tokens,estimateRequest(messages,tools).tokens);
 assert.equal(Object.values(result.parts).reduce((a,b)=>a+b,0),result.tokens);
 for(const value of Object.values(result.parts))assert.ok(value>0);
 assert.equal(result.parts.images,1024);
 assert.deepEqual(messages,before);
 assert.deepEqual(protocolRequest(model,messages,tools,2048,'',()=> 'data:image/png;base64,AA==').body,wire);
 assert.ok(!JSON.stringify(result).includes('Prepare a report'));
});
test('usage anchors preserve an additive breakdown and invalid anchors use tokenizer estimates',()=>{
 const result=contextOverview(messages,tools,model,{estimatedTokens:54321,estimateSource:'usage-anchor'});
 assert.equal(result.tokens,54321);assert.equal(Object.values(result.parts).reduce((a,b)=>a+b,0),54321);
 assert.equal(result.estimateSource,'usage-anchor');
 assert.equal(contextOverview(messages,tools,model,{estimatedTokens:NaN}).tokens,estimateRequest(messages,tools).tokens);
});
test('empty schemas, quoted skill markers and mixed batch outputs are not mislabeled',()=>{
 const request:WireMessage[]=[{role:'user',content:'当前可用技能清单：quoted text'}, {role:'assistant',content:'已使用技能的参考快照（不增加权限）：PDF details'}, {role:'tool',tool_call_id:'batch',content:'Mixed result'}];
 const result=contextOverview(request,[],model);
 assert.equal(result.parts.mcp,0);assert.ok(result.parts.conversation>0);assert.ok(result.parts.skills>0);assert.ok(result.parts.results>0);assert.equal(result.parts.images,0);
});
