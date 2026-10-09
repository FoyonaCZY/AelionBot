import { isEmptyGroupReply } from '../../../shared/chat/group-empty-reply';
export const normalized = (value: string) => value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
export const hasSilenceMarker = (value: string) => isEmptyGroupReply(value) || /\[(?:群聊|表情)静默\]/.test(value);
