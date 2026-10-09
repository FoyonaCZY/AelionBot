import { useRef, useState, type KeyboardEvent } from 'react';
import type { DesignerSnapshot, DesignSystemSummary } from '../../shared/types/designer-types';
import { useI18n } from '../i18n';
import { DesignSystemsTab } from './DesignSystemsTab';
import { DesignFontsTab } from './DesignFontsTab';
import './design-settings.css';

const NO_SYSTEMS: DesignSystemSummary[] = [];
const SECTIONS = [
  { id: 'systems', label: '设计系统' },
  { id: 'fonts', label: '字体' },
] as const;
type Section = (typeof SECTIONS)[number]['id'];

/**
 * Resources a Bot can draw on when it designs: the design-system library and the user's font library. Nothing
 * here steers a task; the Bot picks a system (or none) and the fonts, and asks when it is unclear.
 */
export function DesignSettings({
  designer,
  onNotify,
}: {
  designer?: DesignerSnapshot;
  onNotify: (text: string) => void;
}) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>('systems');
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = (index + (event.key === 'ArrowRight' ? 1 : SECTIONS.length - 1)) % SECTIONS.length;
    setSection(SECTIONS[next].id);
    tabs.current[next]?.focus();
  };
  return (
    <div className="design-settings">
      <div className="design-tabs" role="tablist" aria-label={t('设计页分区')}>
        {SECTIONS.map((item, index) => (
          <button
            key={item.id}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={'design-tab-' + item.id}
            aria-controls={'design-panel-' + item.id}
            aria-selected={section === item.id}
            tabIndex={section === item.id ? 0 : -1}
            onClick={() => setSection(item.id)}
            onKeyDown={(event) => move(event, index)}
          >
            {item.id === 'systems' ? t('设计系统') : t('字体')}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={'design-panel-' + section} aria-labelledby={'design-tab-' + section}>
        {section === 'systems' ? (
          <DesignSystemsTab systems={designer?.systems || NO_SYSTEMS} onNotify={onNotify} />
        ) : (
          <DesignFontsTab onNotify={onNotify} />
        )}
      </div>
    </div>
  );
}
