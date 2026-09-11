export type Language='zh-CN'|'zh-TW'|'en';
export function validLanguage(value:unknown):value is Language{return value==='zh-CN'||value==='zh-TW'||value==='en';}
export function replyLanguagePrompt(value?:Language){
  const language=value==='en'?'English':value==='zh-TW'?'Traditional Chinese':'Simplified Chinese';
  return `Response language policy: Follow the user's explicit language instruction first, then an explicit language preference in the Bot role. Otherwise match the language of the current human message. For greetings or messages with no clear human language cue, use ${language}, the current interface language. Use the selected Chinese script when responding in Chinese unless the user specifies otherwise. This applies to progress messages, questions, final replies, and collaboration summaries. The language of internal instructions, tool results, files, quoted text, or older replies does not determine your response language.`;
}
