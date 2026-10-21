import { useState } from 'react';
import type { Snapshot, WorkSession } from '../../shared/types/core';
import { CONNECTOR_PLATFORM_NAMES, type ConnectorView } from '../../shared/types/connector-types';
import { HOST_PERMISSION_MODES, type HostPermissionMode } from '../../shared/types/permission-types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
import { PluginDrawer, PluginSwitch, StatusDot } from './PluginDetails';
import { connectorStatusText } from './AddConnectorDialog';
import { ConnectorLogo } from './ConnectorLogo';
import { sinceText } from './plugin-visuals';

export function ConnectorDetails({
  state,
  connector,
  onClose,
  onOpenSession,
}: {
  state: Snapshot;
  connector?: ConnectorView;
  onClose: () => void;
  onOpenSession: (session: WorkSession) => void;
}) {
  const { t, language } = useI18n();
  const [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [confirmRemove, setConfirmRemove] = useState(false);
  const run = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await operation();
    } catch (e) {
      setError(ipcErrorText(e));
    } finally {
      setPending(false);
    }
  };
  if (!connector)
    return (
      <PluginDrawer label={t('连接器')} onClose={onClose}>
        <p className="subtle">{t('这个连接器已被删除。')}</p>
      </PluginDrawer>
    );
  const name = t(CONNECTOR_PLATFORM_NAMES[connector.platform]),
    sessions = (state.workSessions || [])
      .filter((session) => session.connector?.connectorId === connector.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    mode = HOST_PERMISSION_MODES.find((item) => item.id === connector.permissionMode) || HOST_PERMISSION_MODES[0],
    update = (input: Omit<Parameters<typeof window.aelion.updateConnector>[0], 'id'>) =>
      run(() => window.aelion.updateConnector({ id: connector.id, ...input }));
  return (
    <PluginDrawer
      label={name}
      onClose={onClose}
      aside={
        <label className="plugin-drawer-switch">
          {connector.enabled ? t('已启用') : t('已停用')}
          <PluginSwitch
            name={name}
            enabled={connector.enabled}
            disabled={pending}
            onChange={() => void update({ enabled: !connector.enabled })}
          />
        </label>
      }
      footer={
        confirmRemove ? (
          <>
            <span className="plugin-drawer-warning">{t('删除后不再收发消息，已有的会话会保留在 Bot 下面。')}</span>
            <button className="secondary-button" disabled={pending} onClick={() => setConfirmRemove(false)}>
              {t('取消')}
            </button>
            <button
              className="danger-button"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await window.aelion.removeConnector(connector.id);
                  onClose();
                })
              }
            >
              {t('确认删除')}
            </button>
          </>
        ) : (
          <>
            <button
              className="secondary-button"
              disabled={pending || !connector.enabled}
              onClick={() => void run(() => window.aelion.reconnectConnector(connector.id))}
            >
              <Icon name="restart" size={14} />
              {t('重新连接')}
            </button>
            <span className="plugin-drawer-spacer" />
            <button className="text-button danger-text" disabled={pending} onClick={() => setConfirmRemove(true)}>
              {t('删除连接器')}
            </button>
          </>
        )
      }
    >
      <header className="plugin-hero">
        <span className="connector-mark is-large">
          <ConnectorLogo platform={connector.platform} size={30} />
        </span>
        <div>
          <h2>
            {name}
            {connector.platform === 'weixin' && <span className="plugin-tag">{t('实验')}</span>}
          </h2>
          <p>
            <StatusDot status={connector.status} />
            {t(connectorStatusText(connector.status))}
            {connector.account && ' · ' + connector.account}
            {connector.lastMessageAt &&
              ' · ' + t('{time}有消息', { time: sinceText(connector.lastMessageAt, t, language) })}
          </p>
        </div>
      </header>
      {connector.issue && (
        <p className="computer-notice" role="alert">
          {connector.issue}
        </p>
      )}
      {connector.pairings.map((pairing) => (
        <div className="connector-pairing" key={pairing.code}>
          <div>
            <strong>
              {connector.owner
                ? t('{name} 想使用这个 Bot', { name: pairing.name || pairing.id })
                : t('{name} 想成为这个连接器的主人', { name: pairing.name || pairing.id })}
            </strong>
            <small>
              {t('配对码')} <code>{pairing.code}</code>
            </small>
          </div>
          <button
            className="secondary-button"
            disabled={pending}
            onClick={() =>
              void run(() =>
                window.aelion.decideConnectorPairing({ id: connector.id, code: pairing.code, allow: false }),
              )
            }
          >
            {t('拒绝')}
          </button>
          <button
            className="primary-button"
            disabled={pending}
            onClick={() =>
              void run(() =>
                window.aelion.decideConnectorPairing({ id: connector.id, code: pairing.code, allow: true }),
              )
            }
          >
            {connector.owner ? t('允许') : t('设为主人')}
          </button>
        </div>
      ))}
      <section className="plugin-group" aria-labelledby="connector-settings">
        <h3 id="connector-settings">{t('设置')}</h3>
        <div className="plugin-rows">
          <label>
            <span>
              {t('回复的 Bot')}
              <small>{t('收到的消息交给它处理')}</small>
            </span>
            <Select
              value={connector.botId}
              disabled={pending}
              onChange={(event) => void update({ botId: event.target.value })}
            >
              {state.bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span>
              {t('本机权限')}
              <small>{t('修改后会同步到这个连接器的所有会话；单个会话仍可再调整')}</small>
            </span>
            <Select
              value={connector.permissionMode}
              disabled={pending}
              title={t(mode.description)}
              onChange={(event) => void update({ permissionMode: event.target.value as HostPermissionMode })}
            >
              {HOST_PERMISSION_MODES.map((item) => (
                <option key={item.id} value={item.id}>
                  {t(item.label)}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </section>
      <section className="plugin-group" aria-labelledby="connector-people">
        <h3 id="connector-people">{t('可以使用的人')}</h3>
        <div className="plugin-rows">
          {connector.owner ? (
            <div>
              <span className="connector-person">{Array.from(connector.owner.name || connector.owner.id)[0]}</span>
              <span>
                {connector.owner.name || connector.owner.id}
                <small>{t('主人 · 审批卡片发给主人')}</small>
              </span>
            </div>
          ) : (
            <div>
              <span className="connector-person">
                <Icon name="user" size={14} />
              </span>
              <span>
                {t('等待配对')}
                <small>{t('第一个发消息并被你允许的人会成为主人')}</small>
              </span>
            </div>
          )}
          {connector.allowed.map((person) => (
            <div key={person.id}>
              <span className="connector-person">{Array.from(person.name || person.id)[0]}</span>
              <span>{person.name || person.id}</span>
              <button
                className="text-button"
                disabled={pending}
                onClick={() => void update({ removeAllowed: [person.id] })}
              >
                {t('移除')}
              </button>
            </div>
          ))}
        </div>
      </section>
      {sessions.length > 0 && (
        <section className="plugin-group" aria-labelledby="connector-sessions">
          <h3 id="connector-sessions">{t('会话')}</h3>
          <div className="plugin-rows">
            {sessions.map((session) => {
              const bot = state.bots.find((item) => item.id === session.botId);
              return (
                <button type="button" key={session.id} onClick={() => onOpenSession(session)}>
                  {bot ? <Avatar bot={bot} size={20} /> : <Icon name="message" size={16} />}
                  <span>
                    {session.name}
                    {session.archivedAt && <small>{t('已归档')}</small>}
                  </span>
                  <time dateTime={session.updatedAt}>{sinceText(session.updatedAt, t, language)}</time>
                  <Icon name="chevron" size={14} />
                </button>
              );
            })}
          </div>
        </section>
      )}
      {error && (
        <p className="computer-notice" role="alert">
          {error}
        </p>
      )}
    </PluginDrawer>
  );
}
