import test from 'node:test';import assert from 'node:assert/strict';import {designFailureText,designConversationMessages,designMessageTimeline} from '../src/designer-feedback';
test('legacy duplicated failures are hidden while the user request and valid answers remain',()=>{
 const error='The operation was aborted due to timeout',base={botId:'bot',runId:'run',designSessionId:'task',time:'now'},messages=[{...base,id:'user',role:'user',content:error},{...base,id:'error',role:'assistant',status:'failed',presentation:'error',content:error},{...base,id:'event',role:'event',content:error},{...base,id:'answer',role:'assistant',presentation:'answer',content:'A useful answer'}] as any;
 assert.deepEqual(designConversationMessages(messages,[{id:'run',botId:'bot',designSessionId:'task',error}] as any,'bot','task',['run']).map(m=>m.id),['user','answer']);assert.equal(designFailureText(error).title,'模型响应超时');assert.equal(designFailureText(error,true).title,'Model response timed out');assert.equal(designFailureText('工作电脑尚未就绪，请启动电脑后继续。').title,'工作电脑尚未就绪');
});

test('stream completion retains progress prose in the same message slot',()=>{
 const base={id:'message',botId:'bot',runId:'run',designSessionId:'task',time:'now',role:'assistant'},text='正在创建页面。';
 const pending={...base,status:'running',content:''} as any,stream={id:base.id,botId:base.botId,runId:base.runId,time:'now',content:text,main:true} as any;
 const before=designMessageTimeline(designConversationMessages([pending],[],'bot','task',['run']),[stream]);
 const after=designMessageTimeline(designConversationMessages([{...pending,status:'done',presentation:'progress',content:text}],[],'bot','task',['run']),[]);
 assert.equal(before.length,1);assert.equal(after.length,1);assert.equal(before[0].message.id,after[0].message.id);assert.equal(after[0].message.content,text);assert.equal(before[0].streaming,true);assert.equal(after[0].streaming,false);
});
test('empty tool-only replies remain hidden while completed progress history stays readable',()=>{
 const base={botId:'bot',runId:'run',designSessionId:'task',time:'now',role:'assistant',status:'done',presentation:'progress'},messages=Array.from({length:35},(_,i)=>({...base,id:String(i),content:'Progress '+i})) as any;
 const visible=designConversationMessages([...messages,{...base,id:'empty',content:''},{...base,id:'hidden',content:'<think>private</think>'}],[],'bot','task',['run']);
 assert.equal(visible.length,35);assert.equal(visible[0].id,'0');
});
