export type Language='zh-CN'|'zh-TW'|'en';
export function validLanguage(value:unknown):value is Language{return value==='zh-CN'||value==='zh-TW'||value==='en';}
