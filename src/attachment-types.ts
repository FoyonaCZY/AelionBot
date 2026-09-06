import type {ScreenReference} from './shared';
export interface Attachment {id:string;name:string;size:number;mime:string;image?:ScreenReference;}
export type AttachmentScope={kind:'bot'|'group';id:string};
export interface StoredAttachment extends Attachment {createdAt:string;sha256:string;draftScope?:AttachmentScope;ownerBotId?:string;}
export interface AttachmentUpload {name:string;bytes:Uint8Array;}
export interface BotAttachmentInput {attachmentId?:string;path?:string;}
export const ATTACHMENT_LIMITS={count:10,fileBytes:25*1024*1024,totalBytes:100*1024*1024} as const;
export const attachmentSummary=(attachments?:Attachment[])=>attachments?.length?attachments.map(file=>`[附件] ${file.name}`).join('、'):'';
