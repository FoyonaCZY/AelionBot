import {Avatar} from './ui';
import './companion-cards.css';

export type CompanionKind='plan'|'goal'|'permission'|'takeover';
export function CompanionGlyph({kind,size=18}:{kind:CompanionKind;size?:number}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind==='plan'?<><path d="m4 6 1 1 2-2m-3 7 1 1 2-2M5 18h.01M11 6h9M11 12h9M11 18h6"/></>:kind==='goal'?<><circle cx="11" cy="13" r="8"/><circle cx="11" cy="13" r="4"/><path d="m11 13 9-9m-1-2 1 2 2 1"/></>:kind==='permission'?<><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></>:<><rect x="3" y="4" width="18" height="13" rx="3"/><path d="M8 21h8M12 17v4m-3-13 6 4-3 1-1 3z"/></>}
  </svg>;
}

export function CompanionBadge({kind,activity='idle'}:{kind:CompanionKind;activity?:'idle'|'thinking'|'working'|'waiting'}){
  return <span className={`companion-badge companion-${kind}`} aria-hidden="true">
    <Avatar bot={{id:`companion-${kind}`,name:'AelionBot',color:'#8b6bea'}} size={36} activity={activity}/>
    <span className="companion-badge-symbol"><CompanionGlyph kind={kind} size={12}/></span>
  </span>;
}
