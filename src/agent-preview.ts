import type {Attachment,AttachmentScope} from './attachment-types';

export interface AgentPreviewRequest {
  id:string;botId:string;runId:string;scope:AttachmentScope;
  placement:'side'|'full';name:string;size:number;createdAt:string;
  target:{kind:'workspace';path:string}|{kind:'attachment';file:Attachment}|{kind:'url';url:string;location:'host'|'vm'};
}
export function previewForConversation(requests:AgentPreviewRequest[],scope:AttachmentScope){
  return requests.find(request=>request.scope.kind===scope.kind&&request.scope.id===scope.id);
}
