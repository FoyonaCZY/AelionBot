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