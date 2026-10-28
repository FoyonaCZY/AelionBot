import { useEffect, useRef, type ReactNode } from 'react';
import type { UserProfile } from '../../shared/chat/user-profile';
import { Icon } from '../ui/Icon';
import { Emblem } from '../ui/Emblem';
import { useSwitchMotion } from '../ui/motion';
import { useI18n } from '../i18n';

export type SettingsTab =
  'appearance' | 'profile' | 'runtime' | 'model' | 'design' | 'usage' | 'memory' | 'computer' | 'permissions' | 'about';
type Page = { id: SettingsTab; label: string; icon: string };
/**
 * The pages, in the groups the rail shows them in. The rail stays neutral: line icons and one
 * selected row, so the page content carries the color and hierarchy.
 */
const groups: ReadonlyArray<{ label: string; pages: ReadonlyArray<Page> }> = [
  {
    label: '工作区',
    pages: [
      { id: 'model', label: '模型', icon: 'layers' },
      { id: 'memory', label: '记忆', icon: 'memory' },
      { id: 'design', label: '设计', icon: 'palette' },
    ],
  },
  {
    label: '系统',
    pages: [
      { id: 'appearance', label: '外观', icon: 'appearance' },
      { id: 'runtime', label: '运行', icon: 'sliders' },
      { id: 'computer', label: '电脑', icon: 'computer' },
      { id: 'permissions', label: '权限', icon: 'shield' },
      { id: 'usage', label: '用量', icon: 'chart' },
      { id: 'about', label: '关于', icon: 'info' },
    ],
  },
];
const profilePage: Page = { id: 'profile', label: '个人资料', icon: 'user' };

/** Hue of the accent, in the emblem's color space: your emblem is the purple your own bubbles are. */
const YOUR_HUE = 305;
/** Your emblem, drawn from the first letter of what Bots call you, so it holds still while you type the rest. */
export function ProfileEmblem({ name, size = 36 }: { name?: string; size?: number }) {
  return <Emblem seed={[...(name?.trim() || '')][0]?.toLocaleUpperCase() || ''} size={size} round hue={YOUR_HUE} />;
}

/** The app's mark (assets/icon.svg), shown at the top of the rail. */
function BotMark({ size }: { size: number }) {
  return (
    <svg className="settings-me-mark" width={size} height={size} viewBox="0 0 60 60" aria-hidden="true">
      <path d="M31 3C47 3 56 14 56 31C56 46 46 56 29 56C12 56 4 46 4 30C4 14 15 3 31 3Z" fill="#8b6bea" />
      <ellipse cx="24" cy="26" rx="2.5" ry="5" fill="#fff" transform="rotate(-14 24 26)" />
      <ellipse cx="36" cy="24" rx="2.5" ry="5" fill="#fff" transform="rotate(-14 36 24)" />
    </svg>
  );
}

export function SettingsWindow({
  tab,
  profile,
  onTabChange,
  onClose,
  children,
}: {
  tab: SettingsTab;
  profile?: UserProfile;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [tab]);
  useSwitchMotion(content, tab);
  const page =
    tab === 'profile'
      ? profilePage
      : groups.flatMap((group) => group.pages).find((item) => item.id === tab) || profilePage;
  return (
    <>
      <nav className="settings-rail" aria-label={t('设置分类')}>
        <button
          type="button"
          className={`settings-me ${tab === 'profile' ? 'active' : ''}`}
          aria-current={tab === 'profile' ? 'page' : undefined}
          onClick={() => onTabChange('profile')}
        >
          <BotMark size={36} />
          <span className="settings-me-copy">
            <strong>{profile?.displayName.trim() || t('个人资料')}</strong>
            {profile?.displayName.trim() && profile.role.trim() && <small>{profile.role.trim()}</small>}
          </span>
        </button>
        {groups.map((group) => (
          <div className="settings-nav-group" key={group.label}>
            <span className="settings-nav-title">{t(group.label)}</span>
            {group.pages.map((item) => (
              <button
                key={item.id}
                type="button"
                title={t(item.label)}
                className={`settings-nav-item ${tab === item.id ? 'active' : ''}`}
                aria-current={tab === item.id ? 'page' : undefined}
                onClick={() => onTabChange(item.id)}
              >
                <Icon name={item.icon} size={16} />
                <span className="settings-nav-label">{t(item.label)}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className={`settings-pane settings-pane-${tab}`}>
        <header className="settings-heading">
          <h2>{t(page.label)}</h2>
        </header>
        <button className="settings-close icon-button" aria-label={t('关闭对话框')} onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
        <div className={`settings-body settings-page-${tab}`} ref={content}>
          {children}
        </div>
      </div>
    </>
  );
}

/** A labelled group of settings; `aside` sits at the end of the label line (a count, a small action). */
export function SettingsSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function SettingsEmpty({
  icon = 'bot',
  title,
  description,
}: {
  icon?: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="settings-empty settings-empty-state">
      <span className="settings-empty-symbol" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
    </div>
  );
}
