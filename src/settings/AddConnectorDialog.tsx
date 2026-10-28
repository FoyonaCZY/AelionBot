import { useEffect, useRef, useState } from 'react';
import type { Bot, Snapshot } from '../../shared/types/core';
import {
  CONNECTOR_PLATFORM_NAMES,
  type ConnectorPlatform,
  type ConnectorStatus,
} from '../../shared/types/connector-types';
import {
  DEFAULT_HOST_PERMISSION_MODE,
  HOST_PERMISSION_MODES,
  type HostPermissionMode,
} from '../../shared/types/permission-types';
import { Select } from '../ui/Select';
import { ConnectorLogo } from './ConnectorLogo';
import { ipcErrorText } from '../ui/ipc-error';
import { useSwitchMotion } from '../ui/motion';
import { useI18n } from '../i18n';
import './connectors.css';

export function connectorStatusText(status: ConnectorStatus) {
  return status === 'connected'
    ? '已连接'
    : status === 'connecting'
      ? '连接中'
      : status === 'displaced'
        ? '已在其他设备连接'
        : status === 'needs-config'
          ? '需要配置'
          : status === 'disabled'
            ? '已停用'
            : '连接失败';
}

/** The Bot and permission mode a new connector uses. */
function ConnectorFields({
  bots,
  botId,
  mode,
  disabled,
  onBot,
  onMode,
}: {
  bots: Bot[];
  botId: string;
  mode: HostPermissionMode;
  disabled?: boolean;
  onBot: (id: string) => void;
  onMode: (mode: HostPermissionMode) => void;
}) {
  const { t } = useI18n();
  const current = HOST_PERMISSION_MODES.find((item) => item.id === mode) || HOST_PERMISSION_MODES[0];
  return (
    <div className="connector-fields">
      <label>
        <span>{t('回复的 Bot')}</span>
        <Select value={botId} disabled={disabled} onChange={(event) => onBot(event.target.value)}>
          {bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </Select>
      </label>
      <label>
        <span>{t('本机权限')}</span>
        <Select
          value={mode}
          disabled={disabled}
          title={t(current.description)}
          onChange={(event) => onMode(event.target.value as HostPermissionMode)}
        >
          {HOST_PERMISSION_MODES.map((item) => (
            <option key={item.id} value={item.id}>
              {t(item.label)}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}

const FEISHU_SCOPES = 'im:message、im:message.p2p_msg:readonly、im:message:send_as_bot、im:resource';

export function AddConnectorDialog({
  state,
  initialPlatform = 'feishu',
  onClose,
  onCreated,
}: {
  state: Snapshot;
  initialPlatform?: ConnectorPlatform;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useI18n();
  const [platform, setPlatform] = useState<ConnectorPlatform>(initialPlatform),
    [method, setMethod] = useState<'scan' | 'manual'>('scan'),
    [botId, setBotId] = useState(state.bots[0]?.id || ''),
    [mode, setMode] = useState<HostPermissionMode>(DEFAULT_HOST_PERMISSION_MODE),
    [first, setFirst] = useState(''),
    [second, setSecond] = useState(''),
    [verifyCode, setVerifyCode] = useState(''),
    [setupId, setSetupId] = useState(''),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const setup = state.connectors?.setups.find((item) => item.id === setupId);
  const scanning = platform === 'weixin' || (platform === 'feishu' && method === 'scan');
  const dialog = useRef<HTMLDivElement>(null);
  useSwitchMotion(dialog, platform + ':' + method, ':scope > :is(.connector-scan, .connector-manual)');
  useEffect(() => {
    if (setup?.phase === 'done' && setup.connectorId) onCreated(setup.connectorId);
  }, [setup?.phase, setup?.connectorId]);
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
  const reset = () => {
    if (setupId) void window.aelion.cancelConnectorSetup(setupId);
    setSetupId('');
    setError('');
    setFirst('');
    setSecond('');
  };
  const close = () => {
    if (setupId && setup?.phase !== 'done') void window.aelion.cancelConnectorSetup(setupId);
    onClose();
  };
  const startScan = () =>
    run(async () => {
      if (setupId) await window.aelion.cancelConnectorSetup(setupId);
      setSetupId(
        await window.aelion.startConnectorSetup({
          platform: platform as 'feishu' | 'weixin',
          botId,
          permissionMode: mode,
        }),
      );
    });
  const addManual = () =>
    run(async () => {
      const id = await window.aelion.addConnector({
        botId,
        permissionMode: mode,
        credentials:
          platform === 'feishu'
            ? { platform: 'feishu', appId: first, appSecret: second }
            : { platform: 'wecom', botId: first, secret: second },
      });
      onCreated(id);
    });
  const phaseText =
    setup?.phase === 'starting'
      ? t('正在生成二维码…')
      : setup?.phase === 'waiting'
        ? platform === 'feishu'
          ? t('用飞书扫码，按提示创建应用')
          : t('用微信扫码，按提示确认')
        : setup?.phase === 'scanned'
          ? t('已扫码，请在手机上确认')
          : setup?.phase === 'verify-code'
            ? t('输入手机微信上显示的数字')
            : setup?.phase === 'done'
              ? t('已连接')
              : '';
  return (
    <div
      className="mcp-snippet-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) close();
      }}
    >
      <div
        ref={dialog}
        className="mcp-snippet-dialog connector-dialog"
        role="dialog"
        aria-labelledby="connector-dialog-title"
      >
        <h2 id="connector-dialog-title">{t('添加连接器')}</h2>
        <div className="connector-platforms" role="group" aria-label={t('平台')}>
          {(['feishu', 'wecom', 'weixin'] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={platform === item}
              disabled={pending}
              onClick={() => {
                reset();
                setPlatform(item);
              }}
            >
              <ConnectorLogo platform={item} size={16} />
              {t(CONNECTOR_PLATFORM_NAMES[item])}
              {item === 'weixin' && <small>{t('实验')}</small>}
            </button>
          ))}
        </div>
        <ConnectorFields
          bots={state.bots}
          botId={botId}
          mode={mode}
          disabled={pending || Boolean(setupId)}
          onBot={setBotId}
          onMode={setMode}
        />
        {platform === 'feishu' && (
          <div className="connector-methods" role="group" aria-label={t('连接方式')}>
            <button type="button" aria-pressed={method === 'scan'} onClick={() => (reset(), setMethod('scan'))}>
              {t('扫码创建')}
            </button>
            <button type="button" aria-pressed={method === 'manual'} onClick={() => (reset(), setMethod('manual'))}>
              {t('填写凭证')}
            </button>
          </div>
        )}
        {scanning ? (
          <div className="connector-scan">
            {!setup ? (
              <p>
                {platform === 'feishu'
                  ? t('用飞书扫码后，会自动创建一个飞书应用并连接到这个 Bot。扫码的人就是连接器的主人。')
                  : t('用微信扫码，把你的微信连接到这个 Bot。这是实验功能，依赖微信 ClawBot 插件，可能被微信限制。')}
              </p>
            ) : setup.phase === 'failed' ? (
              <p className="mcp-snippet-error" role="alert">
                {setup.message}
              </p>
            ) : (
              <div className="connector-qr">
                {setup.qrSvg && setup.phase !== 'done' && (
                  <img alt={t('二维码')} src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} />
                )}
                <p role="status">{phaseText}</p>
                {setup.message && <p className="mcp-snippet-error">{setup.message}</p>}
                {setup.phase === 'verify-code' && (
                  <div className="connector-verify">
                    <input
                      inputMode="numeric"
                      aria-label={t('验证数字')}
                      value={verifyCode}
                      onChange={(event) => setVerifyCode(event.target.value)}
                    />
                    <button
                      className="primary-button"
                      disabled={pending || !verifyCode.trim()}
                      onClick={() => void run(() => window.aelion.answerConnectorSetup({ id: setup.id, verifyCode }))}
                    >
                      {t('确认')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="connector-manual">
            <ol>
              {platform === 'feishu' ? (
                <>
                  <li>{t('在飞书开放平台创建企业自建应用，添加“机器人”能力。')}</li>
                  <li>{t('在“权限管理”里开通：{scopes}', { scopes: FEISHU_SCOPES })}</li>
                  <li>{t('把 App ID 和 App Secret 填在下面并添加，等状态变成“已连接”。')}</li>
                  <li>
                    {t(
                      '回到开放平台：“事件与回调”里，事件和回调都选“使用长连接接收”，添加事件 im.message.receive_v1 和回调 card.action.trigger。',
                    )}
                  </li>
                  <li>{t('创建版本并发布应用，然后在飞书里给机器人发消息，按提示确认配对码。')}</li>
                </>
              ) : (
                <>
                  <li>{t('在企业微信“工作台 → 智能机器人”创建机器人，切换到 API 模式，连接方式选“使用长连接”。')}</li>
                  <li>{t('把 BotID 和 Secret 填在下面并添加。')}</li>
                  <li>{t('在企业微信里给机器人发一条消息，按提示在这里确认配对码。')}</li>
                </>
              )}
            </ol>
            {platform === 'feishu' && (
              <button
                type="button"
                className="text-button"
                onClick={() => void window.aelion.openExternalUrl('https://open.feishu.cn/app')}
              >
                {t('打开飞书开放平台')}
              </button>
            )}
            <label>
              <span>{platform === 'feishu' ? 'App ID' : 'BotID'}</span>
              <input value={first} spellCheck={false} onChange={(event) => setFirst(event.target.value)} />
            </label>
            <label>
              <span>{platform === 'feishu' ? 'App Secret' : 'Secret'}</span>
              <input
                type="password"
                value={second}
                spellCheck={false}
                onChange={(event) => setSecond(event.target.value)}
              />
            </label>
          </div>
        )}
        {error && (
          <p className="mcp-snippet-error" role="alert">
            {error}
          </p>
        )}
        <div className="mcp-snippet-actions">
          <button className="secondary-button" type="button" disabled={pending} onClick={close}>
            {t('取消')}
          </button>
          {scanning ? (
            <button className="primary-button" disabled={pending || !botId} onClick={() => void startScan()}>
              {setup ? t('重新生成') : t('生成二维码')}
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={pending || !botId || !first.trim() || !second.trim()}
              onClick={() => void addManual()}
            >
              {t('添加')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
