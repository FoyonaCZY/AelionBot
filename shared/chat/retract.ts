import type { ChatMessage, RunRecord } from '../types/core';

/** Something the user typed in the composer of a Bot's chat. */
const typedInChat = (message: ChatMessage) =>
  message.role === 'user' &&
  !message.reaction &&
  !message.scheduled &&
  !message.connector &&
  message.previewPrompt === undefined &&
  !message.previewMarks?.length &&
  !message.designSessionId &&
  !message.groupTaskSource &&
  !message.taskSource &&
  !message.peer;

/**
 * Whether a finished run's answer can be made again: it answered what the user typed in the Bot's chat (`inputs`, the
 * run's user messages), on its own rather than for a group, another Bot or a tracked task. The caller also checks that
 * nothing came after it in that chat.
 */
export function canRegenerate(run: RunRecord | undefined, inputs: ChatMessage[]) {
  return Boolean(
    run &&
    run.status !== 'running' &&
    !run.retracted &&
    !run.groupOrigin &&
    !run.peerOrigin &&
    !run.resumedFromRunId &&
    !run.workItemId &&
    !run.designSessionId &&
    inputs.length &&
    inputs.every(typedInChat),
  );
}

/**
 * Whether the user may take a message back to edit it: something they typed in a Bot's chat that is still waiting, or
 * whose task is still running there. Comments from a preview, scheduled prompts, emoji and messages from a connector
 * chat were not typed in the composer, so they have nothing to go back to.
 */
export function canRetract(message: ChatMessage, run: RunRecord | undefined) {
  if (!typedInChat(message)) return false;
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
