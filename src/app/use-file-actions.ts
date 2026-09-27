import type { Snapshot } from '../../shared/types/core';
import type { GroupSummary } from '../../shared/types/group-types';
import type { PreviewHistoryEntry } from '../../shared/preview/agent-preview-types';
import { previewItemFromEntry } from '../preview/agent-preview';
import { useFilePreview } from '../preview/FilePreviewContext';
import type { FileItem } from '../ui/FileCard';
import { useI18n } from '../i18n';

export type PreviewFile = FileItem & { botId: string };

/** Opening and saving bot workspace files and preview history entries from a conversation. */
export function useFileActions(input: {
  state?: Snapshot;
  group?: GroupSummary;
  clearModal: () => void;
  openComputer: (botId: string) => void;
  act: (operation: () => Promise<unknown>) => Promise<void>;
  onNotify: (message: string) => void;
}) {
  const { state, group, clearModal, openComputer, act, onNotify } = input;
  const { t } = useI18n(),
    showPreview = useFilePreview()!;
  const openPreview = (file: PreviewFile) => {
    clearModal();
    showPreview(
      [
        {
          id: 'artifact:' + file.botId + ':' + file.path,
          name: file.name,
          size: file.size,
          workspace: { botId: file.botId, path: file.path },
          load: () => window.aelion.previewFile({ botId: file.botId, path: file.path }),
          save: () => window.aelion.exportFile({ botId: file.botId, path: file.path }),
          ...(state?.bots.find((b) => b.id === file.botId)?.type !== 'designer' &&
          !state?.computer.desktops?.[file.botId]?.ownerBotId
            ? {
                openInComputer: async () => {
                  await window.aelion.openFile({ botId: file.botId, path: file.path });
                  openComputer(file.botId);
                },
              }
            : {}),
        },
      ],
      0,
      { scope: group ? { kind: 'group', id: group.id } : { kind: 'bot', id: file.botId } },
    );
  };
  const saveFile = (file: PreviewFile) =>
    act(async () => {
      const path = await window.aelion.exportFile({ botId: file.botId, path: file.path });
      if (path) onNotify(`${t('已保存：')}${path}`);
    });
  const openHistoryEntry = (entry: PreviewHistoryEntry) => {
    clearModal();
    const item = previewItemFromEntry(entry);
    item.designSessionId = state?.runs.find((run) => run.id === entry.runId)?.designSessionId;
    showPreview([item], 0, {
      scope:
        entry.scope.kind === 'group'
          ? entry.scope
          : group
            ? { kind: 'group', id: group.id }
            : { kind: 'bot', id: entry.botId },
    });
  };
  return { openPreview, saveFile, openHistoryEntry };
}
