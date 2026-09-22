import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWerewolf,acceptAction,view,validateAction,type WerewolfState} from '../electron/core/games/werewolf';
import {gamePrompt,gameInstructions,parseGameAction} from '../electron/core/games/model-player';
import {GameRuntime} from '../electron/core/games/runtime';
import {BOARDS} from '../src/game-boards';
import type {GameAction,GameRequest} from '../src/game-types';
const players=Array.from({length:12},(_,i)=>({id:String(i),name:'玩家'+(i+1),human:false,color:'#887799'}));
const make=(board:'standard12'|'guard12'='standard12')=>createWerewolf('test',players,BOARDS[board].roles,board);
function act(s:WerewolfState,a:GameAction){acceptAction(s,s.requests[0].id,a);}
function answerAll(s:WerewolfState,fn:(r:GameRequest)=>GameAction){for(const r of [...s.requests])acceptAction(s,r.id,fn(r));}
function night(s:WerewolfState,victim='4',potion:GameAction={potion:'skip'},guard?:string){
 if(s.requests[0].kind==='guard')act(s,guard?{target:guard}:{skip:true});
 while(s.requests[0]?.kind==='wolf_plan')act(s,{text:'我提议先统一刀口，再考虑谁上警。'});
 answerAll(s,r=>({target:r.kind==='kill'?victim:'0'}));
 if(s.requests[0]?.kind==='witch')act(s,potion);
}
function election(s:WerewolfState,candidates=['8'],winner='8'){
 answerAll(s,r=>({choice:candidates.includes(r.seatId)}));
 while(s.requests[0]?.kind==='campaign')act(s,{text:'我来竞选警长。'});
 if(s.requests[0]?.kind==='withdraw')answerAll(s,()=>({choice:false}));
 if(s.requests[0]?.kind==='sheriff_vote')answerAll(s,()=>({target:winner}));
}
function toVote(s:WerewolfState){
 let n=0;while(s.phase!=='vote'&&s.status==='running'&&n++<50){const r=s.requests[0];assert(r);act(s,r.kind==='sheriff_order'?{direction:'clockwise'}:r.kind==='badge'||r.kind==='shoot'?{skip:true}:{text:'我先说当前判断。'});}
 assert.equal(s.phase,'vote');
}
test('both twelve decks have four wolves four villagers and four distinct gods',()=>{
 for(const board of ['standard12','guard12'] as const){const s=createWerewolf('x',players,undefined,board);assert.equal(s.seats.filter(p=>p.role==='wolf').length,4);assert.equal(s.seats.filter(p=>p.role==='villager').length,4);assert.equal(new Set(s.seats.filter(p=>!['wolf','villager'].includes(p.role)).map(p=>p.role)).size,4);assert.equal(view(s).board,board);}
 assert.throws(()=>createWerewolf('x',players,undefined,'unknown' as any));
});
test('first night deaths are withheld during election and dead elected sheriff transfers badge',()=>{
 const s=make();night(s,'8');assert.equal(s.phase,'election');assert(s.seats.every(p=>p.alive));
 assert(!JSON.stringify(view(s,'4')).includes('nightVictim'));
 election(s);assert.equal(s.seats[8].alive,false);assert.equal(s.twelve!.sheriffId,'8');assert.equal(s.requests[0].kind,'last_words');
 act(s,{text:'我的真实查验已在竞选中说过。'});assert.equal(s.requests[0].kind,'badge');act(s,{target:'5'});
 assert.equal(s.twelve!.sheriffId,'5');assert.equal(s.requests[0].kind,'sheriff_order');act(s,{direction:'counterclockwise'});
 assert.equal(s.requests[0].seatId,'4');assert.equal(s.twelve!.tasks.at(-1)?.seatId,'5');
});
test('sheriff election supports withdrawal, off-police voters, tie PK and loss of badge',()=>{
 const s=make();night(s,'4',{potion:'save'});answerAll(s,r=>({choice:['0','1','2'].includes(r.seatId)}));
 while(s.requests[0].kind==='campaign')act(s,{text:'竞选发言'});
 answerAll(s,r=>({choice:r.seatId==='2'}));assert(s.requests.every(r=>!['0','1','2'].includes(r.seatId)));
 let i=0;answerAll(s,()=>i++===8?{skip:true}:{target:i%2?'0':'1'});assert.equal(s.requests[0].kind,'campaign');assert.equal(s.twelve!.electionRound,1);
 while(s.requests[0].kind==='campaign')act(s,{text:'PK 发言'});
 i=0;answerAll(s,()=>i++===8?{skip:true}:{target:i%2?'0':'1'});assert.equal(s.twelve!.sheriffId,undefined);assert.equal(s.phase,'speech');
});
test('zero candidates or no off-police voters resolve without hanging',()=>{
 for(const all of [false,true]){const s=make();night(s,'4',{potion:'save'});answerAll(s,()=>({choice:all}));if(all){while(s.requests[0].kind==='campaign')act(s,{text:'竞选'});answerAll(s,()=>({choice:false}));}assert.equal(s.twelve!.sheriffId,undefined);assert.equal(s.phase,'speech');}
});
test('sheriff vote is worth 1.5, instead of one, in exile tally',()=>{
 const s=make();night(s,'4',{potion:'save'});election(s,['8']);toVote(s);
 answerAll(s,r=>r.seatId==='8'?{target:'0'}:r.seatId==='9'?{target:'1'}:{skip:true});
 assert.equal(s.seats[0].alive,false);assert.equal(s.seats[1].alive,true);assert(s.logs.some(l=>l.text.includes('1.5 票')));
});
test('exile tie offers PK speeches and excludes tied players from revote',()=>{
 const s=make();night(s,'4',{potion:'save'});election(s,[]);toVote(s);
 answerAll(s,r=>r.seatId==='2'?{target:'0'}:r.seatId==='3'?{target:'1'}:{skip:true});
 assert.equal(s.requests[0].kind,'pk_speak');while(s.requests[0].kind==='pk_speak')act(s,{text:'请重新判断。'});
 assert(s.requests.every(r=>!['0','1'].includes(r.seatId)));answerAll(s,()=>({skip:true}));assert.equal(s.day,2);assert(s.seats[0].alive&&s.seats[1].alive);
});
test('idiot reveal keeps player alive, removes vote and transfers sheriff badge',()=>{
 const s=make();night(s,'4',{potion:'save'});election(s,['11']);toVote(s);answerAll(s,r=>r.seatId==='11'?{skip:true}:{target:'11'});
 assert(s.seats[11].alive);assert.equal(s.requests[0].kind,'badge');assert.equal(view(s,'4').seats[11].role,'idiot');assert.equal(view(s).seats[11].canVote,false);
 act(s,{target:'8'});night(s,'4');toVote(s);assert(!s.requests.some(r=>r.seatId==='11'));assert(s.requests.every(r=>!r.targets.includes('11')));
});
test('hunter shot resolves before victory, poison disables shot, dead sheriff can tear badge',()=>{
 const s=make();night(s,'10');election(s,['10']);assert.equal(s.requests[0].kind,'shoot');act(s,{target:'0'});assert(!s.seats[0].alive);act(s,{text:'我开枪带走了1号。'});act(s,{skip:true});assert.equal(s.twelve!.sheriffId,undefined);
 const poisoned=make();night(poisoned,'4',{potion:'poison',target:'10'});election(poisoned,[]);assert(!poisoned.requests.some(r=>r.kind==='shoot'));assert(!poisoned.twelve!.tasks.some(t=>t.kind==='shoot'));
});
test('guard prevention, consecutive restriction, save conflict and poison precedence',()=>{
 const safe=make('guard12');night(safe,'4',{potion:'skip'},'4');election(safe,[]);assert(safe.seats[4].alive);toVote(safe);answerAll(safe,()=>({skip:true}));assert.equal(safe.requests[0].kind,'guard');assert(!safe.requests[0].targets.includes('4'));
 const conflict=make('guard12');night(conflict,'4',{potion:'save'},'4');election(conflict,[]);assert(!conflict.seats[4].alive);
 const poison=make('guard12');night(poison,'10',{potion:'poison',target:'10'},'10');election(poison,[]);assert(!poison.seats[10].alive);assert(!poison.twelve!.tasks.some(t=>t.kind==='shoot'));
 const raw=make();while(raw.requests[0].kind==='wolf_plan')act(raw,{text:'夜聊'});answerAll(raw,r=>({target:r.kind==='kill'?'9':'0'}));assert.equal(raw.requests[0].witch?.canSave,false);assert.throws(()=>act(raw,{potion:'save'}));
});
test('twelve uses edge elimination, not population parity',()=>{
 const s=make();night(s,'4',{potion:'save'});election(s,[]);toVote(s);
 // A persisted late-game position: four wolves, one villager, three gods.
 for(const id of ['4','5','6','11'])s.seats.find(p=>p.id===id)!.alive=false;
 answerAll(s,()=>({skip:true}));assert.equal(s.status,'running');
 night(s,'7');while(s.status==='running'&&s.phase==='resolution')act(s,{skip:true});assert.equal(s.winner,'wolves');
});
test('private deaths and guard results cannot leak into another player model context',()=>{
 const s=make('guard12');night(s,'4');const r=s.requests.find(r=>r.seatId==='0')!,before=gamePrompt(view(s,'0'),r);
 const changed=structuredClone(s);changed.twelve!.deaths=[{id:'8',cause:'knife'}];changed.twelve!.previousGuard='8';[changed.seats[8].role,changed.seats[10].role]=[changed.seats[10].role,changed.seats[8].role];
 assert.equal(gamePrompt(view(changed,'0'),r),before);
 const instructions=gameInstructions(view(s,'0'),r);assert(instructions.includes('屠边'));assert(instructions.includes('sheriff_join'));assert(!instructions.includes('你是七人'));
});
test('parsing preserves new actions and rejects contradictory skip and target',()=>{
 assert.equal(parseGameAction('{"choice":true}').choice,true);assert.equal(parseGameAction('{"direction":"clockwise"}').direction,'clockwise');
 const s=make('guard12'),r=s.requests[0];assert.throws(()=>validateAction(s,r,{target:r.targets[0],skip:true}));
});
test('timeouts in every new phase leave valid pending work or finish the game',()=>{
 const s=make();night(s,'10');election(s,['10']);let steps=0;
 while(s.status==='running'&&steps++<1200){assert(s.requests.length);acceptAction(s,s.requests[0].id,{},true);}
 assert(s.status==='paused'||s.status==='finished');assert(steps<1200);
});
test('both boards complete repeated legal games without stalled phases',()=>{
 for(const board of ['standard12','guard12'] as const)for(let n=0;n<20;n++){
  const s=make(board);let steps=0;
  while(s.status==='running'&&steps++<1000){const r=s.requests[0];assert(r,JSON.stringify({phase:s.phase,stage:s.twelve!.stage}));
   const a:GameAction=['speak','campaign','pk_speak','last_words','wolf_plan'].includes(r.kind)?{text:'我根据目前信息行动。'}:r.kind==='sheriff_join'?{choice:['0','8'].includes(r.seatId)}:r.kind==='withdraw'?{choice:false}:r.kind==='sheriff_order'?{direction:'clockwise'}:r.kind==='witch'?{potion:'skip'}:r.kind==='guard'?{skip:true}:r.targets.length?{target:r.targets[Math.floor(Math.random()*r.targets.length)]}:{skip:true};act(s,a);
  }assert.equal(s.status,'finished');assert(s.winner);assert(steps<1000);
 }
});
test('runtime persists twelve-person election and resumes after restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'wolf12-'));const decide=async()=>new Promise<GameAction>(()=>{});let runtime=new GameRuntime(dir,decide);
 try{const created=runtime.create({groupId:'persist',board:'guard12',players});assert.equal(created.seats.length,12);runtime.control(created.id,'pause');runtime.dispose();runtime=new GameRuntime(dir,decide);assert.equal(runtime.read('persist')?.board,'guard12');assert.equal(runtime.read('persist')?.status,'paused');assert.equal(runtime.control(created.id,'resume').status,'running');runtime.control(created.id,'stop');assert(runtime.inspect(created.id).some(t=>t.type==='created'&&t.detail?.includes('guard12')));}
 finally{runtime.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('spectator private system logs name their owner without impersonating the viewer',()=>{
 const s=make('guard12'),r=s.requests[0],guard=s.seats.find(p=>p.id===r.seatId)!;
 act(s,{target:guard.id});
 assert(!view(s).logs.some(l=>l.text.includes('守护了')));
 assert(view(s,guard.id).logs.some(l=>l.text===`你守护了 ${guard.name}。`));
 const observed=view(s,undefined,true).logs.find(l=>l.text.includes('守护了'))!;
 assert.equal(observed.text,`【${guard.name} · 私有记录】${guard.name}守护了 ${guard.name}。`);
 s.status='finished';assert.equal(view(s,'0').logs.find(l=>l.text.includes('守护了'))?.text,observed.text);
});

test('election view publishes roster only after join and keeps withdrawal separate from PK',()=>{
 const s=make();night(s,'4',{potion:'save'});
 assert.equal(view(s).election?.joining,true);assert.deepEqual(view(s).election?.applicants,[]);
 act(s,{choice:true});assert.deepEqual(view(s).election?.applicants,[]);
 answerAll(s,r=>({choice:['1','2'].includes(r.seatId)}));
 assert.deepEqual(view(s).election?.applicants,['0','1','2']);
 while(s.requests[0].kind==='campaign')act(s,{text:'竞选发言'});
 answerAll(s,r=>({choice:r.seatId==='2'}));
 assert.deepEqual(view(s).election?.withdrawn,['2']);assert.deepEqual(view(s).candidates,['0','1']);
});

test('human wolf can send multiple private messages within original deadline then end speaking',()=>{
 const s=make();s.seats[0].human=true;const first=s.requests[0];assert.equal(first.kind,'wolf_plan');const deadline=first.deadlineAt,firstId=first.id;
 acceptAction(s,first.id,{text:'我先听大家意见',endTurn:false});const next=s.requests[0];assert.equal(next.kind,'wolf_plan');assert.equal(next.seatId,'0');assert.equal(next.deadlineAt,deadline);assert.notEqual(next.id,firstId);
 assert(!view(s,'4').logs.some(l=>l.text==='我先听大家意见'));
 acceptAction(s,next.id,{text:'我补充一下，先别急着决定',endTurn:false});assert.equal(s.requests[0].seatId,'0');
 acceptAction(s,s.requests[0].id,{endTurn:true});assert.notEqual(s.requests[0].seatId,'0');
});

test('sheriff direction choice alias preserves intent only for the direction request',()=>{
 for(const direction of ['clockwise','counterclockwise']){const a=parseGameAction(JSON.stringify({choice:direction}),'sheriff_order');assert.equal(a.direction,direction);assert.equal(a.choice,undefined);assert(a.formatNote);}
 assert.equal(parseGameAction('{"choice":true}','sheriff_join').choice,true);
 assert.equal(parseGameAction('{"choice":"clockwise"}','sheriff_join').direction,undefined);
 assert.equal(parseGameAction('{"choice":"unknown"}','sheriff_order').direction,undefined);
 assert.equal(parseGameAction('{"choice":"clockwise","direction":"counterclockwise"}','sheriff_order').direction,'counterclockwise');
});

test('wolf conversation includes proposals replies and confirmations with human interjections',()=>{
 const roster=players.map((p,i)=>({...p,human:i===0}));const s=createWerewolf('chat',roster,BOARDS.standard12.roles,'standard12');
 const human=()=>s.requests.find(r=>r.seatId==='0')!;
 const ai=()=>s.requests.find(r=>r.seatId!=='0')!;
 const deadline=human().deadlineAt;
 actHuman('先考虑四号');assert.equal(human().deadlineAt,deadline);
 const rounds:string[]=[];let n=0;
 while(ai()&&n++<20){const r=ai();rounds.push(r.discussionRound!);assert(gamePrompt(view(s,r.seatId),r).includes('先考虑四号'));acceptAction(s,r.id,{text:'我回应队友的刀口建议'});}
 assert.equal(s.requests.length,1);assert.equal(s.requests[0].seatId,'0');assert.deepEqual(rounds,['proposal','proposal','proposal','response','response','response']);
 actHuman('改成五号，我明天倒钩');acceptAction(s,human().id,{endTurn:true});
 for(let i=0;i<3;i++){const r=ai();assert.equal(r.discussionRound,'confirm');assert(gamePrompt(view(s,r.seatId),r).includes('改成五号，我明天倒钩'));acceptAction(s,r.id,{text:'确认刀五号，你倒钩'});}
 assert(s.requests.some(r=>r.kind==='kill'));assert(!s.requests.some(r=>r.kind==='wolf_plan'));assert(!JSON.stringify(view(s,'4')).includes('倒钩'));
 function actHuman(text:string){acceptAction(s,human().id,{text,endTurn:false});}
});

test('night discussion speaker is private, including clock metadata',()=>{
 const s=make();assert(s.requests.some(r=>r.kind==='wolf_plan'));
 assert.equal(view(s).clock?.seatId,undefined);assert.equal(view(s,'4').clock?.seatId,undefined);
 assert.equal(view(s,'0').clock?.seatId,s.requests[0].seatId);assert.equal(view(s,undefined,true).clock?.seatId,s.requests[0].seatId);
});
