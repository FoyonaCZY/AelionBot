import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../electron/core/store';
import {CognitiveStore} from '../electron/core/cognitive-store';

test('history search finds two-character Chinese terms and ranks messages containing more terms first',t=>{
 const dir=mkdtempSync(join(tmpdir(),'aelion-history-search-')),store=new Store(dir),storage=new CognitiveStore(store),bot=store.data.bots[0];
 t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true});});
 store.message(bot.id,'user','上次压缩失败是因为摘要超长');store.message(bot.id,'assistant','这次只是压缩了图片');store.message(bot.id,'assistant','部署失败，端口被占用');store.message(bot.id,'assistant','无关的记录');
 const both=storage.search(bot.id,'压缩 失败');
 assert.equal(both[0].excerpt,'上次压缩失败是因为摘要超长');assert.equal(both.length,3);
 assert.deepEqual(storage.search(bot.id,'端口').map(hit=>hit.excerpt),['部署失败，端口被占用']);
 // Longer terms still use the trigram index, alone or mixed with short ones.
 assert.equal(storage.search(bot.id,'摘要超长')[0].excerpt,'上次压缩失败是因为摘要超长');
 assert.equal(storage.search(bot.id,'端口被占用 图片').length,2);
 assert.equal(storage.search(bot.id,'不存在').length,0);
});
