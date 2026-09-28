import type { Bot, Snapshot } from '../../shared/types/core';
import { DesignerWorkspace } from '../designer/DesignerWorkspace';
import type { TakeoverRequest } from './use-computer-control';

/** A design session opened from a task card elsewhere, shown over the current conversation. */
export function DesignerTaskDrawer({
  taskId,
  state,
  onProfile,
  onTakeover,
  onClose,
}: {
  taskId: string;
  state: Snapshot;
  onProfile: (owner: Bot) => void;
  onTakeover: (request: TakeoverRequest) => Promise<void>;
  onClose: () => void;
}) {
  const task = state.designer?.sessions.find((s) => s.id === taskId),
    owner = state.bots.find((b) => b.id === task?.botId);
  return task && owner ? (
    <div
      className="modal-backdrop designer-task-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="designer-task-drawer" role="dialog" aria-modal="true" aria-label={task.title}>
        <DesignerWorkspace
          key={task.id}
          bot={owner}
          state={state}
          initialSessionId={task.id}
          onProfile={() => onProfile(owner)}
          onTakeover={onTakeover}
          onClose={onClose}
        />
      </section>
    </div>
  ) : null;
}
