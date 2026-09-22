import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGameAction} from '../electron/core/games/model-player';
import type {GameRequest} from '../src/game-types';
const r=(kind:GameRequest['kind']):GameRequest=>({id:'r',seatId:'a',kind,targets:['b'],witch:{canSave:false,canPoison:true}});
const parse=(kind:GameRequest['kind'],a:unknown)=>parseGameAction(JSON.stringify(a),kind,r(kind));
test('per-action contracts reject unrelated fields and enforce actual legal targets',()=>{
 assert.equal(parse('sheriff_join',{choice:true}).choice,true);assert.throws(()=>parse('sheriff_join',{direction:'clockwise'}));
 assert.equal(parse('sheriff_order',{choice:'counterclockwise'}).direction,'counterclockwise');
 assert.throws(()=>parse('vote',{target:'not-visible'}));assert.throws(()=>parse('vote',{target:'b',skip:true}));assert.equal(parse('vote',{skip:true}).skip,true);
 assert.throws(()=>parse('speak',{text:'x'.repeat(801)}));assert.throws(()=>parse('speak',{text:'   '}));assert.throws(()=>parse('speak',{text:'a',note:'x'.repeat(501)}));
 assert.equal(parse('witch',{potion:'poison',target:'b'}).target,'b');assert.throws(()=>parse('witch',{potion:'save'}));assert.throws(()=>parse('witch',{potion:'skip',target:'b'}));
});
