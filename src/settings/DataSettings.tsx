import { useCallback, useEffect, useState } from 'react';
import type { BackupInfo, BackupOverview, BackupProgress } from '../../shared/types/backup-types';
import { SettingsSection } from './SettingsWindow';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
import '../app/updates.css';
import './data-settings.css';

const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${Math.round(bytes / 1024 ** 3 / 0.1) / 10} GB`
    : bytes >= 1024 ** 2
      ? `${Math.round(bytes / 1024 ** 2)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const when = (value: string) => new Date(value).toLocaleString();

/** Settings → 数据: back the app's data up to one file, restore it from one, and look after what a restore replaced. */
export function DataSettings({ onNotify }: { onNotify: (message: string) => void }) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<BackupOverview>(),
    [panel, setPanel] = useState<'export' | 'restore'>(),
    [password, setPassword] = useState(''),
    [repeat, setRepeat] = useState(''),
    [picked, setPicked] = useState<BackupInfo>(),
    [skipSecrets, setSkipSecrets] = useState(false),
    [progress, setProgress] = useState<BackupProgress | null>(null),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState(''),
    [removing, setRemoving] = useState('');
  const refresh = useCallback(
    () =>
      window.aelion
        .backupOverview()
        .then(setOverview)
        .catch(() => {}),
    [],
  );
  useEffect(() => void refresh(), [refresh]);
  // A backup or a restore keeps running when the page is left; coming back shows it again.
  useEffect(() => {
    let alive = true,
      running = false;
    const poll = async () => {
      const next = await window.aelion.backupProgress().catch(() => null);
      if (!alive) return;
      setProgress(next);
      if (running && !next) void refresh();
      running = Boolean(next);
    };
    void poll();
    const timer = setInterval(() => void poll(), 400);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const close = () => {
    setPanel(undefined);
    setPassword('');
    setRepeat('');
    setPicked(undefined);
    setSkipSecrets(false);
    setIssue('');
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setIssue('');
    try {
      await operation();
    } catch (error) {
      setIssue(t(ipcErrorText(error)));
    } finally {
      setBusy(false);
    }
  };
  const exportBackup = () =>
    run(async () => {
      if (password !== repeat) throw Error(t('两次输入的密码不一样'));
      const saved = await window.aelion.exportBackup(password ? { password } : {});
      if (!saved) return;
      close();
      onNotify(t('备份已保存到 {path}', { path: saved.path }));
    });
  const pick = () =>
    run(async () => {
      const info = await window.aelion.pickBackup();
      if (!info) return;
      close();
      setPicked(info);
      setPanel('restore');
    });
  const restore = () =>
    run(async () => {
      if (!picked) return;
      await window.aelion.restoreBackup({
        id: picked.id,
        ...(picked.secrets && !skipSecrets ? { password } : {}),
        ...(skipSecrets ? { skipSecrets: true } : {}),
      });
    });
  const working = busy || Boolean(progress);
  const percent = progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  return (
    <>
      <SettingsSection
        title={t('备份')}
        aside={
          overview?.lastRestore && (
            <small>
              {overview.lastRestore.ok
                ? t('上次恢复：{time}', { time: when(overview.lastRestore.at) })
                : t('上次恢复没有完成')}
            </small>
          )
        }
      >
        <div className="settings-card">
          <div className="settings-switch-row">
            <div className="settings-row-copy">
              <span>{t('导出备份')}</span>
              <small>
                {overview
                  ? t('对话、Bot、记忆、附件和设置，约 {size}', { size: size(overview.bytes) })
                  : t('对话、Bot、记忆、附件和设置')}
              </small>
            </div>
            <button
              type="button"
              className="secondary-button"
              disabled={working}
              onClick={() => {
                const open = panel !== 'export';
                close();
                if (open) setPanel('export');
              }}
            >
              {t('导出备份')}
            </button>
          </div>
          {panel === 'export' && !progress && (
            <form
              className="data-panel"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) void exportBackup();
              }}
            >
              <label className="settings-row">
                <span>{t('密码（可选）')}</span>
                <input
                  type="password"
                  autoFocus
                  autoComplete="new-password"
                  maxLength={256}
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {password && (
                <label className="settings-row">
                  <span>{t('再输一次密码')}</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    maxLength={256}
                    value={repeat}
                    disabled={busy}
                    onChange={(event) => setRepeat(event.target.value)}
                  />
                </label>
              )}
              <div className="data-panel-footer">
                <small className={issue ? 'is-error' : undefined} role={issue ? 'alert' : undefined}>
                  {issue || t('设了密码，API Key 和登录信息会一起备份。不设密码，这些只能在这台电脑上恢复。')}
                </small>
                <button type="button" className="secondary-button" disabled={busy} onClick={close}>
                  {t('取消')}
                </button>
                <button type="submit" className="primary-button" disabled={busy}>
                  {t('选择位置并导出')}
                </button>
              </div>
            </form>
          )}
          <div className="settings-switch-row">
            <div className="settings-row-copy">
              <span>{t('从备份恢复')}</span>
              <small>{t('用备份替换这台电脑上现在的数据')}</small>
            </div>
            <button type="button" className="secondary-button" disabled={working} onClick={() => void pick()}>
              {t('选择备份文件')}
            </button>
          </div>
          {panel === 'restore' && picked && !progress && (
            <form
              className="data-panel"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) void restore();
              }}
            >
              <p className="data-backup-info">
                <strong>{picked.name}</strong>
                <span>
                  {t('{time} · 来自 {device} · 版本 {version} · {size}', {
                    time: when(picked.createdAt),
                    device: picked.device || t('未知电脑'),
                    version: picked.appVersion,
                    size: size(picked.bytes),
                  })}
                </span>
              </p>
              {picked.secrets && (
                <>
                  <label className="settings-row">
                    <span>{t('备份密码')}</span>
                    <input
                      type="password"
                      autoFocus
                      autoComplete="off"
                      maxLength={256}
                      value={password}
                      disabled={busy || skipSecrets}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  <label className="data-check">
                    <input
                      type="checkbox"
                      checked={skipSecrets}
                      disabled={busy}
                      onChange={(event) => setSkipSecrets(event.target.checked)}
                    />
                    {t('不恢复 API Key 和登录信息')}
                  </label>
                </>
              )}
              <div className="data-panel-footer">
                <small className={issue ? 'is-error' : undefined} role={issue ? 'alert' : undefined}>
                  {issue || t('现在的数据会保留一份。应用会重启，正在进行的任务会停止。')}
                </small>
                <button type="button" className="secondary-button" disabled={busy} onClick={close}>
                  {t('取消')}
                </button>
                <button
                  type="submit"
                  className="danger-button"
                  disabled={busy || (picked.secrets && !skipSecrets && !password)}
                >
                  {t('恢复并重启')}
                </button>
              </div>
            </form>
          )}
          {progress && (
            <div className="data-progress" role="status">
              <div className="data-progress-head">
                <span>{progress.kind === 'export' ? t('正在导出备份…') : t('正在读取备份…')}</span>
                <button type="button" className="text-button" onClick={() => void window.aelion.cancelBackup()}>
                  {t('取消')}
                </button>
              </div>
              <div
                className="update-progress"
                role="progressbar"
                aria-label={progress.kind === 'export' ? t('正在导出备份…') : t('正在读取备份…')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div style={{ width: percent + '%' }} />
              </div>
              <div className="update-progress-detail">
                <span>
                  {size(progress.done)}
                  {progress.total > 0 ? ` / ${size(progress.total)}` : ''}
                </span>
                <span>{percent}%</span>
              </div>
            </div>
          )}
        </div>
        {issue && !panel && (
          <p className="data-issue" role="alert">
            {issue}
          </p>
        )}
        <p className="settings-note">{t('工作文件夹里的文件和工作电脑不在备份里。换电脑后，工作电脑需要重新准备。')}</p>
      </SettingsSection>

      {overview && overview.copies.length > 0 && (
        <SettingsSection title={t('恢复前的数据')}>
          <div className="settings-card">
            {overview.copies.map((copy) => (
              <div className="settings-switch-row" key={copy.id}>
                <div className="settings-row-copy">
                  <span>{t('{time} 被替换的数据', { time: when(copy.createdAt) })}</span>
                  <small title={copy.path}>
                    <bdi>{copy.path}</bdi>
                  </small>
                </div>
                <div className="data-copy-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={working}
                    onClick={() => void run(() => window.aelion.openBackupCopy(copy.id))}
                  >
                    {t('打开文件夹')}
                  </button>
                  <button
                    type="button"
                    className={removing === copy.id ? 'text-button is-danger' : 'text-button'}
                    disabled={working}
                    onBlur={() => setRemoving('')}
                    onClick={() =>
                      removing === copy.id
                        ? void run(async () => {
                            await window.aelion.removeBackupCopy(copy.id);
                            setRemoving('');
                            await refresh();
                          })
                        : setRemoving(copy.id)
                    }
                  >
                    {removing === copy.id ? t('确认删除') : t('删除')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SettingsSection>
      )}
    </>
  );
}
