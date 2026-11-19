import { useEffect } from 'react';
import type { HostComputerView } from '../../shared/types/permission-types';
import { SettingsSection } from './SettingsWindow';
import { useI18n } from '../i18n';

/**
 * Computer Use on this computer: the switch that offers it to Bots. Each task still asks before it starts. On macOS
 * the system must also let the app see and operate other apps, and the rows below say whether it does.
 */
export function HostComputerSettings({
  value,
  mac,
  busy,
  act,
}: {
  value: HostComputerView;
  mac: boolean;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const asks = mac && value.enabled;
  // The grants change in System Settings, outside the app: read them when the page opens and when the user returns.
  useEffect(() => {
    if (!asks) return;
    const check = () => void window.aelion.checkHostComputerPermissions().catch(() => {});
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [asks]);
  const grants = [
    { kind: 'accessibility' as const, granted: value.permissions?.accessibility, title: t('辅助功能') },
    { kind: 'screen' as const, granted: value.permissions?.screenRecording, title: t('屏幕录制') },
  ];
  return (
    <SettingsSection title={t('电脑控制')}>
      <div className="settings-card">
        <div className="settings-switch-row">
          <div className="settings-row-copy">
            <span>{t('让 Bot 操作这台电脑上的应用')}</span>
          </div>
          <button
            role="switch"
            aria-label={t('让 Bot 操作这台电脑上的应用')}
            aria-checked={value.enabled}
            className={value.enabled ? 'learning-switch enabled' : 'learning-switch'}
            disabled={busy}
            onClick={() => act(() => window.aelion.setHostComputerEnabled(!value.enabled))}
          >
            <i />
          </button>
        </div>
        {asks &&
          value.permissions &&
          grants.map((grant) => (
            <div className="settings-switch-row" key={grant.kind}>
              <div className="settings-row-copy">
                <span>{grant.title}</span>
                {grant.granted && <small>{t('已允许')}</small>}
              </div>
              {!grant.granted && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => act(() => window.aelion.checkHostComputerPermissions(grant.kind))}
                >
                  {t('去授权')}
                </button>
              )}
            </div>
          ))}
      </div>
    </SettingsSection>
  );
}
