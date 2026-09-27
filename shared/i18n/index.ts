// Framework-free translation core shared by the renderer and the main process.
// Keys are the zh-CN source strings; other languages map them to translations.
import type { Language } from './interface-language';
import { en } from './locales/en';
import { zhTW } from './locales/zh-TW';

export type { Language } from './interface-language';
export { validLanguage } from './interface-language';

export const translationTables: Record<Language, Record<string, string>> = { 'zh-CN': {}, 'zh-TW': zhTW, en };

let activeLanguage: Language = 'zh-CN';

export function currentLanguage(): Language {
  return activeLanguage;
}
export function setActiveLanguage(language: Language) {
  activeLanguage = language;
}

export function translateFor(language: Language, source: string, values: Record<string, string | number> = {}): string {
  const translated = translationTables[language][source] ?? source;
  return translated.replace(/\{(\w+)\}/g, (_, key: string) =>
    values[key] === undefined ? `{${key}}` : String(values[key]),
  );
}
export function translate(source: string, values: Record<string, string | number> = {}): string {
  return translateFor(activeLanguage, source, values);
}
