import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {Store} from '../electron/core/store';
import {ModelProviders} from '../electron/core/model-providers';
import {updateBotProfile} from '../electron/core/bot-profile';
import {validateChatInput} from '../electron/core/chat-input';
import {GroupChats} from '../electron/core/group-chats';
import {BOT_PALETTES,botIdentity,botPaletteKey,normalizeBotPalette,randomBotPalette,type BotAvatarStyle} from '../src/bot-colors';
import {BOT_AVATAR_PATH,botAvatarContent,botAvatarDataUrl} from '../src/bot-avatar';

function fixture(t:test.TestContext){
  const parent=resolve(tmpdir()),dir=mkdtempSync(join(parent,'aelion-palette-')),store=new Store(dir);
  const providers=new ModelProviders(store,{encrypt:value=>value,decrypt:value=>value});
  t.after(()=>{providers.dispose();store.close();assert.equal(dirname(resolve(dir)),parent);assert.ok(basename(dir).startsWith('aelion-palette-'));rmSync(dir,{recursive:true,force:true});});
  return {dir,store,providers};
}

test('preset and custom palettes survive creation and restart, while legacy colors stay unchanged',t=>{
  const {store,dir}=fixture(t),legacy=store.data.bots[0],original=structuredClone(legacy);
  const created=BOT_PALETTES.map(palette=>store.createBot(palette.name,'palette fixture',palette.color,palette.avatarStyle));
  const custom=store.createBot('Custom','custom colors','#123AbC',{kind:'gradient',secondary:'#ABCDEF',direction:'vertical'});
  const loaded=new Store(dir);t.after(()=>loaded.close());
  assert.deepEqual(loaded.bot(legacy.id),original);
  for(let i=0;i<created.length;i++)assert.equal(botPaletteKey(loaded.bot(created[i].id)),botPaletteKey(BOT_PALETTES[i]));
  assert.equal(loaded.bot(custom.id).color,'#123abc');assert.deepEqual(loaded.bot(custom.id).avatarStyle,{kind:'gradient',secondary:'#abcdef',direction:'vertical'});
});

test('editing colors preserves the model, supports custom split colors, and can return to solid',t=>{
  const {store,providers,dir}=fixture(t),bot=store.data.bots[0],provider=providers.save({name:'Example',baseUrl:'https://example.invalid/v1'});
  providers.setBot(bot.id,{providerId:provider.id,model:'fixture-model',contextTokens:32000});
  const model=structuredClone(store.bot(bot.id).model),style:BotAvatarStyle={kind:'split',secondary:'#879AAA',pattern:'wave'};
  assert.equal(updateBotProfile(store,providers,{id:bot.id,name:bot.name,role:bot.role,color:'#7356BC',avatarStyle:style},()=>{throw Error('Color changes must not switch models');}),false);
  style.secondary='#000000';
  assert.deepEqual(store.bot(bot.id).avatarStyle,{kind:'split',secondary:'#879aaa',pattern:'wave'});assert.deepEqual(store.bot(bot.id).model,model);
  updateBotProfile(store,providers,{id:bot.id,name:bot.name,role:bot.role+' edited'});
  assert.equal(store.bot(bot.id).avatarStyle?.kind,'split');
  updateBotProfile(store,providers,{id:bot.id,name:bot.name,role:bot.role,color:'#334455',avatarStyle:null});
  const loaded=new Store(dir);t.after(()=>loaded.close());assert.equal(loaded.bot(bot.id).avatarStyle,undefined);assert.equal(loaded.bot(bot.id).color,'#334455');assert.deepEqual(loaded.bot(bot.id).model,model);
});

test('incremental desktop storage retains custom colors across restarts',t=>{
  const {dir}=fixture(t),store=new Store(dir,{incremental:true});
  const bot=store.createBot('SQLite palette','persistent','#6482aa',{kind:'split',secondary:'#bc879b',pattern:'diagonal'});
  store.close();
  const restored=new Store(dir,{incremental:true});
  assert.equal(restored.bot(bot.id).color,'#6482aa');assert.deepEqual(restored.bot(bot.id).avatarStyle,{kind:'split',secondary:'#bc879b',pattern:'diagonal'});
  restored.close();
});

