import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../electron/core/store';
import {Attachments} from '../electron/core/attachments';
import {PreviewFeedbackService} from '../electron/core/preview-feedback';
import {feedbackCaptureRect,previewFeedbackMessage,previewFeedbackDisplay,type PreviewFeedbackInput} from '../src/preview-feedback';
import type {AttachmentScope} from '../src/attachment-types';
const request=(scope:AttachmentScope):PreviewFeedbackInput=>({requestId:randomUUID(),scope,text:'把这里的标题缩小一点',file:{name:'report.pdf',page:3},rect:{x:100,y:40,width:600,height:400},viewport:{width:1200,height:800}});
function fixture(t:test.TestContext){const dir=mkdtempSync(join(tmpdir(),'aelion-preview-feedback-')),store=new Store(dir),bot=store.data.bots[0],attachments=new Attachments(store),scope={kind:'bot' as const,id:bot.id},sent:Array<{scope:AttachmentScope;text:string;id:string}>=[];let captures=0,failCapture=false,failSend=false,throwAfter=false;
 t.after(()=>{store.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
 const service=new PreviewFeedbackService({validate:s=>attachments.scope(s),capture:async()=>{captures++;if(failCapture)throw Error('capture failed');return Buffer.from('captured pixels '+captures);},attach:(s,name,bytes)=>attachments.importFiles(s,[{name,bytes}])[0],discard:(s,id)=>attachments.discardUnsentDraft(s,id),send:(s,text,id,previewPrompt)=>{if(failSend)throw Error('send failed');const [file]=attachments.forDraft(s,[id]);if(s.kind==='bot')store.message(s.id,'user',text,{attachments:[file],previewPrompt});sent.push({scope:s,text,id});if(throwAfter)throw Error('late notification failure');},delivered:(s,id)=>sent.some(row=>row.scope.id===s.id&&row.scope.kind===s.kind&&row.id===id)});
 return {store,attachments,scope,service,sent,captures:()=>captures,failCapture:(v:boolean)=>failCapture=v,failSend:(v:boolean)=>failSend=v,throwAfter:(v:boolean)=>throwAfter=v};}
test('capture crop tracks the visible rectangle across display and application scaling',()=>{
 const input=request({kind:'bot',id:'a'});assert.deepEqual(feedbackCaptureRect(input.rect,input.viewport,{width:2400,height:1600}),{x:200,y:80,width:1200,height:800});
 assert.deepEqual(feedbackCaptureRect({x:10.2,y:20.4,width:500.6,height:300.4},{width:1000,height:800},{width:1250,height:1000}),{x:13,y:26,width:625,height:375});
});
test('invalid, empty, out-of-window and resized captures are rejected instead of sending a whole-window screenshot',()=>{
 const viewport={width:1200,height:800},image={width:1200,height:800};for(const rect of [{x:-1,y:0,width:100,height:100},{x:0,y:0,width:0,height:100},{x:1100,y:0,width:300,height:100},{x:NaN,y:0,width:100,height:100}])assert.throws(()=>feedbackCaptureRect(rect,viewport,image));
 assert.throws(()=>feedbackCaptureRect({x:0,y:0,width:100,height:100},viewport,{width:1600,height:800}),/变化/);
});
test('feedback supplies source file, current page and unsaved-view context without changing the user request',()=>{
 const message=previewFeedbackMessage({text:'  缩小标题  ',file:{name:'deck.pptx',path:'/work/bot/deck.pptx',page:4,unsaved:true}});assert.match(message,/缩小标题/);assert.match(message,/deck.pptx/);assert.match(message,/第 4 页/);assert.match(message,/未保存/);assert.match(message,/可见范围/);assert.throws(()=>previewFeedbackMessage({text:' ',file:{name:'x'}}));
});
test('one feedback submission captures and sends once even when the request is repeated',async t=>{
 const f=fixture(t),input=request(f.scope);const [a,b]=await Promise.all([f.service.send(input),f.service.send(input)]);assert.equal(a.attachmentId,b.attachmentId);await f.service.send(input);assert.equal(f.captures(),1);assert.equal(f.sent.length,1);assert.equal(f.store.data.messages.at(-1)?.attachments?.[0].id,a.attachmentId);assert.equal(f.attachments.forDraft(f.scope,[a.attachmentId]).length,1);assert.throws(()=>f.attachments.discardUnsentDraft(f.scope,a.attachmentId),/已发送/);
});
test('failed capture sends nothing; failed send removes the unused image and retry captures the current view',async t=>{
 const f=fixture(t),input=request(f.scope);f.failCapture(true);await assert.rejects(f.service.send(input),/capture failed/);assert.equal(f.store.data.attachments.length,0);
 f.failCapture(false);f.failSend(true);await assert.rejects(f.service.send(input),/send failed/);assert.equal(f.store.data.attachments.length,0);assert.equal(f.sent.length,0);
 f.failSend(false);await f.service.send(input);assert.equal(f.captures(),3);assert.equal(f.sent.length,1);assert.match(f.attachments.bytes(f.sent[0].id).toString(),/3$/);
});
test('an error after message submission is acknowledged without sending a duplicate',async t=>{
 const f=fixture(t),input=request(f.scope);f.throwAfter(true);const result=await f.service.send(input);assert.equal(result.sent,true);await f.service.send(input);assert.equal(f.sent.length,1);
});
test('group feedback stays in its original scope and request IDs cannot be reused for another recipient',async t=>{
 const f=fixture(t),id=randomUUID();f.store.data.groups.push({id,members:[],messages:[]} as any);const input=request({kind:'group',id});const result=await f.service.send(input);assert.deepEqual(f.sent[0].scope,{kind:'group',id});assert.equal(f.attachments.forDraft({kind:'group',id},[result.attachmentId]).length,1);assert.throws(()=>f.attachments.forDraft(f.scope,[result.attachmentId]));await assert.rejects(f.service.send({...input,scope:f.scope}),/变化/);
});
test('feedback bubbles show only the prompt while the original content keeps file context',async t=>{
 const f=fixture(t),input=request(f.scope);await f.service.send(input);const message=f.store.data.messages.at(-1)!;
 assert.equal(message.previewPrompt,input.text);assert.equal(previewFeedbackDisplay(message).content,input.text);
 assert.match(message.content,/report.pdf/);assert.match(message.content,/可见范围/);assert.equal(message.attachments?.length,1);
});
test('legacy feedback display removes generated metadata in Chinese and English, preserving multiline user text',()=>{
 const attachments=[{name:'preview-1234abcd.png',mime:'image/png'}],prompt='这里的表达有点奇怪\n\n文件：这一行是我的意见，不应删除';
 for(const language of ['zh-CN','zh-TW','en'] as const){const content=previewFeedbackMessage({text:prompt,file:{name:'demo.html',attachmentId:'c60f1d42-9e52-432b-84a2-f39644767f10',page:2,unsaved:true},language});assert.equal(previewFeedbackDisplay({role:'user',content,attachments}).content,prompt);assert.equal(previewFeedbackDisplay({sender:{kind:'user'},content,attachments}).content,prompt);assert.equal(previewFeedbackDisplay({role:'assistant',content,attachments}).content,content);}
 const ordinary='预览：demo.html\n用户自己写的说明';assert.equal(previewFeedbackDisplay({content:ordinary,attachments}).content,ordinary);
 const content=previewFeedbackMessage({text:'我的文字',file:{name:'test.png'}});assert.equal(previewFeedbackDisplay({content,attachments:[]}).content,content);
 assert.equal(previewFeedbackDisplay({content,attachments}).content,'我的文字');
});
test('feedback mention offsets remain aligned after the preview header is hidden',()=>{
 const prompt='@写作伙伴 请修改',content=previewFeedbackMessage({text:prompt,file:{name:'report.pdf'}}),start=content.indexOf(prompt);
 const message={content,previewPrompt:prompt,mentions:[{id:'bot',name:'写作伙伴',color:'#999',start,end:start+5}]};
 assert.equal(previewFeedbackDisplay(message).mentions?.[0].start,0);assert.equal(previewFeedbackDisplay(message).mentions?.[0].end,5);
});
test('feedback carries annotations and a complete edit manifest while retaining ordinary attachments and reply metadata',async()=>{
 const scope={kind:'bot' as const,id:'bot'},created=new Map<string,{name:string;bytes:Buffer}>(),sent:any[]=[];let serial=0;
 const service=new PreviewFeedbackService({validate:()=>{},capture:async()=>Buffer.from('png'),attach:(_scope,name,bytes)=>{const id='generated-'+(++serial);created.set(id,{name,bytes});return{id,name,size:bytes.length,mime:name.endsWith('.json')?'application/json':'image/png'};},discard:(_scope,id)=>{created.delete(id);},send:(scope,text,id,prompt,input)=>sent.push({scope,text,id,prompt,input}),delivered:(_scope,id)=>sent.some(row=>row.id===id)});
 const input={...request(scope),attachmentIds:['original'],replyToMessageId:'reply',annotations:[{id:'mark',type:'rect' as const,x:.1,y:.2,w:.3,h:.4,text:'More spacing',color:'#3975c6'}],edits:[{before:{tag:'h1',path:['h1:1'],html:'<h1>Old</h1>'},after:'<h1>New</h1>'}]};
 await service.send(input);await service.send(input);assert.equal(sent.length,1);assert.equal(created.size,2);const manifest=[...created.values()].find(file=>file.name.endsWith('.json'))!;assert.deepEqual(JSON.parse(manifest.bytes.toString()).edits,input.edits);assert.match(sent[0].text,/More spacing/);assert.equal(sent[0].input.replyToMessageId,'reply');assert.ok(sent[0].input.attachmentIds.includes('original'));assert.equal(sent[0].input.attachmentIds.length,2);assert.equal(sent[0].prompt,input.text);
});
test('a failed edit-feedback send cleans up both generated attachments and keeps the original attachment reference',async()=>{
 const removed:string[]=[],created:string[]=[];const service=new PreviewFeedbackService({validate:()=>{},capture:async()=>Buffer.from('png'),attach:(_scope,name,bytes)=>{created.push(name);return{id:name,name,size:bytes.length,mime:'application/octet-stream'};},discard:(_scope,id)=>removed.push(id),send:()=>{throw Error('offline');},delivered:()=>false});
 await assert.rejects(service.send({...request({kind:'bot',id:'bot'}),attachmentIds:['original'],edits:[{before:{tag:'p',path:['p:1'],html:'<p>A</p>'},after:'<p>B</p>'}]}),/offline/);assert.equal(created.length,2);assert.deepEqual(removed.sort(),created.sort());assert.ok(!removed.includes('original'));
});

test('design feedback rejects another task file and parent traversal before attachment capture',async()=>{
 const {designFeedbackFile}=await import('../electron/core/preview-feedback');
 const session={botId:'designer',workspacePath:'designers/designer/task-one'};
 const input={file:{name:'index.html',path:'/work/designer/designers/designer/task-one/index.html'}} as any;
 assert.equal(designFeedbackFile(input,session),'designers/designer/task-one/index.html');
 for(const path of ['/work/other/designers/designer/task-one/index.html','/work/designer/designers/designer/task-two/index.html','/work/designer/designers/designer/task-one/../task-two/index.html'])assert.throws(()=>designFeedbackFile({...input,file:{...input.file,path}},session),/当前设计任务/);
 assert.equal(designFeedbackFile({...input,file:{name:'Blank canvas'}},session),undefined);
});

test('feedback describes the scrolled canvas independently from screenshot pixel coordinates',()=>{
 const input={text:'Change this card',file:{name:'index.html'},language:'en',view:{width:900,height:600,scrollX:0,scrollY:740,documentWidth:900,documentHeight:2400},annotations:[{id:'region',type:'rect',x:.1,y:.35,w:.2,h:.1,sourceWidth:900,sourceHeight:2400,color:'#3975c6'}]} as const;
 const content=previewFeedbackMessage({...input,annotations:[...input.annotations]});
 assert.match(content,/document 900×2400/);assert.match(content,/scroll 0,740/);assert.match(content,/2400/);
 assert.throws(()=>previewFeedbackMessage({...input,annotations:[],view:{...input.view,width:NaN}}),/坐标信息/);
});
