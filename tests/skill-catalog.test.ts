import test from 'node:test';
import assert from 'node:assert/strict';
import type {Skill} from '../src/shared';
import {skillCatalog} from '../electron/core/skill-catalog';
import {contextBudget,textTokens} from '../electron/core/context-budget';

const skill=(id:string,botId?:string):Skill=>({id,name:`流程 ${id}`,description:'整理资料并核对结果',body:'SKILL_BODY_MUST_NOT_BE_IN_CATALOG',botId,source:{label:'fixture',scope:botId?'private':'user',readonly:!botId,path:'PRIVATE_LOCAL_PATH'}});
const rows=(prompt:string)=>prompt.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
test('catalog exposes own and shared metadata with maintenance scope, without other Bots or skill bodies',()=>{
  const entries=[skill('auto','a'),skill('manual','a'),skill('shared'),skill('other-private','b')];
  const library={list:()=>entries,autoManaged:(_botId:string,id:string)=>id==='auto'};
  const catalog=skillCatalog(library,'a',32000,'background'),listed=rows(catalog.prompt);
  assert.equal(catalog.complete,true);assert.equal(catalog.total,3);
  assert.equal(listed.find(item=>item.id==='auto').canUpdate,true);
  assert.equal(listed.find(item=>item.id==='manual').canUpdate,false);
  assert.equal(listed.find(item=>item.id==='shared').canUpdate,false);
  for(const hidden of ['other-private','SKILL_BODY_MUST_NOT_BE_IN_CATALOG','PRIVATE_LOCAL_PATH'])assert.ok(!catalog.prompt.includes(hidden));
  assert.ok(rows(skillCatalog(library,'a',32000,'read-only').prompt).every(item=>item.canUpdate===false));
});
test('large catalogs retain own skills first and explicitly expose incomplete coverage within budget',()=>{
  const entries=Array.from({length:300},(_,i)=>({...skill(`shared-${i}`),description:'共享资料整理流程与核对规则。'.repeat(100)}));
  entries.push(skill('owned','a'));
  const catalog=skillCatalog({list:()=>entries,autoManaged:()=>true},'a',8000,'background');
  assert.equal(catalog.complete,false);assert.equal(catalog.total,301);assert.ok(catalog.listed<catalog.total);
  assert.equal(rows(catalog.prompt)[0].id,'owned');
  assert.match(catalog.prompt,/未列出不代表不存在/);assert.match(catalog.prompt,/offset=0/);
  assert.ok(textTokens(catalog.prompt)<=Math.max(500,Math.floor(contextBudget(8000).input*.15)));
});
test('an empty catalog still permits the Agent to decide that nothing is worth saving',()=>{
  const catalog=skillCatalog({list:()=>[],autoManaged:()=>false},'a',32000,'background');
  assert.equal(catalog.complete,true);assert.equal(catalog.total,0);assert.match(catalog.prompt,/允许什么都不保存/);
});
