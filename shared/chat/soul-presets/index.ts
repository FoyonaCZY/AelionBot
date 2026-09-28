// Starter SOUL.md files, shaped like the OpenClaw template (core truths, boundaries, vibe) and the Hermes guide's
// role souls. They are written per language because a soul's voice does not survive string-by-string translation.
import type { Language } from '../../i18n/interface-language';
import type { BotType } from '../../types/designer-types';
import { en } from './en';
import type { SoulPresetId } from './types';
import { zhCN } from './zh-CN';
import { zhTW } from './zh-TW';

const tables = { 'zh-CN': zhCN, 'zh-TW': zhTW, en };

/** Presets offered in the New Bot form for a Bot type. */
export function soulPresets(type: BotType, language: Language) {
  const ids: SoulPresetId[] = type === 'designer' ? ['designer'] : ['backend', 'data', 'writing', 'research'];
  return ids.map((id) => ({ id, ...tables[language][id] }));
}

/** The soul a Bot gets when it is created without one. */
export const defaultSoul = (type: BotType, language: Language = 'zh-CN') =>
  tables[language][type === 'designer' ? 'designer' : 'default'].soul;

/** Whether a soul or name is still untouched starter text, so switching type or preset may replace it. */
export const isStarterText = (text: string) =>
  !text.trim() ||
  Object.values(tables).some((table) =>
    Object.values(table).some((preset) => preset.soul === text || preset.name === text),
  );

export const defaultBotName = (language: Language = 'zh-CN') => tables[language].default.name;

// One-line roles the app itself used to fill in. Bots still carrying one get the matching starter soul.
const legacyDefaults: Record<string, [BotType, Language]> = {
  '帮助我处理办公资料与代码工作，直接执行并验证成果。': ['general', 'zh-CN'],
  '帮助我处理办公资料与代码工作，直接执行并验证成果，使用中文回复。': ['general', 'zh-CN'],
  '完成办公和代码任务，使用工作电脑实际执行并核对成果。': ['general', 'zh-CN'],
  '完成辦公與程式碼工作，使用工作電腦實際執行並核對成果。': ['general', 'zh-TW'],
  'Complete office and coding tasks using the work computer, then verify the result.': ['general', 'en'],
  '完成原型和可编辑演示文稿设计，遵循所选设计系统并验证成果。': ['designer', 'zh-CN'],
  'Create prototypes and editable presentations, follow the selected design system and verify deliverables.': [
    'designer',
    'en',
  ],
};

/** The starter soul replacing an app-generated legacy role, or undefined when the text is the user's own. */
export function upgradedLegacySoul(soul: string) {
  const legacy = legacyDefaults[soul.trim()];
  return legacy && defaultSoul(...legacy);
}
