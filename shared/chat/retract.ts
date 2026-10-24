import type { ChatMessage, RunRecord } from '../types/core';

/**
 * Whether the user may take a message back to edit it: something they typed in a Bot's chat that is still waiting, or
 * whose task is still running there. Comments from a preview, scheduled prompts, emoji and messages from a connector
 * chat were not typed in the composer, so they have nothing to go back to.
 */
export function canRetract(message: ChatMessage, run: RunRecord | undefined) {
  if (
    message.role !== 'user' ||
    message.reaction ||
    message.scheduled ||
    message.connector ||
    message.previewPrompt !== undefined ||
    message.previewMarks?.length ||
    message.designSessionId ||
    message.groupTaskSource ||
    message.taskSource ||
    message.peer
  )
    return false;
  if (!message.runId) return message.inputState === 'queued';
  return (
    run?.id === message.runId &&
    run.status === 'running' &&
    !run.retracted &&
    !run.groupOrigin &&
    !run.peerOrigin &&
    !run.resumedFromRunId &&
    !run.workItemId
  );
}
