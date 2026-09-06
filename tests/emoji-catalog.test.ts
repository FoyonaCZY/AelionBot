import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {PIN_EMOJI_CATEGORIES,PIN_EMOJI_OPTIONS,PIN_EMOJI_BY_VALUE,QUICK_PIN_EMOJIS,searchPinEmojis} from '../src/emoji-catalog';
import {validPin} from '../src/reactions';
import {Store} from '../electron/core/store';
import {pinChat} from '../electron/core/chat-pins';
import {GroupChats} from '../electron/core/group-chats';

test('the expanded catalog contains distinct single emoji and retains all existing reactions',()=>{
  assert.ok(PIN_EMOJI_OPTIONS.length>=500);assert.equal(PIN_EMOJI_BY_VALUE.size,PIN_EMOJI_OPTIONS.length);
  const segmenter=new Intl.Segmenter('zh',{granularity:'grapheme'});
  for(const category of PIN_EMOJI_CATEGORIES){assert.ok(category.items.length);for(const item of category.items){assert.equal([...segmenter.segment(item.emoji)].length,1,item.emoji);assert.ok(item.label);validPin({messageId:'message',emoji:item.emoji});}}
  for(const emoji of [...QUICK_PIN_EMOJIS,'👀','🙏'])assert.ok(PIN_EMOJI_BY_VALUE.has(emoji));
  for(const emoji of ['hello','<script>','👍👍',''])assert.throws(()=>validPin({messageId:'message',emoji}),/无效/);
});

test('Chinese, English and emoji search work across categories without changing the catalog',()=>{
  assert.ok(searchPinEmojis('咖啡','faces').some(option=>option.emoji==='☕'));
  assert.deepEqual(searchPinEmojis('  ROCKET ').map(option=>option.emoji),['🚀']);
  assert.deepEqual(searchPinEmojis('❤️‍🔥').map(option=>option.emoji),['❤️‍🔥']);
  assert.ok(searchPinEmojis('猫').every(option=>option.keywords.includes('猫')));
  assert.ok(searchPinEmojis('','food').every(option=>PIN_EMOJI_CATEGORIES.find(category=>category.id==='food')!.items.includes(option)));
  assert.deepEqual(searchPinEmojis('没有这个搜索结果'),[]);
});

test('new human and Bot reactions persist in direct and group chats, and toggle independently',t=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-emoji-')),store=new Store(dir),a=store.data.bots[0],b=store.createBot('核对伙伴','核对');
  const groups=new GroupChats(store,{isRunning:()=>false,run:async()=>{},cancel:()=>{}},()=>{});
  t.after(()=>{groups.dispose();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  const target=store.message(a.id,'user','核对完成'),human={kind:'user' as const,id:'user',name:'你'},bot={kind:'bot' as const,id:a.id,name:a.name,color:a.color};
  pinChat(store,a.id,human,{messageId:target.id,emoji:'🚀'});pinChat(store,a.id,bot,{messageId:target.id,emoji:'🚀'});pinChat(store,a.id,human,{messageId:target.id,emoji:'❤️‍🔥'});
  pinChat(store,a.id,human,{messageId:target.id,emoji:'🚀',remove:true});assert.deepEqual(target.pins?.map(pin=>[pin.actor.id,pin.emoji]),[[a.id,'🚀'],['user','❤️‍🔥']]);
  const room=groups.create({name:'表情测试',botIds:[a.id,b.id]});groups.send({id:room.id,message:'喝杯咖啡'});const message=groups.read({id:room.id}).messages.at(-1)!;groups.pinUser({groupId:room.id,messageId:message.id,emoji:'☕'});
  store.save();const restored=new Store(dir);assert.deepEqual(restored.data.messages.find(item=>item.id===target.id)?.pins,target.pins);assert.equal(restored.data.groups[0].messages.find(item=>item.id===message.id)?.pins?.[0].emoji,'☕');
});
