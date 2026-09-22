import {randomUUID} from 'node:crypto';
import type {GameAction,GameRequest,GameCreate} from '../../../src/game-types';
import {ACTION_NAMES,BOARDS} from '../../../src/game-boards';
import type {WerewolfState} from './werewolf';

type Death={id:string;cause:'knife'|'poison'|'exile'|'shot'};
type Task={seatId:string;kind:GameRequest['kind']};
type Continuation='actions'|'election_withdraw'|'election_vote'|'day'|'night'|'vote'|'revote';
export interface TwelveState {
 wolfChat?:{round:number;index:number;humanDone:boolean};
 board:NonNullable<GameCreate['board']>;stage:string;sheriffId?:string;
 withdrawn?:string[];applicants:string[];candidates:string[];electionRound:number;
 tasks:Task[];after:Continuation;deaths:Death[];previousGuard?:string;guardTarget?:string;
 revealed:string[];voteTargets?:string[];
}
const data=(s:WerewolfState)=>s.twelve!;
const alive=(s:WerewolfState)=>s.seats.filter(p=>p.alive);
const name=(s:WerewolfState,id:string)=>s.seats.find(p=>p.id===id)!.name;
const canVote=(s:WerewolfState,id:string)=>!data(s).revealed.includes(id);
const say=(s:WerewolfState,text:string,seatId?:string,audience?:string[])=>s.logs.push({id:s.logs.length+1,day:s.day,phase:s.phase,text,seatId,audience,time:Date.now()});
export const isSpeech=(kind:GameRequest['kind'])=>['speak','wolf_plan','campaign','pk_speak','last_words'].includes(kind);
function ask(s:WerewolfState,seatId:string,kind:GameRequest['kind'],targets:string[]=[]){
 s.requests.push({id:randomUUID(),seatId,kind,targets,deadlineAt:Date.now()+(isSpeech(kind)?(s.seats.find(p=>p.id===seatId)!.human?120000:60000):45000)});
}
function stage(s:WerewolfState,label:string){data(s).stage=label;s.requests=[];s.answers={};}
function won(s:WerewolfState){
 const live=alive(s),wolves=live.filter(p=>p.role==='wolf').length;
 if(wolves&&live.some(p=>p.role==='villager')&&live.some(p=>p.role!=='wolf'&&p.role!=='villager'))return false;
 s.winner=wolves?'wolves':'village';s.status='finished';s.phase='finished';s.requests=[];data(s).tasks=[];
 say(s,s.winner==='wolves'?'狼人完成屠边，狼人阵营获胜。':'狼人全部出局，好人阵营获胜。');return true;
}
function queue(s:WerewolfState,tasks:Task[],after:Continuation){data(s).tasks=tasks;data(s).after=after;s.requests=[];nextTask(s);}
function nextTask(s:WerewolfState){
 const d=data(s),task=d.tasks.shift();s.requests=[];
 if(task){
  const targets=task.kind==='badge'?alive(s).filter(p=>p.id!==task.seatId&&canVote(s,p.id)).map(p=>p.id):task.kind==='shoot'?alive(s).map(p=>p.id):[];
  ask(s,task.seatId,task.kind,targets);return;
 }
 switch(d.after){
  case 'actions':nightActions(s);break;
  case 'election_withdraw':withdraw(s);break;
  case 'election_vote':electionVote(s);break;
  case 'day':startDay(s);break;
  case 'night':nextNight(s);break;
  case 'vote':voting(s);break;
  case 'revote':voting(s,d.voteTargets);break;
 }
}
export function startTwelve(s:WerewolfState,board:NonNullable<GameCreate['board']>){
 s.twelve={board,stage:'',applicants:[],candidates:[],electionRound:0,tasks:[],after:'actions',deaths:[],revealed:[]};
 say(s,`游戏开始：12 人${BOARDS[board].name}，有警长，屠边规则。`);night(s);
}
function night(s:WerewolfState){
 s.phase='night';stage(s,'夜间守护');const d=data(s);d.deaths=[];delete s.nightVictim;delete d.guardTarget;
 say(s,`第 ${s.day} 夜`);
 const guard=alive(s).find(p=>p.role==='guard');
 if(guard)ask(s,guard.id,'guard',alive(s).filter(p=>p.id!==d.previousGuard).map(p=>p.id));else wolfDiscussion(s);
}
function wolfDiscussion(s:WerewolfState){
 stage(s,'狼队夜聊');const human=alive(s).find(p=>p.role==='wolf'&&p.human);
 data(s).wolfChat={round:0,index:0,humanDone:!human};
 if(human){ask(s,human.id,'wolf_plan');s.requests.at(-1)!.discussionRound='response';}
 advanceWolfChat(s);
}
function advanceWolfChat(s:WerewolfState){
 const chat=data(s).wolfChat!;
 if(s.requests.some(r=>r.kind==='wolf_plan'&&!s.seats.find(p=>p.id===r.seatId)?.human))return;
 const bots=alive(s).filter(p=>p.role==='wolf'&&!p.human);
 if(chat.index>=bots.length){
  if(chat.round===1&&!chat.humanDone)return;
  chat.round++;chat.index=0;
 }
 if(chat.round>=3){delete data(s).wolfChat;nightActions(s);return;}
 if(!bots.length){if(chat.humanDone){delete data(s).wolfChat;nightActions(s);}return;}
 const round=(['proposal','response','confirm'] as const)[chat.round];
 const bot=bots[chat.index++];ask(s,bot.id,'wolf_plan');s.requests.at(-1)!.discussionRound=round;
}
function nightActions(s:WerewolfState){
 stage(s,'夜间行动');for(const p of alive(s)){
  if(p.role==='wolf')ask(s,p.id,'kill',alive(s).map(p=>p.id));
  if(p.role==='seer')ask(s,p.id,'inspect',alive(s).filter(t=>t.id!==p.id).map(p=>p.id));
 }
 if(!s.requests.length)resolveNight(s,{potion:'skip'});
}
function resolveNightActions(s:WerewolfState){
 const seer=alive(s).find(p=>p.role==='seer'),target=seer&&s.answers[seer.id]?.target;
 if(seer&&target)say(s,`查验结果：${name(s,target)} 是${s.seats.find(p=>p.id===target)!.role==='wolf'?'狼人':'好人'}。`,undefined,[seer.id]);
 const counts=new Map<string,number>();for(const p of alive(s).filter(p=>p.role==='wolf')){const t=s.answers[p.id]?.target;if(t)counts.set(t,(counts.get(t)||0)+1);}
 s.nightVictim=[...counts].sort((a,b)=>b[1]-a[1]||s.seats.findIndex(p=>p.id===a[0])-s.seats.findIndex(p=>p.id===b[0]))[0]?.[0];
 if(s.nightVictim)say(s,`狼队刀口：${name(s,s.nightVictim)}。`,undefined,alive(s).filter(p=>p.role==='wolf').map(p=>p.id));
 stage(s,'女巫用药');const witch=alive(s).find(p=>p.role==='witch');
 if(witch){ask(s,witch.id,'witch',alive(s).filter(p=>p.id!==witch.id).map(p=>p.id));s.requests[0].witch={victim:s.potions!.save?s.nightVictim:undefined,canSave:!!s.nightVictim&&s.potions!.save&&s.nightVictim!==witch.id,canPoison:s.potions!.poison};}
 else resolveNight(s,{potion:'skip'});
}
function resolveNight(s:WerewolfState,a:GameAction){
 const d=data(s),witch=alive(s).find(p=>p.role==='witch'),victim=s.nightVictim;
 const saved=a.potion==='save',guarded=!!victim&&d.guardTarget===victim;
 d.deaths=[];
 if(victim&&saved===guarded)d.deaths.push({id:victim,cause:'knife'});
 if(witch&&saved){s.potions!.save=false;say(s,`你使用解药救下了 ${name(s,victim!)}。`,undefined,[witch.id]);}
 if(witch&&a.potion==='poison'&&a.target){s.potions!.poison=false;d.deaths=d.deaths.filter(x=>x.id!==a.target);d.deaths.push({id:a.target,cause:'poison'});say(s,`你对 ${name(s,a.target)} 使用毒药。`,undefined,[witch.id]);}
 d.previousGuard=d.guardTarget;
 if(s.day===1)beginElection(s);else announceDeaths(s);
}
function beginElection(s:WerewolfState){
 s.phase='election';stage(s,'上警报名');say(s,'天亮，先竞选警长，竞选结束后公布昨夜死讯。');
 for(const p of alive(s))ask(s,p.id,'sheriff_join');
}
function finishJoin(s:WerewolfState){
 const d=data(s);d.applicants=alive(s).filter(p=>s.answers[p.id]?.choice).map(p=>p.id);d.candidates=[...d.applicants];
 say(s,d.candidates.length?`上警玩家：${d.candidates.map(id=>name(s,id)).join('、')}。`:'无人上警，本局无警长。');
 if(d.candidates.length<2){elect(s,d.candidates[0]);return;}
 stage(s,'警上发言');queue(s,d.candidates.map(seatId=>({seatId,kind:'campaign'})),'election_withdraw');
}
function withdraw(s:WerewolfState){stage(s,'退水选择');for(const id of data(s).candidates)ask(s,id,'withdraw');}
function finishWithdraw(s:WerewolfState){
 const d=data(s);d.withdrawn=d.candidates.filter(id=>s.answers[id]?.choice);for(const id of d.withdrawn)say(s,`${name(s,id)} 退水。`);
 d.candidates=d.candidates.filter(id=>!s.answers[id]?.choice);
 if(d.candidates.length<2)elect(s,d.candidates[0]);else electionVote(s);
}
function electionVote(s:WerewolfState){
 stage(s,data(s).electionRound?'警长 PK 投票':'警长投票');
 for(const p of alive(s).filter(p=>!data(s).applicants.includes(p.id)))ask(s,p.id,'sheriff_vote',[...data(s).candidates]);
 if(!s.requests.length){say(s,'无警下选民，警徽流失。');elect(s);}
}
function topVotes(s:WerewolfState,weighted:boolean){
 const counts=new Map<string,number>();for(const [id,a] of Object.entries(s.answers)){
  const weight=weighted&&id===data(s).sheriffId?1.5:1;
  if(a.target){counts.set(a.target,(counts.get(a.target)||0)+weight);say(s,`${name(s,id)} 投给 ${name(s,a.target)}（${weight} 票）。`);}
  else say(s,`${name(s,id)} 弃票。`);
 }
 const max=Math.max(0,...counts.values());return [...counts].filter(([,n])=>n===max).map(([id])=>id);
}
function finishElectionVote(s:WerewolfState){
 const d=data(s),top=topVotes(s,false);
 if(top.length>1&&!d.electionRound){d.electionRound=1;d.candidates=top;stage(s,'警长平票 PK');say(s,'警长投票平票，候选人 PK 后重投一次。');queue(s,top.map(seatId=>({seatId,kind:'campaign'})),'election_vote');}
 else elect(s,top.length===1?top[0]:undefined);
}
function elect(s:WerewolfState,id?:string){
 data(s).sheriffId=id;data(s).candidates=[];
 say(s,id?`${name(s,id)} 当选警长，获得警徽。`:'警徽流失，本局无警长。');announceDeaths(s);
}
function deathTasks(s:WerewolfState,deaths:Death[]):Task[]{
 const tasks:Task[]=[];
 for(const x of deaths){
  const p=s.seats.find(p=>p.id===x.id)!;
  if(p.role==='hunter'&&x.cause!=='poison'){say(s,`${p.name} 翻牌为猎人，可以选择开枪。`);tasks.push({seatId:p.id,kind:'shoot'});}
  if(x.cause==='exile'||s.day===1&&(x.cause==='knife'||x.cause==='poison'))tasks.push({seatId:p.id,kind:'last_words'});
  if(data(s).sheriffId===p.id)tasks.push({seatId:p.id,kind:'badge'});
 }
 return tasks;
}
function announceDeaths(s:WerewolfState){
 s.phase='resolution';stage(s,'公布死讯');const deaths=data(s).deaths;
 for(const x of deaths)s.seats.find(p=>p.id===x.id)!.alive=false;
 say(s,deaths.length?`天亮了，${deaths.map(x=>name(s,x.id)).join('、')} 出局。`:'天亮了，昨夜无人出局。');
 queue(s,deathTasks(s,deaths),'day');
}
function startDay(s:WerewolfState){
 if(won(s))return;s.phase='speech';stage(s,'决定发言顺序');
 const sheriff=alive(s).find(p=>p.id===data(s).sheriffId);
 if(sheriff)ask(s,sheriff.id,'sheriff_order');else daySpeeches(s,'clockwise');
}
function daySpeeches(s:WerewolfState,direction:'clockwise'|'counterclockwise'){
 const d=data(s);stage(s,'白天发言');let ids=alive(s).map(p=>p.id);
 if(d.sheriffId){const index=s.seats.findIndex(p=>p.id===d.sheriffId),step=direction==='clockwise'?1:-1;ids=Array.from({length:s.seats.length},(_,i)=>s.seats[(index+step*(i+1)+s.seats.length*2)%s.seats.length]).filter(p=>p.alive).map(p=>p.id);say(s,`警长选择${direction==='clockwise'?'顺时针':'逆时针'}发言，警长最后发言。`);}
 queue(s,ids.map(seatId=>({seatId,kind:'speak'})),'vote');
}
function voting(s:WerewolfState,targets?:string[]){
 s.phase='vote';stage(s,targets?'放逐 PK 投票':'放逐投票');data(s).voteTargets=targets;
 const eligible=alive(s).filter(p=>canVote(s,p.id));
 for(const p of eligible.filter(p=>!targets?.includes(p.id)))ask(s,p.id,'vote',(targets||eligible.map(p=>p.id)).filter(id=>id!==p.id));
 say(s,targets?'PK 玩家不投票，其余玩家重新投票。':'开始放逐投票，警长计 1.5 票。');
 if(!s.requests.length){say(s,'没有可投票玩家，本轮无人被放逐。');nextNight(s);}
}
function finishVote(s:WerewolfState){
 const d=data(s),top=topVotes(s,true);
 if(top.length>1&&!s.voteRound){s.voteRound=1;d.voteTargets=top;s.phase='speech';stage(s,'放逐平票 PK');say(s,'放逐平票，PK 发言后重投一次。');queue(s,top.map(seatId=>({seatId,kind:'pk_speak'})),'revote');return;}
 if(top.length!==1){say(s,'平票或全员弃票，本轮无人被放逐。');nextNight(s);return;}
 const p=s.seats.find(p=>p.id===top[0])!;s.phase='resolution';stage(s,'放逐结算');
 if(p.role==='idiot'&&!d.revealed.includes(p.id)){
  d.revealed.push(p.id);say(s,`${p.name} 翻牌为白痴，免于本次放逐，失去投票权和被放逐资格。`);
  queue(s,d.sheriffId===p.id?[{seatId:p.id,kind:'badge'}]:[],'night');return;
 }
 p.alive=false;say(s,`${p.name} 被放逐。`);queue(s,deathTasks(s,[{id:p.id,cause:'exile'}]),'night');
}
function nextNight(s:WerewolfState){
 if(won(s))return;s.day++;s.voteRound=0;if(s.day>20){s.status='paused';s.error='达到 20 天运行上限，请结束本局';return;}night(s);
}
export function validateTwelve(s:WerewolfState,r:GameRequest,a:GameAction){
 if(!a||typeof a!=='object'||Array.isArray(a))throw Error('行动格式无效');
 if(a.note!==undefined&&(typeof a.note!=='string'||a.note.length>500))throw Error('决策摘要格式无效');
 if(isSpeech(r.kind)&&s.seats.find(p=>p.id===r.seatId)?.human&&a.endTurn===true&&!a.text)return;
 if(isSpeech(r.kind)){if(typeof a.text!=='string'||!a.text.trim()||a.text.length>800)throw Error('发言应为 1–800 字');return;}
 if(r.kind==='sheriff_join'||r.kind==='withdraw'){if(typeof a.choice!=='boolean')throw Error('请选择是或否');return;}
 if(r.kind==='sheriff_order'){if(!['clockwise','counterclockwise'].includes(a.direction||''))throw Error('请选择发言方向');return;}
 if(r.kind==='witch'){
  if(!['save','poison','skip'].includes(a.potion||''))throw Error('请选择药剂或不用药');
  if(a.potion==='save'&&!r.witch?.canSave)throw Error('本轮不能救人');
  if(a.potion==='poison'&&(!r.witch?.canPoison||!a.target||!r.targets.includes(a.target)))throw Error('毒药或目标无效');return;
 }
 if(a.skip===true&&['guard','shoot','badge','vote','sheriff_vote'].includes(r.kind)){if(a.target!==undefined)throw Error('跳过时不能同时选择目标');return;}
 if(typeof a.target!=='string'||!r.targets.includes(a.target))throw Error('目标不在本轮合法选择中');
}
export function acceptTwelve(s:WerewolfState,id:string,a:GameAction,timeout=false){
 if(s.accepted.includes(id))return;if(s.status!=='running')throw Error('对局未运行');
 const r=s.requests.find(x=>x.id===id);if(!r)throw Error('行动请求已经失效');
 if(!timeout)validateTwelve(s,r,a);
 else{
  const privateAction=s.phase==='night',audience=privateAction?(r.kind==='wolf_plan'?alive(s).filter(p=>p.role==='wolf').map(p=>p.id):[r.seatId]):undefined;
  say(s,`${name(s,r.seatId)} ${ACTION_NAMES[r.kind]}超时，按规则跳过或使用默认选择。`,undefined,audience);
  a=isSpeech(r.kind)?{text:'（本轮发言超时）'}:r.kind==='witch'?{potion:'skip'}:r.kind==='sheriff_order'?{direction:'clockwise'}:{skip:true,choice:false};
 }
 if(r.kind==='wolf_plan'&&data(s).wolfChat){
  const human=s.seats.find(p=>p.id===r.seatId)!.human;
  if(a.text?.trim())say(s,`【狼队夜聊】${a.text.trim()}`,r.seatId,alive(s).filter(p=>p.role==='wolf').map(p=>p.id));
  s.accepted.push(id);
  if(human&&!timeout&&a.endTurn===false){r.id=randomUUID();return;}
  s.requests=s.requests.filter(x=>x.id!==id);
  if(human)data(s).wolfChat!.humanDone=true;
  advanceWolfChat(s);return;
 }
 if(!timeout&&isSpeech(r.kind)&&s.seats.find(p=>p.id===r.seatId)?.human){
  s.accepted.push(id);
  if(a.text?.trim())say(s,a.text.trim(),r.seatId,r.kind==='wolf_plan'?alive(s).filter(p=>p.role==='wolf').map(p=>p.id):undefined);
  if(a.endTurn===false){r.id=randomUUID();return;}
  s.requests=s.requests.filter(x=>x.id!==id);nextTask(s);return;
 }
 // Store only fields relevant to this request; extra model output must not affect tallying.
 const action:GameAction=isSpeech(r.kind)?{text:a.text!.trim(),note:a.note}:r.kind==='sheriff_join'||r.kind==='withdraw'?{choice:a.choice,note:a.note}:r.kind==='sheriff_order'?{direction:a.direction,note:a.note}:r.kind==='witch'?{potion:a.potion,target:a.potion==='poison'?a.target:undefined,note:a.note}:{target:a.skip?undefined:a.target,skip:a.skip,note:a.note};
 s.accepted.push(id);s.requests=s.requests.filter(x=>x.id!==id);s.answers[r.seatId]=action;
 if(isSpeech(r.kind)){
  const audience=r.kind==='wolf_plan'?alive(s).filter(p=>p.role==='wolf').map(p=>p.id):undefined;
  say(s,`${r.kind==='speak'?'':`【${ACTION_NAMES[r.kind]}】`}${action.text}`,r.seatId,audience);nextTask(s);return;
 }
 if(r.kind==='guard'){data(s).guardTarget=action.target;say(s,action.target?`你守护了 ${name(s,action.target)}。`:'你选择空守。',undefined,[r.seatId]);wolfDiscussion(s);return;}
 if(r.kind==='sheriff_order'){daySpeeches(s,action.direction||'clockwise');return;}
 if(r.kind==='badge'){
  data(s).sheriffId=action.target;say(s,action.target?`${name(s,r.seatId)} 将警徽移交给 ${name(s,action.target)}。`:`${name(s,r.seatId)} 撕毁了警徽。`);nextTask(s);return;
 }
 if(r.kind==='shoot'){
  if(action.target){const p=s.seats.find(p=>p.id===action.target)!;p.alive=false;say(s,`猎人 ${name(s,r.seatId)} 开枪，${p.name} 出局。`);data(s).tasks.push(...deathTasks(s,[{id:p.id,cause:'shot'}]));}
  else say(s,`${name(s,r.seatId)} 放弃开枪。`);nextTask(s);return;
 }
 if(s.requests.length)return;
 switch(r.kind){
  case 'kill':case 'inspect':resolveNightActions(s);break;
  case 'witch':resolveNight(s,action);break;
  case 'sheriff_join':finishJoin(s);break;
  case 'withdraw':finishWithdraw(s);break;
  case 'sheriff_vote':finishElectionVote(s);break;
  case 'vote':finishVote(s);break;
 }
}
