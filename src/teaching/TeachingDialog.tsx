import { useEffect, useState } from 'react';
import type { TeachingListWindowsResult, TeachingTarget } from '../../shared/types/teaching-types';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import './teaching.css';

export function TeachingDialog({
  botName,
  hostWindows,
  loadingWindows,
  vmReady,
  desktopAvailable,
  speechAvailable,
  onRefreshWindows,
  onOpenSettings,
  onOpenComputerSetup,
  onStart,
  onClose,
}: {
  botName: string;
  hostWindows: TeachingListWindowsResult;
  loadingWindows: boolean;
  vmReady: boolean;
  desktopAvailable: boolean;
  speechAvailable: boolean;
  onRefreshWindows: () => void;
  onOpenSettings: (tab: 'model' | 'permissions') => void;
  onOpenComputerSetup: () => void;
  onStart: (options: { target: TeachingTarget; windowId?: number | null; withMic: boolean }) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState<TeachingTarget>(hostWindows.available ? 'host' : 'vm');
  const [windowId, setWindowId] = useState<string>('follow');
  const [withMic, setWithMic] = useState<boolean>(speechAvailable);

  useEffect(() => {
    if (!hostWindows.available && target === 'host') setTarget('vm');
  }, [hostWindows.available, target]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canStart =
    target === 'host' ? hostWindows.available && !hostWindows.permissionIssue : vmReady && desktopAvailable;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal teaching-setup-modal" role="dialog" aria-modal="true" aria-label={t('演示操作')}>
        <header>
          <h2>{t('演示给 {name} 学技能', { name: botName })}</h2>
          <div className="modal-header-actions">
            <button type="button" className="icon-button" aria-label={t('关闭对话框')} onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        <div className="teaching-body">
          <div className="teaching-segmented" role="group" aria-label={t('演示目标')}>
            <button
              type="button"
              aria-pressed={target === 'host'}
              disabled={!hostWindows.available}
              onClick={() => setTarget('host')}
            >
              <Icon name="computer" size={16} />
              <span>{t('这台电脑')}</span>
            </button>
            <button type="button" aria-pressed={target === 'vm'} onClick={() => setTarget('vm')}>
              <Icon name="layers" size={16} />
              <span>{t('工作电脑')}</span>
            </button>
          </div>

          {target === 'host' ? (
            <div className="teaching-field">
              <div className="teaching-field-head">
                <label htmlFor="teaching-host-window">{t('演示窗口')}</label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('刷新窗口列表')}
                  title={t('刷新窗口列表')}
                  disabled={loadingWindows}
                  onClick={onRefreshWindows}
                >
                  <Icon name="restart" size={15} />
                </button>
              </div>
              {hostWindows.permissionIssue ? (
                <div className="teaching-notice" role="alert">
                  <span>{hostWindows.permissionIssue}</span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      onClose();
                      onOpenSettings('permissions');
                    }}
                  >
                    {t('去授权')}
                  </button>
                </div>
              ) : (
                <div className="teaching-window-row">
                  <select
                    id="teaching-host-window"
                    className="aelion-select"
                    value={windowId}
                    onChange={(event) => setWindowId(event.target.value)}
                  >
                    <option value="follow">{t('跟随当前活动窗口')}</option>
                    {hostWindows.windows.map((win) => (
                      <option key={win.id} value={String(win.id)}>
                        {win.app} — {win.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          ) : (
            <div className="teaching-vm-status">
              <span>{vmReady && desktopAvailable ? t('工作电脑桌面已就绪') : t('工作电脑尚未启动')}</span>
              {(!vmReady || !desktopAvailable) && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    onClose();
                    onOpenComputerSetup();
                  }}
                >
                  {t('打开工作电脑')}
                </button>
              )}
            </div>
          )}

          <div className="teaching-toggle-row">
            <label className="teaching-toggle-label">
              <input type="checkbox" checked={withMic} onChange={(event) => setWithMic(event.target.checked)} />
              <span>{t('边演示边讲解')}</span>
            </label>
            {speechAvailable ? (
              <span className="teaching-status-pill is-ok">{t('自动转文字时间轴')}</span>
            ) : (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  onClose();
                  onOpenSettings('model');
                }}
              >
                {t('配置语音识别')}
              </button>
            )}
          </div>
        </div>
        <div className="teaching-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            {t('取消')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!canStart}
            onClick={() =>
              onStart({
                target,
                windowId: target === 'host' && windowId !== 'follow' ? Number(windowId) : null,
                withMic,
              })
            }
          >
            {t('开始演示')}
          </button>
        </div>
      </section>
    </div>
  );
}
