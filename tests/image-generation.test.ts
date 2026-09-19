import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {imageBytesFromGeneration,generateModelImage,imageGenerationKind,imageGenerationSequence,geminiImageUrl} from '../electron/core/image-generation';
import {ModelClient} from '../electron/core/model';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');

test('image generation routes by model id, not chat reasoning settings',()=>{
  assert.equal(imageGenerationKind('dall-e-3','chat'),'openai');
  assert.equal(imageGenerationKind('gpt-image-1','responses'),'responses');
  assert.equal(imageGenerationKind('gemini-2.5-flash-image','chat'),'gemini');
  assert.equal(imageGenerationKind('imagen-3.0-generate-002','gemini'),'gemini');
  assert.deepEqual(imageGenerationSequence('dall-e-3','chat'),['openai','gemini']);
  assert.deepEqual(imageGenerationSequence('gemini-2.5-flash-image','chat', 'openai'),['openai','gemini']);
  assert.deepEqual(imageGenerationSequence('gpt-image-1','responses'),['responses','openai','gemini']);
  assert.match(geminiImageUrl('https://generativelanguage.googleapis.com/v1beta','models/imagen-3.0'),/\/v1beta\/models\/imagen-3\.0:generateContent$/);
  assert.match(geminiImageUrl('https://api.example/v1','gemini-2.5-flash-image'),/https:\/\/api.example\/v1beta\/models\/gemini-2.5-flash-image:generateContent$/);
});

test('imageBytesFromGeneration reads hosted calls and OpenAI b64 payloads',()=>{
  assert.deepEqual(imageBytesFromGeneration([{type:'image_generation_call',result:png.toString('base64')}]),png);
  assert.deepEqual(imageBytesFromGeneration({data:[{b64_json:png.toString('base64')}]}),png);
  assert.equal(imageBytesFromGeneration({data:[{url:'https://example.test/x.png'}]}),undefined);
});

test('chat-protocol image models use /images/generations',async t=>{
  const server=createServer((req,res)=>{assert.equal(req.url,'/v1/images/generations');res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const port=(server.address() as {port:number}).port;
  const model=new ModelClient(()=>({baseUrl:`http://127.0.0.1:${port}/v1`,model:'unused',contextTokens:8000,hasKey:true}),()=>'');
  t.after(()=>model.dispose());
  const bytes=await generateModelImage({model,config:{baseUrl:`http://127.0.0.1:${port}/v1`,model:'flux',protocol:'chat',contextTokens:8000,hasKey:true},key:'',prompt:'a red square',signal:new AbortController().signal});
  assert.deepEqual(bytes,png);
});

test('Responses image models keep using hosted generation bytes',async()=>{
  const model={complete:async()=>({content:'',calls:[],finishReason:'stop',native:{protocol:'responses',key:'k',data:[{type:'image_generation_call',result:png.toString('base64')}]}})} as any;
  const bytes=await generateModelImage({model,config:{baseUrl:'https://api.example/v1',model:'gpt-image',protocol:'responses',contextTokens:32000,hasKey:true},key:'k',prompt:'mark',signal:new AbortController().signal});
  assert.deepEqual(bytes,png);
});

test('a failed guessed protocol falls back and later calls reuse the working one',async t=>{
  const hits={generations:0,gemini:0};
  const server=createServer((req,res)=>{
    if(req.url?.includes('/images/generations')){hits.generations++;res.statusCode=400;res.end('{"error":"unknown field prompt"}');return;}
    hits.gemini++;res.setHeader('content-type','application/json');res.end(JSON.stringify({candidates:[{content:{parts:[{inlineData:{data:png.toString('base64')}}]}}]}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const port=(server.address() as {port:number}).port,baseUrl=`http://127.0.0.1:${port}/v1`,routes=new Map<string,string>();
  const model=new ModelClient(()=>({baseUrl,model:'seedream',contextTokens:8000,hasKey:true}),()=>'');
  t.after(()=>model.dispose());
  const input={model,config:{baseUrl,model:'seedream-'+port,protocol:'chat' as const,contextTokens:8000,hasKey:true},key:'',prompt:'a red square',signal:new AbortController().signal,routes:{get:(key:string)=>routes.get(key) as 'gemini'|'openai'|'responses'|undefined,set:(key:string,kind:'gemini'|'openai'|'responses')=>{routes.set(key,kind);}}};
  assert.deepEqual(await generateModelImage(input),png);
  assert.equal(hits.generations,1);assert.equal(hits.gemini,1);assert.equal([...routes.values()][0],'gemini');
  assert.deepEqual(await generateModelImage(input),png);
  assert.equal(hits.generations,1);assert.equal(hits.gemini,2);
});
