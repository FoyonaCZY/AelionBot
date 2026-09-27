import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, errorCode } from '../shared/errors';

test('AppError carries a code and keeps the plain Error name', () => {
  const error = new AppError('bot.not_found', 'Bot 不存在');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'Error');
  assert.equal(String(error), 'Error: Bot 不存在');
  assert.equal(errorCode(error), 'bot.not_found');
  assert.throws(
    () => {
      throw error;
    },
    { code: 'bot.not_found' },
  );
});

test('errorCode ignores values without a string code', () => {
  assert.equal(errorCode(new Error('x')), undefined);
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' })), 'ENOENT');
  assert.equal(errorCode(null), undefined);
  assert.equal(errorCode('text'), undefined);
});
