import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupEventPrompt,
  groupMustAnswerNote,
  groupReviewNote,
  GROUP_STATE_EVENT_PROMPT,
} from '../electron/core/group/group-prompt';
test('group instructions stay English without imposing a reply language', () => {
  const prompt =
    groupEventPrompt('Team', 'g', 'Bot', [], ['Build a project.']) +
    GROUP_STATE_EVENT_PROMPT +
    groupReviewNote('draft', []) +
    groupMustAnswerNote([]);
  // No Chinese at all: silence is ending without text, not a marker the model has to write.
  assert.doesNotMatch(prompt, /[㐀-鿿]/);
  assert.doesNotMatch(prompt, /response language|interface language|latestHumanMessage/i);
});
