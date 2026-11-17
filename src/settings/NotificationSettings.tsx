import { useState } from 'react';
import { DEFAULT_DESKTOP_NOTIFY, type DesktopNotifySettings } from '../../shared/types/notification-types';
import { SettingsSection } from './SettingsWindow';
import { useI18n } from '../i18n';
import { ipcErrorText } from '../ui/ipc-error';

const EVENTS: Array<{ key: keyof DesktopNotifySettings; label: string }> = [
  { key: 'requests', label: 'Bot 等你批准或回答时' },
  { key: 'finished', label: '任务结束时' },
  { key: 'automations', label: '自动化运行结束时' },
];

/** Settings → 通知: which events show a system notification while the window is in the background. */
export function NotificationSettings({
  settings = DEFAULT_DESKTOP_NOTIFY,
  onNotify,
}: {
  settings?: DesktopNotifySettings;
  onNotify: (message: string) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      onNotify(ipcErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (key: keyof DesktopNotifySettings) =>
    act(() => window.aelion.saveDesktopNotify({ ...settings, [key]: !settings[key] }));
  const row = (key: keyof DesktopNotifySettings, label: string, note?: string) => (
    <div className="settings-switch-row" key={key}>
      <div className="settings-row-copy">
        <span>{label}</span>
        {note && <small>{note}</small>}
      </div>
      <button
        role="switch"
        aria-label={label}
        aria-checked={settings[key]}
        className={settings[key] ? 'learning-switch enabled' : 'learning-switch'}
        disabled={busy}
        onClick={() => toggle(key)}
      >
        <i />
      </button>
    </div>
  );
  return (
    <>
      <SettingsSection
        title={t('系统通知')}
        aside={
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act(async () => {
                if (!(await window.aelion.testDesktopNotify())) onNotify(t('这台电脑不支持系统通知'));
              })
            }
          >
            {t('发一条试试')}
          </button>
        }
      >
        <div className="settings-card">{EVENTS.map((item) => row(item.key, t(item.label)))}</div>
        <p className="settings-note">{t('窗口在前台时不通知。')}</p>
      </SettingsSection>
      <SettingsSection title={t('内容')}>
        <div className="settings-card">
          {row('content', t('显示消息内容'), t('关闭后只显示是哪个 Bot、发生了什么。'))}
        </div>
      </SettingsSection>
    </>
  );
}
