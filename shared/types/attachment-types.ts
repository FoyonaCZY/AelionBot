import type { ScreenReference } from './core';
export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  image?: ScreenReference;
}
export type AttachmentScope = { kind: 'bot' | 'group'; id: string };
export interface StoredAttachment extends Attachment {
  createdAt: string;
  sha256: string;
  sourcePath?: string;
  draftScope?: AttachmentScope;
  ownerBotId?: string;
}
export interface AttachmentUpload {
  name: string;
  bytes: Uint8Array;
}
export interface DroppedAttachment {
  id: string;
  name: string;
  kind: 'file' | 'directory';
}
export interface PreparedAttachmentDrop {
  entries: DroppedAttachment[];
  virtualIndexes: number[];
}
export const ATTACHMENT_LIMITS = { count: 10, fileBytes: 25 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 } as const;
export const attachmentSummary = (attachments?: Attachment[]) =>
  attachments?.length ? attachments.map((file) => `[附件] ${file.name}`).join('、') : '';
const trimmed = new WeakMap<object, { key: string; value: object }>();
/**
 * The messages of a history that show fewer attachments than they hold, mapped to the copy the chat shows: a file an
 * earlier assistant message already delivered appears only there. One pass over the history; a trimmed copy is reused
 * while its message and what it leaves out stay the same, so memoized rows keep skipping renders.
 */
export function firstDeliveries<T extends { id: string; role?: string; attachments?: Attachment[] }>(history: T[]) {
  const seen = new Set<string>(),
    shown = new Map<T, T>();
  for (const message of history) {
    const files = message.attachments;
    if (!files?.length) continue;
    const kept = files.filter((file) => !seen.has(file.id));
    if (kept.length !== files.length) {
      const key = kept.map((file) => file.id).join('\u0000');
      let copy = trimmed.get(message);
      if (copy?.key !== key) trimmed.set(message, (copy = { key, value: { ...message, attachments: kept } }));
      shown.set(message, copy.value as T);
    }
    if (message.role === 'assistant') for (const file of files) seen.add(file.id);
  }
  return shown;
}
