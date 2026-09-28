// Agent preview requests are created in the main process and shown by the renderer.
import type { Attachment, AttachmentScope } from '../types/attachment-types';

export interface AgentPreviewRequest {
  designSessionId?: string;
  id: string;
  botId: string;
  runId: string;
  scope: AttachmentScope;
  placement: 'side' | 'full';
  name: string;
  size: number;
  createdAt: string;
  target:
    | { kind: 'workspace'; path: string }
    | { kind: 'attachment'; file: Attachment }
    | { kind: 'url'; url: string; location: 'host' | 'vm' };
}
export interface PreviewHistoryEntry {
  id: string;
  botId: string;
  runId: string;
  scope: AttachmentScope;
  name: string;
  size: number;
  createdAt: string;
  acknowledgedAt: string;
  target: AgentPreviewRequest['target'];
}
