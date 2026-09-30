import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupEventPrompt,
  groupMustAnswerNote,
  groupReviewNote,
  GROUP_STATE_EVENT_PROMPT,
  GROUP_UNSENT_NOTE,
} from '../electron/core/group/group-prompt';
test('group instructions stay English without imposing a reply language', () => {
  const prompt =
    groupEventPrompt('Team', 'g', 'Bot', [], ['Build a project.']) +
    GROUP_STATE_EVENT_PROMPT +
    groupReviewNote('draft', []) +
    groupMustAnswerNote([]) +
    GROUP_UNSENT_NOTE;
  assert.doesNotMatch(prompt.replaceAll('[群聊静默]', ''), /[㐀-鿿]/);
  assert.doesNotMatch(prompt, /response language|interface language|latestHumanMessage/i);
});
