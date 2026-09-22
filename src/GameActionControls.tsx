import {useEffect,useState} from 'react';
import type {GameRequest,GameView,GameAction} from './game-types';
import {ACTION_NAMES} from './game-boards';

export function GameActionControls({request:r,game,busy,submit}:{request:GameRequest;game:GameView;busy:boolean;submit:(a:GameAction)=>Promise<void>}){
 const [text,setText]=useState(''),[target,setTarget]=useState('');
 useEffect(()=>{setText('');setTarget('');},[r.id]);
 const name=(id:string)=>{const i=game.seats.findIndex(p=>p.id===id);return `${i+1} 号 ${game.seats[i]?.name||''}`;};
 const send=(a:GameAction)=>void submit(a);
 const choices=<div className="gg-targets">{r.targets.map(id=><button key={id} disabled={busy} aria-pressed={target===id} onClick={()=>setTarget(id)}>{name(id)}</button>)}</div>;
 if(['speak','wolf_plan','campaign','pk_speak','last_words'].includes(r.kind))return <>
  <label htmlFor="game-speech">{ACTION_NAMES[r.kind]}{r.kind==='wolf_plan'?' · 仅狼队可见':''}</label>
  <textarea id="game-speech" value={text} maxLength={800} onChange={e=>setText(e.target.value)} placeholder={r.kind==='campaign'?'说说你的身份、判断和警徽计划…':'说说你的判断…'}/>
  {game.board?<div className="wg-actions"><button className="primary-button" disabled={busy||!text.trim()} onClick={()=>send({text,endTurn:false})}>发送</button><button className="secondary-button" disabled={busy} onClick={()=>send({text:text.trim()||undefined,endTurn:true})}>{r.kind==='wolf_plan'?'结束讨论':'结束发言'}</button></div>:<button className="primary-button" disabled={busy||!text.trim()} onClick={()=>send({text})}>提交发言</button>}
 </>;
 if(r.kind==='sheriff_join'||r.kind==='withdraw')return <><strong>{ACTION_NAMES[r.kind]}</strong><div className="wg-actions"><button className="primary-button" disabled={busy} onClick={()=>send({choice:r.kind==='sheriff_join'})}>{r.kind==='sheriff_join'?'上警竞选':'继续竞选'}</button><button className="secondary-button" disabled={busy} onClick={()=>send({choice:r.kind==='withdraw'})}>{r.kind==='sheriff_join'?'不上警':'退水'}</button></div></>;
 if(r.kind==='sheriff_order')return <><strong>选择发言方向 · 你最后发言</strong><div className="wg-actions"><button className="secondary-button" disabled={busy} onClick={()=>send({direction:'clockwise'})}>顺时针</button><button className="secondary-button" disabled={busy} onClick={()=>send({direction:'counterclockwise'})}>逆时针</button></div></>;
 if(r.kind==='witch')return <><strong>女巫行动</strong><span>{r.witch?.victim?`今晚被袭击：${name(r.witch.victim)}`:'当前没有可见刀口'}</span>{r.witch?.canPoison&&choices}<div className="wg-actions"><button className="secondary-button" disabled={busy||!r.witch?.canSave} onClick={()=>send({potion:'save'})}>使用解药</button><button className="secondary-button" disabled={busy||!r.witch?.canPoison||!target} onClick={()=>send({potion:'poison',target})}>对所选玩家用毒</button><button className="secondary-button" disabled={busy} onClick={()=>send({potion:'skip'})}>不用药</button></div></>;
 const optional=!!game.board&&['guard','badge','shoot','vote','sheriff_vote'].includes(r.kind);
 const skipLabel=r.kind==='badge'?'撕毁警徽':r.kind==='shoot'?'放弃开枪':r.kind==='guard'?'空守':'弃票';
 return <><strong>{ACTION_NAMES[r.kind]}</strong>{choices}<div className="wg-actions"><button className="primary-button" disabled={busy||!target} onClick={()=>send({target})}>确认{ACTION_NAMES[r.kind]}</button>{optional&&<button className="secondary-button" disabled={busy} onClick={()=>send({skip:true})}>{skipLabel}</button>}</div></>;
}
