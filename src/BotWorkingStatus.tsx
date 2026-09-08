import type {Bot} from './shared';
import type {LiveBotStep} from './activity';
import {Avatar} from './ui';
import './bot-working-status.css';

export function BotWorkingStatus({bot,step,showName=false}:{bot:Pick<Bot,'id'|'name'|'color'|'avatarStyle'>;step:LiveBotStep;showName?:boolean}){
  return <div className="bot-working-status" data-working-bot={bot.id} data-phase={step.phase}>
    <span className="bot-working-avatar" aria-hidden="true"><Avatar bot={bot} size={48} activity={step.phase}/></span>
    <div className="bot-working-copy">{showName&&<span className="bot-working-name">{bot.name}</span>}<div role="status" aria-live="polite" aria-atomic="true"><span key={step.label} className="bot-working-label">{step.label}</span>{step.detail&&<span className="bot-working-detail" title={step.detail}>{step.detail}</span>}</div></div>
  </div>;
}
