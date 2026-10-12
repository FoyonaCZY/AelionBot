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

test('a message that only announces the Bot is not speaking is silent', () => {
  for (const value of [
    '（不发言）',
    '(不发言)',
    '【保持沉默】',
    '[静默]',
    '*保持沉默*',
    '（这轮我先不插话）',
    '（无需我回复）',
    '(staying silent)',
    '*stays quiet*',
    '[no reply]',
    '不发言',
    '不发言。',
    '我这次就不发言了。',
    '保持沉默',
    '决定不发言',
    '本轮不回复。',
    '暂无补充。',
    'Nothing to add.',
    "I'll stay quiet.",
    '决定不发言，B 已经回答得很完整了。',
    'A 已经说清楚了，我就不重复了。',
    '不发言：问题已被回答',
    '(not speaking)',
    'I’m staying silent.',
    '我就不说了',
    '上面都讲过了，我也不补充了。',
    'B 已经回答了。\n（不发言）',
    '（不发言，B 已经回答了）',
  ])
    assert.equal(isEmptyGroupReply(value), true, value);
});

test('real answers that mention silence or skipping stay visible', () => {
  for (const value of [
    '沉默是金。',
    '保持沉默不是好办法，建议直接问用户。',
    '我先不发言，但要提醒：接口还没加鉴权。',
    '不发言的成员会在下一轮被提醒吗？',
    '@B 你来回答吧，我不重复了。',
    '测试结果：pass',
    'pass',
    'skip',
    '不用重复部署，只需重启服务即可。',
    '（补充：缓存失效时间是 5 分钟）',
    '（不发言，但提醒一下 token 快过期了）',
    '“（不发言）”这种占位文本不应该发到群里。',
    '如果用户取消，不回复。',
    '这个界面展示空消息，无需回应。',
    // Real content next to a quiet clause is never dropped.
    '部署要先跑迁移，其他 A 说过了，我不重复了。',
    '测试用例我已经补充了，就不多说了。',
    'B 已经回答了。',
    '（这个接口不回复 404）',
    '（不发言？）',
    '跳过登录页这一步会导致权限校验失败，需要先修复鉴权逻辑，再继续测试后面的流程。',
  ])
    assert.equal(isEmptyGroupReply(value), false, value);
});
