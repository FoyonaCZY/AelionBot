import type { AttachmentScope } from '../../shared/types/attachment-types';
import type { AgentPreviewRequest, PreviewHistoryEntry } from '../../shared/preview/agent-preview-types';
import type { PreviewItem } from './FilePreviewContext';
import { workspacePreviewItem } from './workspace-preview';
import { sourceTextFile } from '../../shared/preview/source-language';

export function previewForConversation(requests: AgentPreviewRequest[], scope: AttachmentScope) {
  return requests.find((request) => request.scope.kind === scope.kind && request.scope.id === scope.id);
}
export function previewItemFromEntry(entry: PreviewHistoryEntry): PreviewItem {
  const target = entry.target;
  if (target.kind === 'url')
    return {
      id: 'web:' + entry.id,
      directoryBotId: entry.botId,
      name: entry.name,
      size: 0,
      load: async () => ({
        kind: 'web',
        web: { kind: 'url', url: target.url, location: target.location, botId: entry.botId },
      }),
    };
  if (target.kind === 'workspace')
    return workspacePreviewItem(entry.botId, { name: entry.name, path: target.path, size: entry.size });
  const file = target.file;
  return {
    id: 'attachment:' + file.id,
    name: file.name,
    size: file.size,
    load: () => window.aelion.previewAttachment(file.id),
    save: () => window.aelion.saveAttachment(file.id),
    ...(sourceTextFile(file.name) ? { editor: { read: () => window.aelion.readEditableAttachment(file.id) } } : {}),
  };
}
