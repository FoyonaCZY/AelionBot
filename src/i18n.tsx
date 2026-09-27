// Renderer i18n: persists the chosen language and exposes it to React.
// Translation tables and the pure translate functions live in shared/i18n.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setActiveLanguage, translate, validLanguage, type Language } from '../shared/i18n';

export { currentLanguage, translate, type Language } from '../shared/i18n';
export const LANGUAGE_STORAGE_KEY = 'aelion-language';

export const languageOptions: ReadonlyArray<{ value: Language; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
];

function readLanguage(): Language {
  if (typeof window === 'undefined') return 'zh-CN';
  try {
    const value = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return validLanguage(value) ? value : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}
function applyLanguage(language: Language) {
  setActiveLanguage(language);
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('aelion-language-change'));
}
function storeLanguage(language: Language) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {}
}
export function initializeI18n() {
  applyLanguage(readLanguage());
}

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (source: string, values?: Record<string, string | number>) => string;
}
const I18nContext = createContext<I18nContextValue>({
  language: 'zh-CN',
  setLanguage: (language) => {
    applyLanguage(language);
    storeLanguage(language);
  },
  t: translate,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readLanguage);
  useEffect(() => {
    applyLanguage(language);
  }, [language]);
  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    applyLanguage(next);
    storeLanguage(next);
  }, []);
  const value = useMemo(() => ({ language, setLanguage, t: translate }), [language, setLanguage]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
