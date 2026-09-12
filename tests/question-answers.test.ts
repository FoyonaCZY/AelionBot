import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../electron/core/store';
import {QUESTION_ANSWER_PREFIX,questionAnswerData,legacyQuestionAnswerData,questionAnswerText,questionToolMessage,readableQuestionAnswer} from '../src/question-answers';
import {readableContent} from '../src/activity';

const answer={id:'question-fixture',status:'answered',questions:[{id:'next',title:'现在要哪一步？',options:['重建','暂停']}],answers:{next:'Rust 迁移先停，仓库保持现状'}};
test('legacy question replies render just the answer without protocol data',()=>{
  const raw=QUESTION_ANSWER_PREFIX+JSON.stringify(answer);
  assert.equal(readableQuestionAnswer(raw),answer.answers.next);
  assert.equal(readableContent(raw),answer.answers.next);
  assert.equal(questionAnswerText(answer),answer.answers.next);
});
test('multiple replies stay paired with questions in question order and preserve custom text',()=>{
  const value={...answer,questions:[{id:'a',title:'目标平台？'},{id:'b',title:'其他要求？'}],answers:{b:'第一行\n第二行 <think>字面文本</think>',a:'Windows'}};
  const expected='目标平台？\nWindows\n\n其他要求？\n第一行\n第二行 <think>字面文本</think>';
  assert.equal(questionAnswerText(value),expected);assert.equal(readableContent(QUESTION_ANSWER_PREFIX+JSON.stringify(value)),expected);
});
test('ordinary JSON and incomplete legacy data are never silently removed or reformatted',()=>{
  for(const raw of [JSON.stringify(answer),QUESTION_ANSWER_PREFIX+'{invalid',QUESTION_ANSWER_PREFIX+JSON.stringify({...answer,status:'waiting'}),QUESTION_ANSWER_PREFIX+JSON.stringify({...answer,answers:{wrong:'x'}}),QUESTION_ANSWER_PREFIX+JSON.stringify({...answer,questions:[...answer.questions,...answer.questions]}),'普通用户输入'])assert.equal(readableQuestionAnswer(raw),raw);
});

test('structured messages retain the question even for one short answer',()=>{
  const data=questionAnswerData(answer);
  assert.deepEqual(data,{requestId:answer.id,items:[{id:'next',title:'现在要哪一步？',answer:'Rust 迁移先停，仓库保持现状'}]});
  assert.deepEqual(legacyQuestionAnswerData(QUESTION_ANSWER_PREFIX+JSON.stringify(answer)),data);
  assert.equal(legacyQuestionAnswerData('目标平台？\nWindows'),undefined);
  assert.equal(legacyQuestionAnswerData(JSON.stringify(answer)),undefined);
});

test('answer structure preserves multiple lines and literal markup without mutating input',()=>{
  const value={...answer,questions:[{id:'a',title:'目标平台？'},{id:'b',title:'其他要求？'}],answers:{b:'保留当前目录\n先给我看计划\n<img src=x onerror=alert(1)>',a:'Windows'}};
  const original=structuredClone(value),data=questionAnswerData(value)!;
  assert.deepEqual(data.items.map(item=>item.id),['a','b']);
  assert.equal(data.items[1].answer,value.answers.b);assert.deepEqual(value,original);
  assert.equal(questionAnswerData({...value,answers:{a:'Windows'}}),undefined);
});

test('a submitted answer is stored after the question, not after later tool work',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-question-place-'));
  try{
    const store=new Store(dir),bot=store.data.bots[0],runId='run-1';
    store.data.runs.push({id:runId,botId:bot.id,status:'running',startedAt:new Date().toISOString(),modelCalls:1,toolCalls:1});
    store.message(bot.id,'user','先做哪一项？');
    const question=store.message(bot.id,'tool',JSON.stringify({result:{id:answer.id,status:'waiting'}}),{tool:'request_user_input',runId,status:'done'});
    store.message(bot.id,'tool','{}',{tool:'host_search_files',runId,status:'done'});
    const placed=questionToolMessage(store.data.messages,bot.id,answer.id);
    assert.equal(placed?.id,question.id);
    const reply=store.message(bot.id,'user','全部',{runId,questionAnswer:questionAnswerData({...answer,answers:{next:'全部'}}),afterId:placed?.id});
    assert.deepEqual(store.data.messages.map(message=>message.id).slice(-3),[question.id,reply.id,store.data.messages.at(-1)!.id]);
    assert.equal(store.data.messages.at(-1)?.tool,'host_search_files');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
