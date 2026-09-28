import test from 'node:test';
import assert from 'node:assert/strict';
import { validLanguage } from '../shared/i18n';
import { initializeI18n, currentLanguage, LANGUAGE_STORAGE_KEY } from '../src/i18n';
test('interface language initializes locally without model-language IPC', () => {
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'),
    beforeStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: () => {} } });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (key: string) => (key === LANGUAGE_STORAGE_KEY ? 'en' : null) },
    });
    assert.doesNotThrow(() => initializeI18n());
    assert.equal(currentLanguage(), 'en');
    assert.equal(validLanguage('invalid'), false);
  } finally {
    if (beforeWindow) Object.defineProperty(globalThis, 'window', beforeWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (beforeStorage) Object.defineProperty(globalThis, 'localStorage', beforeStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    initializeI18n();
  }
});
