import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {generateModelImage,imageBytesFromGeneration,imageExtension,imageMediaType,migrateImageRoute,probeImageModel} from '../electron/core/image-generation';
import {autoProtocolOrder,geminiImageUrl,imageAdapter,imageProtocolCatalog,openAiSize} from '../electron/core/image-protocols';
import {ImageGenerationError,classifyImageResponse,classifyImageTransport,scrubImageDetail} from '../electron/core/image-errors';
import {aspectDimensions,IMAGE_NEXT_STEPS,probesNextProtocol} from '../src/image-types';
import {ModelClient} from '../electron/core/model';
import type {ImageProtocol} from '../src/image-types';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0]);
const signal=()=>new AbortController().signal;
const routeStore=()=>{const map=new Map<string,ImageProtocol>();return {map,routes:{get:(key:string)=>map.get(key),set:(key:string,protocol:ImageProtocol)=>{map.set(key,protocol);}}};};
async function listen(handler:Parameters<typeof createServer>[1],after:(fn:()=>void)=>void){
  const server=createServer(handler);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  after(()=>{server.closeAllConnections();server.close();});
  return `http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
}
const client=(baseUrl:string,after:(fn:()=>void)=>void)=>{
  const model=new ModelClient(()=>({baseUrl,model:'unused',contextTokens:8000,hasKey:true}),()=>'');
  after(()=>model.dispose());return model;
};

test('the protocol catalog stays declarative and every adapter is reachable',()=>{
  const catalog=imageProtocolCatalog();
  assert.equal(catalog[0].id,'auto');
  for(const info of catalog.slice(1)){
    if(info.id==='auto') throw new Error('auto 只能是目录第一项');
    const adapter=imageAdapter(info.id);
    assert.equal(adapter.id,info.id);
    assert.ok(adapter.label&&adapter.hint,`${info.id} 需要说明文案`);
  }
  assert.deepEqual(catalog.map(info=>info.id),['auto','openai-images','gemini-images','responses-images','sd-webui']);
  assert.equal(imageAdapter('gemini-images').capabilities.reference,true);
  assert.equal(imageAdapter('responses-images').capabilities.reference,false);
  assert.equal(imageAdapter('sd-webui').capabilities.negativePrompt,true);
});

test('auto probing prefers the configured chat protocol and never offers hosted generation off Responses',()=>{
  assert.deepEqual(autoProtocolOrder('dall-e-3','chat'),['openai-images','gemini-images']);
  assert.deepEqual(autoProtocolOrder('gemini-2.5-flash-image','chat'),['gemini-images','openai-images']);
  assert.deepEqual(autoProtocolOrder('imagen-3.0-generate-002','gemini'),['gemini-images','openai-images']);
  assert.deepEqual(autoProtocolOrder('gpt-image-1','responses'),['responses-images','openai-images','gemini-images']);
  // A remembered route wins the first slot without dropping the rest of the probe order.
  assert.deepEqual(autoProtocolOrder('gemini-2.5-flash-image','chat','openai-images'),['openai-images','gemini-images']);
  assert.ok(!autoProtocolOrder('gpt-image-1','chat').includes('responses-images'));
});

test('aspect ratios map to real dimensions and to each provider size menu',()=>{
  assert.deepEqual(aspectDimensions('4:3'),{width:1152,height:864});
  assert.equal(1152/864,4/3);
  assert.deepEqual(aspectDimensions('1:1'),{width:1024,height:1024});
  assert.equal(openAiSize('dall-e-3','16:9'),'1792x1024');
  assert.equal(openAiSize('dall-e-3','9:16'),'1024x1792');
  assert.equal(openAiSize('gpt-image-1','16:9'),'1536x1024');
  assert.equal(openAiSize('gpt-image-1','1:1'),'1024x1024');
  assert.equal(openAiSize('flux-pro','3:2'),'1216x832');
  assert.equal(openAiSize('flux-pro',undefined),undefined);
  assert.match(geminiImageUrl('https://generativelanguage.googleapis.com/v1beta','models/imagen-3.0'),/\/v1beta\/models\/imagen-3\.0:generateContent$/);
  assert.match(geminiImageUrl('https://api.example/v1','gemini-2.5-flash-image'),/https:\/\/api\.example\/v1beta\/models\/gemini-2\.5-flash-image:generateContent$/);
});

test('adapters build the request each provider actually documents',()=>{
  const job={prompt:'a red square',aspect:'16:9' as const,quality:'high' as const};
  const openai=imageAdapter('openai-images').plan(job,{baseUrl:'https://api.example/v1',model:'gpt-image-1'},'k');
  assert.equal(openai.kind,'http');
  if(openai.kind!=='http')throw new Error('unreachable');
  assert.equal(openai.url,'https://api.example/v1/images/generations');
  const body=JSON.parse(openai.body as string);
  assert.equal(body.size,'1536x1024');
  assert.equal(body.quality,'high');
  // gpt-image-* rejects response_format; the older families require it.
  assert.equal(body.response_format,undefined);
  const legacy=imageAdapter('openai-images').plan(job,{baseUrl:'https://api.example/v1',model:'dall-e-3'},'k');
  if(legacy.kind!=='http')throw new Error('unreachable');
  assert.equal(JSON.parse(legacy.body as string).response_format,'b64_json');
  assert.equal(JSON.parse(legacy.body as string).quality,'hd');

  const gemini=imageAdapter('gemini-images').plan(job,{baseUrl:'https://api.example/v1',model:'gemini-2.5-flash-image'},'k');
  if(gemini.kind!=='http')throw new Error('unreachable');
  assert.equal(JSON.parse(gemini.body as string).generationConfig.imageConfig.aspectRatio,'16:9');
  assert.equal(gemini.headers['x-goog-api-key'],'k');

  const webui=imageAdapter('sd-webui').plan({...job,negativePrompt:'blurry',seed:7},{baseUrl:'http://127.0.0.1:7860/v1',model:'sdxl'},'');
  if(webui.kind!=='http')throw new Error('unreachable');
  assert.equal(webui.url,'http://127.0.0.1:7860/sdapi/v1/txt2img');
  const sd=JSON.parse(webui.body as string);
  assert.equal(sd.width,1344);assert.equal(sd.height,768);
  assert.equal(sd.negative_prompt,'blurry');assert.equal(sd.seed,7);

  const hosted=imageAdapter('responses-images').plan(job,{baseUrl:'https://api.example/v1',model:'gpt-image-1'},'k');
  assert.equal(hosted.kind,'hosted');
  if(hosted.kind!=='hosted')throw new Error('unreachable');
  assert.equal(hosted.size,'1536x1024');
});

test('a reference image switches OpenAI to the edits endpoint and is refused where unsupported',()=>{
  const job={prompt:'restyle',reference:[{bytes:png,mediaType:'image/png',name:'ref.png'}]};
  const plan=imageAdapter('openai-images').plan(job,{baseUrl:'https://api.example/v1',model:'gpt-image-1'},'k');
  if(plan.kind!=='http')throw new Error('unreachable');
  assert.equal(plan.url,'https://api.example/v1/images/edits');
  assert.ok(plan.body instanceof FormData);
  assert.equal(imageAdapter('responses-images').capabilities.reference,false);
});

test('every failure maps to exactly one closed-set next step',()=>{
  assert.equal(classifyImageResponse(401,'',false).nextStep,'open-settings');
  assert.equal(classifyImageResponse(401,'',true).nextStep,'sign-in');
  assert.equal(classifyImageResponse(402,'',true).nextStep,'add-credit');
  assert.equal(classifyImageResponse(429,'rate limit exceeded',true).nextStep,'retry-later');
  assert.equal(classifyImageResponse(429,'insufficient credit balance',true).nextStep,'add-credit');
  assert.equal(classifyImageResponse(400,'content policy violation',true).nextStep,'revise-request');
  assert.equal(classifyImageResponse(400,'input_image failed safety review',true).subject,'reference');
  assert.equal(classifyImageResponse(400,'your prompt was blocked',true).subject,'prompt');
  assert.equal(classifyImageResponse(400,'unknown field prompt',true).nextStep,'switch-model');
  assert.equal(classifyImageResponse(404,'',true).nextStep,'switch-model');
  assert.equal(classifyImageResponse(503,'',true).nextStep,'retry-later');
  assert.equal(classifyImageTransport(new Error('fetch failed')),'retry-later');
  // Only a protocol mismatch justifies spending another request on a different endpoint.
  assert.deepEqual(IMAGE_NEXT_STEPS.filter(probesNextProtocol),['switch-model','unsupported']);
});

test('a failure carries a user sentence, a next step, and agent guidance without leaking credentials',()=>{
  const error=new ImageGenerationError('add-credit',{protocol:'openai-images',status:429,detail:'billing for sk-abcdefghijklmnop exhausted'});
  const result=error.toolResult();
  assert.equal(result.nextStep,'add-credit');
  assert.match(String(result.error),/额度用完/);
  assert.match(String(result.guidance),/不要重试/);
  assert.doesNotMatch(String(result.detail),/sk-abcdefghijklmnop/);
  assert.match(scrubImageDetail('Bearer abcdefghijklmnop'),/\*\*\*/);
  assert.match(scrubImageDetail('key=AIzaSyABCDEFGHIJKL'),/\*\*\*/);
});

test('media type is sniffed from the bytes, not from the requested name',()=>{
  assert.equal(imageMediaType(png),'image/png');
  assert.equal(imageMediaType(jpeg),'image/jpeg');
  assert.equal(imageExtension('image/jpeg'),'jpg');
  assert.equal(imageExtension('image/webp'),'webp');
});

test('legacy remembered routes migrate to the named protocols',()=>{
  assert.equal(migrateImageRoute('openai'),'openai-images');
  assert.equal(migrateImageRoute('gemini'),'gemini-images');
  assert.equal(migrateImageRoute('responses'),'responses-images');
  assert.equal(migrateImageRoute('sd-webui'),'sd-webui');
  assert.equal(migrateImageRoute('auto'),undefined);
  assert.equal(migrateImageRoute('nonsense'),undefined);
});

test('imageBytesFromGeneration still reads hosted calls and plain b64 payloads',()=>{
  assert.deepEqual(imageBytesFromGeneration([{type:'image_generation_call',result:png.toString('base64')}]),png);
  assert.deepEqual(imageBytesFromGeneration({data:[{b64_json:png.toString('base64')}]}),png);
  assert.equal(imageBytesFromGeneration({data:[{url:'https://example.test/x.png'}]}),undefined);
});

test('an explicitly configured protocol posts once, with the requested aspect',async t=>{
  let calls=0,seen:any;
  const baseUrl=await listen((req,res)=>{calls++;let body='';req.on('data',c=>body+=c);req.on('end',()=>{seen=JSON.parse(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));});},fn=>t.after(fn));
  const result=await generateModelImage({model:client(baseUrl,fn=>t.after(fn)),config:{baseUrl,model:'flux',protocol:'chat',imageProtocol:'openai-images',contextTokens:8000,hasKey:true},key:'',job:{prompt:'a red square',aspect:'16:9'},signal:signal()});
  assert.deepEqual(result.bytes,png);
  assert.equal(result.protocol,'openai-images');
  assert.equal(result.mediaType,'image/png');
  assert.equal(calls,1);
  assert.equal(seen.size,'1344x768');
});

test('Responses providers keep using hosted generation bytes and forward the size',async()=>{
  let forwarded:any;
  const model={complete:async(_m:unknown,_t:unknown,_s:unknown,_o:unknown,options:any)=>{forwarded=options.config;return {content:'',calls:[],finishReason:'stop',native:{protocol:'responses',key:'k',data:[{type:'image_generation_call',result:png.toString('base64')}]}};}} as any;
  const result=await generateModelImage({model,config:{baseUrl:'https://api.example/v1',model:'gpt-image-1',protocol:'responses',imageProtocol:'responses-images',contextTokens:32000,hasKey:true},key:'k',job:{prompt:'mark',aspect:'9:16'},signal:signal()});
  assert.deepEqual(result.bytes,png);
  assert.equal(forwarded.hostedImageSize,'1024x1536');
});

test('auto mode probes past a protocol mismatch and then reuses the working route',async t=>{
  const hits={generations:0,gemini:0};
  const baseUrl=await listen((req,res)=>{
    if(req.url?.includes('/images/generations')){hits.generations++;res.statusCode=400;res.end('{"error":"unknown field prompt"}');return;}
    hits.gemini++;res.setHeader('content-type','application/json');res.end(JSON.stringify({candidates:[{content:{parts:[{inlineData:{data:png.toString('base64')}}]}}]}));
  },fn=>t.after(fn));
  const {map,routes}=routeStore();
  const input={model:client(baseUrl,fn=>t.after(fn)),config:{baseUrl,model:'seedream-'+Date.now(),protocol:'chat' as const,contextTokens:8000,hasKey:true},key:'',job:{prompt:'a red square'},signal:signal(),routes};
  assert.equal((await generateModelImage(input)).protocol,'gemini-images');
  assert.equal(hits.generations,1);assert.equal(hits.gemini,1);
  assert.equal([...map.values()][0],'gemini-images');
  await generateModelImage(input);
  assert.equal(hits.generations,1,'a remembered route must not re-probe the failing endpoint');
  assert.equal(hits.gemini,2);
});

test('auto mode stops at a terminal failure instead of billing the next endpoint',async t=>{
  const hits={generations:0,gemini:0};
  const baseUrl=await listen((req,res)=>{
    if(req.url?.includes('/images/generations')){hits.generations++;res.statusCode=402;res.end('{"error":"insufficient credit"}');return;}
    hits.gemini++;res.setHeader('content-type','application/json');res.end(JSON.stringify({candidates:[{content:{parts:[{inlineData:{data:png.toString('base64')}}]}}]}));
  },fn=>t.after(fn));
  await assert.rejects(
    generateModelImage({model:client(baseUrl,fn=>t.after(fn)),config:{baseUrl,model:'flux',protocol:'chat',contextTokens:8000,hasKey:true},key:'k',job:{prompt:'x'},signal:signal()}),
    (error:unknown)=>{assert.ok(error instanceof ImageGenerationError);assert.equal(error.nextStep,'add-credit');return true;});
  assert.equal(hits.generations,1);
  assert.equal(hits.gemini,0,'a billing failure must not fall through to another provider');
});

test('a raw image response and a URL response both resolve to bytes',async t=>{
  const direct=await listen((_req,res)=>{res.setHeader('content-type','image/png');res.end(png);},fn=>t.after(fn));
  const raw=await generateModelImage({model:client(direct,fn=>t.after(fn)),config:{baseUrl:direct,model:'m',protocol:'chat',imageProtocol:'openai-images',contextTokens:8000,hasKey:true},key:'',job:{prompt:'x'},signal:signal()});
  assert.deepEqual(raw.bytes,png);

  // The generations call answers with a link; the downloader fetches it from the same origin.
  let origin='';
  const linkBase=await listen((req,res)=>{
    if(req.url?.includes('/images/generations')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{url:`${origin}/asset.png`}]}));return;}
    res.setHeader('content-type','image/png');res.end(png);
  },fn=>t.after(fn));
  origin=new URL(linkBase).origin;
  const linked=await generateModelImage({model:client(linkBase,fn=>t.after(fn)),config:{baseUrl:linkBase,model:'m',protocol:'chat',imageProtocol:'openai-images',contextTokens:8000,hasKey:true},key:'',job:{prompt:'x'},signal:signal()});
  assert.deepEqual(linked.bytes,png);
});

test('the settings connection test reports the protocol it actually proved',async t=>{
  const baseUrl=await listen((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({images:[png.toString('base64')]}));},fn=>t.after(fn));
  const probe=await probeImageModel({model:client(baseUrl,fn=>t.after(fn)),config:{baseUrl,model:'sdxl',protocol:'chat',imageProtocol:'sd-webui',contextTokens:8000,hasKey:false},key:'',signal:signal()});
  assert.equal(probe.protocol,'sd-webui');
  assert.equal(probe.mediaType,'image/png');
  assert.equal(probe.bytes,png.length);
});
