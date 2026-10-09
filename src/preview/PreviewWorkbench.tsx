import { createContext, useContext } from 'react';
import type { AttachmentScope } from '../../shared/types/attachment-types';
import type { BotMention } from '../../shared/types/peer-types';
import type { PreviewAnnotation } from '../../shared/types/preview-editor-types';
export interface PreviewChatInput {
  text: string;
  mentions?: BotMention[];
  replyToMessageId?: string;
  attachmentIds?: string[];
  edits?: import('../../shared/types/preview-editor-types').DomEdit[];
  /** The chat it is sent from, when that is not the preview's own: a work session shares its Bot's previews. */
  scope?: AttachmentScope;
}
export interface PreviewWorkbenchInfo {
  scope?: AttachmentScope;
  itemId: string;
  name: string;
  docked: boolean;
  annotations: PreviewAnnotation[];
}
/** Lets the conversation composer show and remove the preview's marks as chips. */
export interface PreviewAnnotationControls {
  remove: (id: string) => void;
  select: (id: string) => void;
}
export interface PreviewWorkbench {
  info?: PreviewWorkbenchInfo;
  activate: (scope?: AttachmentScope) => void;
  navigate: (action: () => void) => void;
  close: () => void;
  update: (info: PreviewWorkbenchInfo) => void;
  registerSender: (sender: (input: PreviewChatInput) => Promise<unknown>) => () => void;
  send: (scope: AttachmentScope, input: PreviewChatInput) => Promise<boolean>;
  registerAnnotations: (controls: PreviewAnnotationControls) => () => void;
  annotations?: PreviewAnnotationControls;
}
export const WorkbenchContext = createContext<PreviewWorkbench | undefined>(undefined);
export const usePreviewWorkbench = () => useContext(WorkbenchContext);
