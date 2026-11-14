// The phone app speaks the phone's language unless the user picked one (stored like the desktop does).
import { initializeI18n, LANGUAGE_STORAGE_KEY } from '../../src/i18n';

export function startI18n() {
  try {
    if (!localStorage.getItem(LANGUAGE_STORAGE_KEY)) {
      const language = (navigator.language || '').toLowerCase();
      localStorage.setItem(
        LANGUAGE_STORAGE_KEY,
        /^zh-(tw|hk|mo|hant)/.test(language) ? 'zh-TW' : language.startsWith('zh') ? 'zh-CN' : 'en',
      );
    }
  } catch {
    // Private mode without storage: the default language applies.
  }
  initializeI18n();
}
