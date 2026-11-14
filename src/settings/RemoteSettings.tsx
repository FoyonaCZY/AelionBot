import { useEffect, useState } from 'react';
import type { RemoteView } from '../../shared/types/remote-types';
import { SettingsEmpty, SettingsSection } from './SettingsWindow';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import { ipcErrorText } from '../ui/ipc-error';
import './remote-settings.css';

/** Settings → 手机访问: let phones reach this computer through the relay, pair them and manage them. */
export function RemoteSettings({ view, onNotify }: { view?: RemoteView; onNotify: (message: string) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(view?.name || '');
  const [relay, setRelay] = useState({ relayUrl: view?.customRelayUrl || '', appUrl: view?.customAppUrl || '' });
  useEffect(() => setName(view?.name || ''), [view?.name]);
  useEffect(
    () => setRelay({ relayUrl: view?.customRelayUrl || '', appUrl: view?.customAppUrl || '' }),
    [view?.customRelayUrl, view?.customAppUrl],
  );
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
  if (!view) return null;
  const status =
    view.status === 'online'
      ? t('已连接中继')
      : view.status === 'connecting'
        ? t('正在连接中继…')
        : view.status === 'error'
          ? t('连接中继失败：{issue}', { issue: view.issue || '' })
          : t('已关闭');
  const pairing = view.pairing;
  return (
    <>
      <SettingsSection title={t('手机访问')}>
        <div className="settings-card">
          <div className="settings-switch-row">
            <div className="settings-row-copy">
              <span>{t('允许手机连接这台电脑')}</span>
              <small className={`remote-status is-${view.status}`}>{status}</small>
            </div>
            <button
              role="switch"
              aria-label={t('允许手机连接这台电脑')}
              aria-checked={view.enabled}
              className={view.enabled ? 'learning-switch enabled' : 'learning-switch'}
              disabled={busy}
              onClick={() => act(() => window.aelion.saveRemoteSettings({ enabled: !view.enabled }))}
            >
              <i />
            </button>
          </div>
          <div className="settings-switch-row">
            <div className="settings-row-copy">
              <span>{t('开启时不让电脑睡眠')}</span>
              <small>{t('电脑睡眠后手机就连不上了；屏幕仍会按系统设置关闭。')}</small>
            </div>
            <button
              role="switch"
              aria-label={t('开启时不让电脑睡眠')}
              aria-checked={view.keepAwake}
              className={view.keepAwake ? 'learning-switch enabled' : 'learning-switch'}
              disabled={busy}
              onClick={() => act(() => window.aelion.saveRemoteSettings({ keepAwake: !view.keepAwake }))}
            >
              <i />
            </button>
          </div>
        </div>
        <p className="remote-note">
          {t(
            '连接经过端到端加密，中继服务器看不到内容。手机上不能修改模型、插件和 API Key，也不能把本机权限改成完全放行。',
          )}
        </p>
      </SettingsSection>

      {view.enabled && (
        <SettingsSection
          title={t('手机')}
          aside={
            !pairing && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy || view.status !== 'online'}
                onClick={() => act(() => window.aelion.startRemotePairing())}
              >
                <Icon name="plus" size={14} />
                {t('添加手机')}
              </button>
            )
          }
        >
          {pairing && (
            <div className="settings-card remote-pairing">
              {pairing.request ? (
                <div className="remote-request" role="alertdialog" aria-label={t('新手机请求连接')}>
                  <Icon name="shield" size={22} />
                  <p>{t('“{name}”请求连接这台电脑。确认是你自己的手机再允许。', { name: pairing.request.name })}</p>
                  <div className="remote-request-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => act(() => window.aelion.decideRemotePairing({ allow: false }))}
                    >
                      {t('拒绝')}
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy}
                      onClick={() => act(() => window.aelion.decideRemotePairing({ allow: true }))}
                    >
                      {t('允许')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="remote-qr">
                  <img alt={t('二维码')} src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg)}`} />
                  <div>
                    <strong>{t('用手机相机扫描二维码')}</strong>
                    <p>
                      {t(
                        '手机会打开 AelionBot 网页，按提示连接后，再在这里点“允许”。二维码 10 分钟内有效，只能用一次。',
                      )}
                    </p>
                    <p>{t('在 iPhone 上，连接后用 Safari 的“添加到主屏幕”，才能收到通知。')}</p>
                    <div className="remote-qr-actions">
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(pairing.url)
                            .then(() => onNotify(t('已复制配对链接，可以在手机上粘贴')))
                        }
                      >
                        {t('复制链接')}
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => act(() => window.aelion.cancelRemotePairing())}
                      >
                        {t('取消')}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {view.devices.length ? (
            <div className="settings-card">
              {view.devices.map((device) => (
                <div className="settings-switch-row remote-device" key={device.id}>
                  <Icon name="phone" size={18} />
                  <div className="settings-row-copy">
                    <span>{device.name}</span>
                    <small>
                      {device.online
                        ? t('在线')
                        : device.lastSeenAt
                          ? t('最后在线 {time}', { time: new Date(device.lastSeenAt).toLocaleString() })
                          : t('未连接')}
                      {device.push ? ' · ' + t('通知已开启') : ''}
                      {device.verify ? ' · ' + t('需要身份验证') : ''}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => act(() => window.aelion.removeRemoteDevice(device.id))}
                  >
                    {t('移除')}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            !pairing && <SettingsEmpty icon="phone" title={t('还没有连接手机')} />
          )}
        </SettingsSection>
      )}

      {view.enabled && (
        <SettingsSection title={t('这台电脑')}>
          <div className="settings-card">
            <label className="settings-row">
              <span>{t('名称')}</span>
              <input
                value={name}
                maxLength={60}
                disabled={busy}
                placeholder={view.name}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => name.trim() !== view.name && act(() => window.aelion.saveRemoteSettings({ name }))}
              />
            </label>
          </div>
        </SettingsSection>
      )}

      <SettingsSection title={t('中继')}>
        <form
          className="settings-card remote-relay"
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => window.aelion.saveRemoteSettings(relay));
          }}
        >
          <label className="settings-row">
            <span>{t('中继地址')}</span>
            <input
              value={relay.relayUrl}
              placeholder="https://relay.aelion.chat"
              disabled={busy}
              onChange={(event) => setRelay({ ...relay, relayUrl: event.target.value })}
            />
          </label>
          <label className="settings-row">
            <span>{t('手机网页地址')}</span>
            <input
              value={relay.appUrl}
              placeholder={relay.relayUrl || 'https://app.aelion.chat'}
              disabled={busy}
              onChange={(event) => setRelay({ ...relay, appUrl: event.target.value })}
            />
          </label>
          <div className="remote-relay-footer">
            <small>
              {t(
                '留空使用官方中继。自己部署的中继同时提供手机网页，部署方法见仓库里的 relay/README.md。换中继后手机需要重新配对。',
              )}
            </small>
            <button
              className="secondary-button"
              disabled={busy || (relay.relayUrl === view.customRelayUrl && relay.appUrl === view.customAppUrl)}
            >
              {t('保存')}
            </button>
          </div>
        </form>
      </SettingsSection>
    </>
  );
}
