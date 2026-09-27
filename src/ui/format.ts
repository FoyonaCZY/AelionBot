import { currentLanguage } from '../i18n';

export const time = (value: string) =>
  new Date(value).toLocaleTimeString(currentLanguage(), { hour: '2-digit', minute: '2-digit' });
export const bytes = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1048576
      ? `${Math.round(size / 102.4) / 10} KB`
      : `${Math.round(size / 104857.6) / 10} MB`;
