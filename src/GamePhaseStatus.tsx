import type {GameView} from './game-types';
import {PHASE_NAMES} from './game-boards';
export function electionLabel(game:GameView,id:string){
 const e=game.election;if(!e||game.phase!=='election')return '';
 if(e.joining)return '待公布';
 if(e.withdrawn.includes(id))return '已退水';
 if(!e.applicants.includes(id))return '警下';
 if(game.phase==='election'&&e.round>0&&!game.candidates?.includes(id))return '未进 PK';
 return game.phase==='election'&&e.round>0?'警上 · PK':'警上';
}
export function GamePhaseStatus({game,seconds,syncError}:{game:GameView;seconds:number|null;syncError:string}){
 const night=game.phase==='night',finished=game.status==='finished';
 const speaker=game.seats.find(p=>p.id===game.clock?.seatId);
 const names=(ids:string[])=>ids.map(id=>{const i=game.seats.findIndex(p=>p.id===id);return i<0?'':`${i+1} 号 ${game.seats[i].name}`;}).filter(Boolean).join('、')||'无';
 const e=game.election;
 return <div className="wg-phase-panel" data-period={finished?'finished':night?'night':'day'}>
  <div className="wg-phase-summary"><span className="wg-period-icon" aria-hidden="true">{finished?'✓':night?'☾':'☀'}</span><div className="wg-phase-title"><strong>{finished?'对局结束':`第 ${game.day} ${night?'夜':'天'}`}</strong><span>{game.stage||PHASE_NAMES[game.phase]}{speaker&&game.status==='running'?` · ${speaker.name}${speaker.human?'发言中':'准备发言'}`:''}</span></div>{seconds!==null&&!finished&&<div className="wg-time" aria-label="剩余时间"><strong className={seconds<=10?'urgent':''}>{syncError?'—':seconds}<small> 秒</small></strong><span>{syncError?'连接中断':game.status==='paused'?'已暂停':'剩余时间'}</span></div>}</div>
  {e&&game.phase==='election'&&<details className="wg-election" aria-label="警长竞选名单" open={game.phase==='election'}><summary>警长竞选名单</summary>{e.joining?<p>正在选择是否上警，报名结束后统一公布名单。</p>:<><div><b>{e.round?'PK 候选':'警上'}</b><span>{names(game.phase==='election'?(game.candidates||[]):e.applicants.filter(id=>!e.withdrawn.includes(id)))}</span></div><div><b>警下</b><span>{names(game.seats.filter(p=>!e.applicants.includes(p.id)).map(p=>p.id))}</span></div>{e.withdrawn.length>0&&<div><b>退水</b><span>{names(e.withdrawn)}</span></div>}</>}</details>}
 </div>;
}
