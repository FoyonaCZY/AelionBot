import type {AttachmentScope} from './attachment-types';
import type {TaskPlan} from './runtime-types';

export type WorkMode='plan'|'goal';
export type WorkStatus='planning'|'ready'|'running'|'paused'|'blocked'|'completed'|'cancelled';
export interface WorkItem {
  id:string;botId:string;scope:AttachmentScope;kind:WorkMode;objective:string;
  status:WorkStatus;createdBy:'user'|'bot';createdAt:string;updatedAt:string;
  sourceMessageId?:string;workspaceDir?:string;runIds:string[];activeRunId?:string;approvedAt?:string;
  plan?:TaskPlan;summary?:string;evidenceIds?:string[];reason?:string;
}
export interface WorkAction {id:string;action:'start'|'pause'|'cancel';}
export const workspaceKey=(scope:AttachmentScope)=>`${scope.kind}:${scope.id}`;
export const WORK_COMMANDS=[
  {name:'plan' as const,label:'制定计划',description:'先规划，确认后执行'},
  {name:'goal' as const,label:'执行目标',description:'持续工作，直到完成或遇到阻碍'}
];
export function workCommand(text:string):{kind:WorkMode;objective:string}|undefined {
  const match=/^\/(plan|goal)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match?{kind:match[1].toLowerCase() as WorkMode,objective:(match[2]||'').trim()}:undefined;
}
