import { useState, useEffect } from 'react';
import { EMPTY_USER_PROFILE, normalizeUserProfile, type UserProfile } from '../../shared/chat/user-profile';
import { ProfileAvatar } from './SettingsWindow';
import { useI18n } from '../i18n';
export function UserProfileSettings({
  profile,
  onNotify,
}: {
  profile?: UserProfile;
  onNotify: (text: string) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<UserProfile>(profile || EMPTY_USER_PROFILE),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setValue(profile || EMPTY_USER_PROFILE);
  }, [profile?.displayName, profile?.role, profile?.background]);
  const save = async () => {
    if (saving) return;
    setError('');
    setSaving(true);
    try {
      await window.aelion.saveUserProfile(normalizeUserProfile(value));
      onNotify(t('个人资料已保存'));
    } catch (error) {
      setError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="profile-card">
        <div className="profile-identity">
          <ProfileAvatar name={value.displayName} size={64} />
          <div className="profile-identity-fields">
            <input
              className="profile-name"
              aria-label={t('希望 Bot 如何称呼你')}
              maxLength={80}
              value={value.displayName}
              disabled={saving}
              placeholder={t('希望 Bot 如何称呼你')}
              onChange={(event) => setValue({ ...value, displayName: event.target.value })}
            />
            <input
              className="profile-role"
              aria-label={t('身份或职业')}
              maxLength={200}
              value={value.role}
              disabled={saving}
              placeholder={t('身份或职业')}
              onChange={(event) => setValue({ ...value, role: event.target.value })}
            />
          </div>
        </div>
        <label className="profile-background">
          <span>{t('工作背景')}</span>
          <textarea
            className="settings-field"
            aria-label={t('工作背景')}
            rows={6}
            maxLength={3000}
            value={value.background}
            disabled={saving}
            placeholder={t('你的工作内容、经验和希望 Bot 了解的背景')}
            onChange={(event) => setValue({ ...value, background: event.target.value })}
          />
        </label>
        <footer className="profile-actions">
          <button
            type="button"
            className="text-button"
            disabled={saving}
            onClick={() => setValue({ ...EMPTY_USER_PROFILE })}
          >
            {t('清空资料')}
          </button>
          {error && (
            <p role="alert" className="provider-error">
              {error}
            </p>
          )}
          <button
            className="primary-button"
            disabled={saving || JSON.stringify(value) === JSON.stringify(profile || EMPTY_USER_PROFILE)}
          >
            {saving ? t('保存中…') : t('保存个人资料')}
          </button>
        </footer>
      </div>
    </form>
  );
}
