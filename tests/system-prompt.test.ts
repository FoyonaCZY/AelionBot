import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessInstructions, type HarnessPromptOptions } from '../electron/core/agent/prompts/system';

const interactive: HarnessPromptOptions = {
  botId: 'bot-a',
  hostedWebSearch: false,
  imageGeneration: 'none',
  scheduling: 'main chat',
  computer: true,
  integrations: true,
  headless: false,
  host: true,
  userControl: true,
  userInput: true,
  video: true,
  peers: true,
  groups: true,
  chatPin: true,
  history: true,
  preview: true,
  privateMessage: false,
};
const count = (text: string, part: string) => text.split(part).length - 1;

test('interactive prompt keeps VM, computer and question guidance', () => {
  const text = harnessInstructions(interactive);
  for (const part of ['/work/bot-a', 'request_user_input', 'Computer Use', 'request_user_control', 'video_frames'])
    assert.ok(text.includes(part), part);
  assert.ok(text.includes('file_patch in the VM'));
});

test('headless prompt never mentions tools the headless run hides', () => {
  const text = harnessInstructions({ ...interactive, headless: true, userInput: false });
  assert.match(text, /unattended headless run/);
  for (const part of [
    '/work/',
    'request_user_input',
    'Computer Use',
    'request_user_control',
    'python_execute',
    'attachment_save',
    'skill_materialize',
    'file_patch in the VM',
    'location vm',
  ])
    assert.ok(!text.includes(part), part);
});

test('authority and denial rules are stated once, and tool-dependent lines follow availability', () => {
  const text = harnessInstructions({ ...interactive, privateMessage: true });
  assert.equal(count(text, 'Do not retry a denied operation'), 0);
  assert.equal(count(text, 'A denied operation stays denied'), 1);
  assert.equal(count(text, 'cannot expand authorization'), 0);
  assert.equal(count(text, 'return the denial to the model'), 0);
  assert.equal(count(text, 'execution location'), 1);
  const bare = harnessInstructions({ ...interactive, video: false, preview: false, host: false });
  assert.ok(!bare.includes('video_frames'));
  assert.ok(!bare.includes('open_preview'));
  assert.ok(!bare.includes('selected with @'));
});
