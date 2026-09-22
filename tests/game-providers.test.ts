import test from 'node:test';
import assert from 'node:assert/strict';
import {gameProviders} from '../scripts/game-providers';
import {createWerewolf,view} from '../electron/core/games/werewolf';
const registry=()=>gameProviders({baseUrl:'https://grok.invalid/v1',model:'grok-test',apiKey:'secret-grok',additionalProviders:[{id:'mimo-game',name:'MiMo',model:'mimo-v2.6-pro',baseUrl:'https://mimo.invalid/v1',apiKey:'secret-mimo',backend:'chat-completions'}]});
const players=Array.from({length:12},(_,i)=>({id:String(i),name:'玩家'+i,human:false,color:'#888'}));
test('provider selection survives normalization and public config contains no secrets',()=>{
 const r=registry(),p={...players[0],model:{providerId:'mimo-game',model:'mimo-v2.6-pro',contextTokens:32768}};
 assert.equal(r.normalize(p).model?.providerId,'mimo-game');assert.equal(r.normalize(players[1]).model?.providerId,'grok-game');
 assert(!JSON.stringify(r.publicConfig).includes('secret'));assert.equal(r.publicConfig.providers.length,2);
 assert.throws(()=>r.normalize({...p,model:{...p.model,model:'unknown'}}));
});
test('mixed players use their own endpoint, key and response parser',async()=>{
 const r=registry(),s=createWerewolf('test',players,undefined,'guard12'),request=s.requests[0],context=view(s,request.seatId);
 const original=globalThis.fetch;
 try{
 for(const mimo of [true,false]){
 globalThis.fetch=async(input,init)=>{assert.equal(String(input),mimo?'https://mimo.invalid/v1/chat/completions':'https://grok.invalid/v1/responses');assert.equal((init!.headers as any).Authorization,'Bearer secret-'+(mimo?'mimo':'grok'));const body=JSON.parse(init!.body as string);if(mimo){assert(body.messages[0].content.includes('你是MiMo'));assert(body.messages[0].content.includes('守卫'));assert.equal(body.stream,false);}else assert(body.instructions);
 return new Response(JSON.stringify(mimo?{choices:[{message:{content:'{"skip":true}',reasoning_content:'not an action'}}]}:{output_text:'{"skip":true}'}));};
 const p={...players[0],model:{providerId:mimo?'mimo-game':'grok-game',model:mimo?'mimo-v2.6-pro':'grok-test',contextTokens:32768}};
 assert.equal((await r.decide(p,context,request,new AbortController().signal)).skip,true);
 }
 }finally{globalThis.fetch=original;}
});
