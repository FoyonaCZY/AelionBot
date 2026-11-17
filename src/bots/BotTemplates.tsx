import { useId } from 'react';
import type { BotPalette } from '../../shared/chat/bot-colors';
import { soulPresets } from '../../shared/chat/soul-presets';
import { Avatar } from '../ui/Avatar';
import { useI18n } from '../i18n';
import './bot-templates.css';

interface BotTemplate {
  name: string;
  soul: string;
  palette: BotPalette;
}

/**
 * The templates a new Bot can start from: each sets the name, the SOUL.md and the look, all of which stay editable.
 * The one whose SOUL.md the form still holds is marked; its one-line description shows under the grid.
 */
export function BotTemplates({
  soul,
  disabled,
  onPick,
  onImport,
}: {
  soul: string;
  disabled: boolean;
  onPick: (template: BotTemplate) => void;
  /** Starts a Bot from a Bot file instead. */
  onImport?: () => void;
}) {
  const { t, language } = useI18n();
  const label = useId(),
    templates = soulPresets(language),
    chosen = templates.find((item) => item.soul === soul);
  return (
    <div className="bot-templates">
      <div className="bot-templates-head">
        <span id={label}>{t('从模板开始')}</span>
        {onImport && (
          <button type="button" className="text-button" disabled={disabled} onClick={onImport}>
            {t('导入 Bot 文件')}
          </button>
        )}
      </div>
      <div className="bot-template-grid" role="radiogroup" aria-labelledby={label}>
        {templates.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={item === chosen}
            className={item === chosen ? 'bot-template is-chosen' : 'bot-template'}
            title={item.summary}
            disabled={disabled}
            onClick={() => onPick(item)}
          >
            <Avatar bot={{ name: item.name, ...item.palette }} size={24} />
            <strong>{item.name}</strong>
          </button>
        ))}
      </div>
      <p className="bot-template-summary">{chosen?.summary || ' '}</p>
    </div>
  );
}