test('invalid colors or paint metadata never partially change a profile or create a Bot',t=>{
  const {store,providers}=fixture(t),bot=store.data.bots[0],before=readFileSync(store.file,'utf8'),memory=JSON.stringify(store.data);
  const invalid=[{color:null as any},{color:'url(https://example.invalid/image)'},{color:'#123'},{color:'#ffffff',avatarStyle:{kind:'gradient',secondary:'red',direction:'vertical'}},{color:'#ffffff',avatarStyle:{kind:'gradient',secondary:'#123456',direction:'anything'}},{color:'#ffffff',avatarStyle:{kind:'split',secondary:'#123456',pattern:'__proto__'}}];
  for(const palette of invalid){
    assert.throws(()=>store.createBot('Must not exist','invalid',palette.color,palette.avatarStyle as BotAvatarStyle));
    assert.throws(()=>updateBotProfile(store,providers,{id:bot.id,name:'Must not change',role:'invalid',...palette} as any));
    assert.equal(JSON.stringify(store.data),memory);assert.equal(readFileSync(store.file,'utf8'),before);
  }
});

test('busy model rejection also leaves edited colors and the name untouched',t=>{
  const {store,providers}=fixture(t),bot=store.data.bots[0],provider=providers.save({name:'Example',baseUrl:'https://example.invalid/v1'}),before=readFileSync(store.file,'utf8');
  assert.throws(()=>updateBotProfile(store,providers,{id:bot.id,name:'Changed',role:bot.role,color:'#556677',avatarStyle:{kind:'gradient',secondary:'#998877',direction:'diagonal'},model:{providerId:provider.id,model:'new',contextTokens:32000}},()=>{throw Error('busy');}),/busy/);
  assert.equal(readFileSync(store.file,'utf8'),before);
});

test('mentions and group summaries use the live palette and clear stale split metadata',t=>{
  const {store,providers}=fixture(t),from=store.data.bots[0],to=store.createBot('Palette Bot','receiver','#667788',{kind:'split',secondary:'#aabbcc',pattern:'arc'});
  const text='@Palette Bot',mention={...botIdentity(to),start:0,end:text.length};
  const validated=validateChatInput(store,from.id,text,[{...mention,color:'#000000',avatarStyle:{kind:'split',secondary:'#000000',pattern:'blocks'}}]);
  assert.deepEqual(validated[0].avatarStyle,to.avatarStyle);assert.equal(validated[0].color,to.color);
  const groups=new GroupChats(store,{isRunning:()=>false,run:async()=>{},cancel:()=>{}},()=>{});
  const room=groups.create({name:'Palette room',botIds:[from.id,to.id]});
  assert.equal(groups.snapshot().rooms.find(item=>item.id===room.id)?.members.find(item=>item.id===to.id)?.avatarStyle?.kind,'split');
  updateBotProfile(store,providers,{id:to.id,name:to.name,role:to.role,color:'#556677',avatarStyle:null});
  assert.equal(groups.snapshot().rooms.find(item=>item.id===room.id)?.members.find(item=>item.id===to.id)?.avatarStyle,undefined);
  assert.equal(validateChatInput(store,from.id,text,[mention])[0].avatarStyle,undefined);
});

test('avatar SVG keeps the original silhouette, supports all paints, and rejects external content',()=>{
  for(const palette of BOT_PALETTES){const svg=botAvatarContent(palette,'instance');assert.ok(svg.includes(BOT_AVATAR_PATH));assert.ok(svg.includes('avatar-eye'));if(palette.avatarStyle?.kind==='gradient')assert.ok(svg.includes('<linearGradient'));if(palette.avatarStyle?.kind==='split')assert.ok(svg.includes('clip-path='));assert.match(botAvatarDataUrl(palette),/^data:image\/svg\+xml,/);}
  const unsafe=botAvatarContent({color:'url(https://example.invalid)'},'\"><script>bad</script>');assert.ok(unsafe.includes('#8b6bea'));assert.doesNotMatch(unsafe,/<script|https:|onload=/);
  const previous=normalizeBotPalette(BOT_PALETTES[0]),before=JSON.stringify(BOT_PALETTES);
  for(let i=0;i<40;i++)assert.notEqual(botPaletteKey(randomBotPalette(previous)),botPaletteKey(previous));
  const copy=normalizeBotPalette(BOT_PALETTES.find(item=>item.avatarStyle)!);copy.avatarStyle!.secondary='#000000';assert.equal(JSON.stringify(BOT_PALETTES),before);
});
