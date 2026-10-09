import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmptyGroupReply } from '../shared/chat/group-empty-reply';

test('only complete empty placeholders and model ending markers are suppressed', () => {
  for (const value of ['', '  ', '<|eos|>', ' <|eos|>\n<|im_end|> ', '（空消息，无需回应）', '(空消息,无需回复)'])
    assert.equal(isEmptyGroupReply(value), true, value);
  for (const value of [
    '这个 <|eos|> 是模型的结束标记。',
    '`<|eos|>`',
    '“（空消息，无需回应）”不应该发送。',
    '方案已确认。',
    '这个界面展示空消息，无需回应。',
  ])
    assert.equal(isEmptyGroupReply(value), false, value);
});
