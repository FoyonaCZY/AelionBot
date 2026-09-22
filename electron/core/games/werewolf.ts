import {BOARDS} from '../../../src/game-boards';
import {startTwelve,acceptTwelve,validateTwelve,isSpeech,type TwelveState} from './twelve';
import {randomUUID,randomInt} from 'node:crypto';
import type {GamePlayer,GameAction,GameRequest,GameLog,GameView,GameRole,GamePhase,GameStatus} from '../../../src/game-types';
import {GAME_MBTI_TYPES,gameBehaviorPolicy,gamePersonality,isGameMbti} from '../../../src/game-personality';
export interface WerewolfState {twelve?:TwelveState;trace?:import('../../../src/game-types').GameTrace[];revision?:number;potions?:{save:boolean;poison:boolean};nightVictim?:string;nightStage?:'wolf_discussion'|'actions'|'witch';wolfDiscussionIndex?:number;id:string;groupId:string;day:number;phase:GamePhase;status:GameStatus;seats:(GamePlayer&{alive:boolean;role:GameRole})[];logs:GameLog[];requests:GameRequest[];answers:Record<string,GameAction>;accepted:string[];speechIndex:number;voteRound:number;winner?:'wolves'|'village';error?:string;}
export function log(s:WerewolfState,text:string,seatId?:string,audience?:string[]){s.logs.push({id:s.logs.length+1,day:s.day,phase:s.phase,text,seatId,audience,time:Date.now()});}
function request(s:WerewolfState,seatId:string,kind:GameRequest['kind'],targets:string[]=[]){s.requests.push({id:randomUUID(),seatId,kind,targets,deadlineAt:Date.now()+(kind==='speak'?(s.seats.find(p=>p.id===seatId)?.human?120000:60000):45000)});}
const living=(s:WerewolfState)=>s.seats.filter(p=>p.alive);
export function createWerewolf(groupId:string,players:GamePlayer[],roles?:GameRole[],board?:'standard12'|'guard12'):WerewolfState{
 if(![6,7,12].includes(players.length)||new Set(players.map(p=>p.id)).size!==players.length||players.filter(p=>p.human).length>1)throw Error('需要七位或十二位不同的玩家，最多一位真人');
 if(players.some(p=>!p.id||!p.name||p.name.length>80))throw Error('玩家信息无效');
 if(players.some(p=>p.mbti!==undefined&&!isGameMbti(p.mbti)))throw Error('AI 性格配置无效');
 if(board!==undefined&&(!Object.hasOwn(BOARDS,board)||players.length!==12))throw Error('板子配置无效');
 const selectedBoard=board||'standard12';
 const deck:GameRole[]=roles?[...roles]:players.length===12?[...BOARDS[selectedBoard].roles]:['wolf','wolf','seer',...(players.length===7?['witch' as const]:[]),'villager','villager','villager'];
 if(deck.length!==players.length||deck.some(r=>!['wolf','seer','witch','villager','hunter','guard','idiot'].includes(r)))throw Error('身份配置与人数不符');
 if(!roles)for(let i=deck.length-1;i>0;i--){const j=randomInt(i+1);[deck[i],deck[j]]=[deck[j],deck[i]];}
 const randomTypes=[...GAME_MBTI_TYPES];for(let i=randomTypes.length-1;i>0;i--){const j=randomInt(i+1);[randomTypes[i],randomTypes[j]]=[randomTypes[j],randomTypes[i]];}
 let randomTypeIndex=0;
 const seats=players.map((p,i)=>{if(p.human)return {...p,mbti:undefined,behaviorPolicy:undefined,personality:undefined,alive:true,role:deck[i]};const mbti=p.mbti||randomTypes[randomTypeIndex++],accent=randomInt(4);return {...p,mbti,behaviorPolicy:gameBehaviorPolicy(mbti,accent),personality:gamePersonality(mbti,accent),alive:true,role:deck[i]};});
 const s:WerewolfState={potions:{save:true,poison:true},id:randomUUID(),groupId,day:1,phase:'night',status:'running',seats,logs:[],requests:[],answers:{},accepted:[],speechIndex:0,voteRound:0};
 if(players.length===12){startTwelve(s,selectedBoard);return s;}
 log(s,`游戏开始。2 位狼人、1 位预言家、${players.length===7?'1 位女巫、':''}3 位村民。`);night(s);return s;
}
function startNightActions(s:WerewolfState){s.nightStage='actions';s.answers={};s.requests=[];for(const p of living(s)){if(p.role==='wolf')request(s,p.id,'kill',living(s).filter(t=>t.role!=='wolf').map(t=>t.id));if(p.role==='seer')request(s,p.id,'inspect',living(s).filter(t=>t.id!==p.id).map(t=>t.id));}}
function nextWolfPlan(s:WerewolfState){const wolves=living(s).filter(p=>p.role==='wolf');const player=wolves[s.wolfDiscussionIndex||0];if(!player){startNightActions(s);return;}request(s,player.id,'wolf_plan',living(s).filter(t=>t.role!=='wolf').map(t=>t.id));}
function night(s:WerewolfState){s.phase='night';s.nightStage='wolf_discussion';s.wolfDiscussionIndex=0;delete s.nightVictim;s.answers={};s.requests=[];log(s,`第 ${s.day} 夜`);nextWolfPlan(s);}
function finishIfWon(s:WerewolfState){const wolves=living(s).filter(p=>p.role==='wolf').length,others=living(s).length-wolves;if(wolves===0||wolves>=others){s.winner=wolves===0?'village':'wolves';s.status='finished';s.phase='finished';s.requests=[];log(s,s.winner==='village'?'好人阵营获胜':'狼人阵营获胜');return true;}return false;}
function speech(s:WerewolfState){s.requests=[];const p=living(s)[s.speechIndex];if(p)request(s,p.id,'speak');else voting(s);}
function voting(s:WerewolfState,targets?:string[]){s.phase='vote';s.answers={};s.requests=[];log(s,s.voteRound?'平票，进行一次重新投票':'开始放逐投票');for(const p of living(s))request(s,p.id,'vote',(targets||living(s).map(t=>t.id)).filter(id=>id!==p.id));}
export function validateAction(s:WerewolfState,r:GameRequest,a:GameAction){if(s.twelve)return validateTwelve(s,r,a);if(!a||typeof a!=='object')throw Error('行动格式无效');if(a.note!==undefined&&(typeof a.note!=='string'||a.note.length>500))throw Error('决策摘要格式无效');if(r.kind==='speak'||r.kind==='wolf_plan'){if(typeof a.text!=='string'||!a.text.trim()||a.text.length>800)throw Error(r.kind==='speak'?'发言应为 1–800 字':'狼队夜聊应为 1–800 字');}else if(r.kind==='witch'){if(!['save','poison','skip'].includes(a.potion||''))throw Error('请选择使用药剂或跳过');if(a.potion==='save'&&!r.witch?.canSave)throw Error('本轮不能使用解药');if(a.potion==='poison'&&(!r.witch?.canPoison||!a.target||!r.targets.includes(a.target)))throw Error('毒药或目标无效');}else if(typeof a.target!=='string'||!r.targets.includes(a.target))throw Error('目标不在本轮合法选择中');}
export function acceptAction(s:WerewolfState,id:string,a:GameAction,timeout=false){
 if(s.twelve)return acceptTwelve(s,id,a,timeout);
 if(s.accepted.includes(id))return;if(s.status!=='running')throw Error('对局未运行');const r=s.requests.find(r=>r.id===id);if(!r)throw Error('行动请求已经失效');
 if(!timeout)validateAction(s,r,a);else{
  const player=s.seats.find(p=>p.id===r.seatId)!,wolves=living(s).filter(p=>p.role==='wolf').map(p=>p.id);
  const audience=r.kind==='wolf_plan'?wolves:r.kind==='kill'||r.kind==='inspect'||r.kind==='witch'?[player.id]:undefined;
  log(s,`${player.name} ${r.kind==='speak'?'发言超时，跳过':r.kind==='vote'?'投票超时，弃权':'夜间行动超时，放弃行动'}。`,undefined,audience);
 }
 const normalizedText=timeout&&r.kind==='wolf_plan'?'我这轮没有补充，你先定。':a.text?.trim();
 s.answers[r.seatId]=r.kind==='speak'||r.kind==='wolf_plan'?{text:normalizedText,note:a.note}:r.kind==='witch'?{potion:a.potion||'skip',target:a.target,note:a.note}:{target:a.target,note:a.note};
 s.accepted.push(id);s.requests=s.requests.filter(t=>t.id!==id);
 if(r.kind==='speak'){log(s,normalizedText!,r.seatId);s.speechIndex++;speech(s);return;}
 if(r.kind==='wolf_plan'){const wolves=living(s).filter(p=>p.role==='wolf');log(s,`【狼队夜聊】${normalizedText}`,r.seatId,wolves.map(p=>p.id));s.wolfDiscussionIndex=(s.wolfDiscussionIndex||0)+1;nextWolfPlan(s);return;}
 if(s.requests.length)return;
 if(s.phase==='night'){
  if(r.kind==='witch'){resolveNight(s,s.answers[r.seatId]);return;}
  const seer=living(s).find(p=>p.role==='seer');if(seer&&s.answers[seer.id]?.target){const target=s.seats.find(p=>p.id===s.answers[seer.id].target)!;log(s,`查验结果：${target.name} 是${target.role==='wolf'?'狼人':'好人'}。`,undefined,[seer.id]);}
  const wolves=living(s).filter(p=>p.role==='wolf');const counts=new Map<string,number>();for(const p of wolves){const id=s.answers[p.id]?.target;if(id)counts.set(id,(counts.get(id)||0)+1);}
  const target=[...counts].sort((a,b)=>b[1]-a[1]||s.seats.findIndex(p=>p.id===a[0])-s.seats.findIndex(p=>p.id===b[0]))[0]?.[0];
  s.nightVictim=target;
  if(target)log(s,`狼人选择了 ${s.seats.find(p=>p.id===target)!.name}。`,undefined,wolves.map(p=>p.id));
  const witch=living(s).find(p=>p.role==='witch');
  if(witch){s.nightStage='witch';s.potions??={save:true,poison:true};request(s,witch.id,'witch',living(s).filter(p=>p.id!==witch.id).map(p=>p.id));s.requests[0].witch={victim:s.potions.save?target:undefined,canSave:!!target&&s.potions.save&&(target!==witch.id||s.day===1),canPoison:s.potions.poison};return;}
  resolveNight(s);return;
 }
 const counts=new Map<string,number>();for(const p of living(s)){const target=s.answers[p.id]?.target;if(target)counts.set(target,(counts.get(target)||0)+1);log(s,target?`${p.name} 投给 ${s.seats.find(t=>t.id===target)?.name}。`:`${p.name} 弃权。`);}
 const max=Math.max(...counts.values()),top=[...counts].filter(([,n])=>n===max).map(([id])=>id);
 if(top.length>1&&s.voteRound===0){s.voteRound=1;voting(s,top);return;}
 if(top.length===1){s.seats.find(p=>p.id===top[0])!.alive=false;log(s,`${s.seats.find(p=>p.id===top[0])!.name} 被放逐。`);}else log(s,top.length===0?'全部弃权，本轮无人被放逐。':'再次平票，本轮无人被放逐。');
 if(finishIfWon(s))return;s.day++;s.voteRound=0;if(s.day>20){s.status='paused';s.error='达到 20 天运行上限，请结束本局';return;}night(s);
}
function resolveNight(s:WerewolfState,action?:GameAction){
 const witch=living(s).find(p=>p.role==='witch');const deaths=new Set<string>();if(s.nightVictim)deaths.add(s.nightVictim);
 if(witch&&action?.potion==='save'){s.potions!.save=false;deaths.delete(s.nightVictim!);log(s,`你使用解药救下了 ${s.seats.find(p=>p.id===s.nightVictim)?.name}。`,undefined,[witch.id]);}
 if(witch&&action?.potion==='poison'&&action.target){s.potions!.poison=false;deaths.add(action.target);log(s,`你对 ${s.seats.find(p=>p.id===action.target)?.name} 使用了毒药。`,undefined,[witch.id]);}
 for(const id of deaths)s.seats.find(p=>p.id===id)!.alive=false;
 s.phase='speech';log(s,deaths.size?`天亮了，${[...deaths].map(id=>s.seats.find(p=>p.id===id)!.name).join('、')} 出局。`:'天亮了，昨夜无人出局。');if(finishIfWon(s))return;s.speechIndex=0;s.answers={};speech(s);
}
export function view(s:WerewolfState,viewerId?:string,omniscient=false):GameView{
 const self=s.seats.find(p=>p.id===viewerId);const timed=s.requests.filter(r=>r.deadlineAt||r.remainingMs!==undefined);const humanTimed=timed.filter(r=>s.seats.find(p=>p.id===r.seatId)?.human);const clockRequest=(humanTimed.length?humanTimed:timed).slice().sort((a,b)=>(a.deadlineAt||a.remainingMs||0)-(b.deadlineAt||b.remainingMs||0))[0];const clock=clockRequest?{deadlineAt:s.seats.find(p=>p.id===clockRequest.seatId)?.human?clockRequest.deadlineAt:undefined,remainingMs:s.seats.find(p=>p.id===clockRequest.seatId)?.human?clockRequest.remainingMs:undefined,seatId:isSpeech(clockRequest.kind)&&(clockRequest.kind!=='wolf_plan'||self?.role==='wolf'||s.status==='finished'||!s.seats.some(p=>p.human)&&omniscient)?clockRequest.seatId:undefined}:undefined;const reveal=s.status==='finished'||(!s.seats.some(p=>p.human)&&omniscient);
 return {revision:s.revision,clock,board:s.twelve?.board,sheriffId:s.twelve?.sheriffId,stage:s.twelve?.stage,candidates:s.twelve?.candidates,election:s.twelve&&(s.phase==='election'||s.logs.some(l=>!l.audience&&/^(上警玩家：|无人上警，)/.test(l.text)))?{applicants:s.twelve.applicants,withdrawn:s.twelve.withdrawn||s.twelve.applicants.filter(id=>s.logs.some(l=>!l.audience&&l.text===`${s.seats.find(p=>p.id===id)?.name} 退水。`)),round:s.twelve.electionRound,joining:s.twelve.stage==='上警报名'}:undefined,id:s.id,groupId:s.groupId,day:s.day,phase:s.phase,status:s.status,seats:s.seats.map(p=>{const {role,...publicSeat}=p;return {...publicSeat,canVote:!s.twelve?.revealed.includes(p.id),revealed:s.twelve?.revealed.includes(p.id),...(reveal||s.twelve?.revealed.includes(p.id)||p.id===viewerId||self?.role==='wolf'&&p.role==='wolf'?{role}:{})};}),logs:s.logs.filter(e=>!e.audience||reveal||!!viewerId&&e.audience.includes(viewerId)).map(({audience,...e})=>{const otherPrivate=reveal&&audience&&!e.seatId&&!(viewerId&&audience.includes(viewerId));const owners=audience?.map(id=>s.seats.find(p=>p.id===id)?.name||'玩家').join('、');return {...e,text:otherPrivate?`【${owners} · 私有记录】${e.text.replace(/^你/,owners||'该玩家')}`:e.text,scope:audience?'personal' as const:'shared' as const};}),pending:s.requests.filter(r=>r.seatId===viewerId),winner:s.winner,error:s.error,humanId:s.seats.find(p=>p.human)?.id};
}
