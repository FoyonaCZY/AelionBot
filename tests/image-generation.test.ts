import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {imageBytesFromGeneration,generateModelImage,imageGenerationKind,geminiImageUrl} from '../electron/core/image-generation';
import {ModelClient} from '../electron/core/model';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');

test('image generation routes by model id, not chat reasoning settings',()=>{
  assert.equal(imageGenerationKind('dall-e-3','chat'),'openai');
  assert.equal(imageGenerationKind('gpt-image-1','responses'),'responses');
  assert.equal(imageGenerationKind('gemini-2.5-flash-image','chat'),'gemini');
  assert.equal(imageGenerationKind('imagen-3.0-generate-002','gemini'),'gemini');
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
