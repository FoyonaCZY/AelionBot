// The phone's settings: computers, notifications, Face ID, this phone's name, disconnecting.
import { useState } from 'react';
import type { NotifyPrefs } from '../../../shared/remote/protocol';
import { useI18n } from '../../../src/i18n';
import { connection, useConnection } from '../connection';
import { disablePush, enablePush, enableVerify, isIos, isStandalone, pushSupported, verifySupported } from '../device';
import { back, go, useEdgeBack } from '../router';
import { I } from '../icons';
import { statusText } from './Home';
import { timeLabel, toast } from '../ui';

export function Settings() {
  const { t } = useI18n();
  const { computers, computer, status, welcome, since } = useConnection();
  const [busy, setBusy] = useState(false);
  const edge = useEdgeBack();
  const device = welcome?.device;
  const ready = status === 'ready';
  const act = async (operation: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await operation();
      if (done) toast(done);
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const notify = (key: keyof NotifyPrefs) => (
    <button
      role="switch"
      aria-checked={Boolean(device?.notify[key])}
      className={'x-switch' + (device?.notify[key] ? ' is-on' : '')}
      disabled={busy || !ready || !device?.push}
      onClick={() => act(() => connection.call('device.update', { notify: { [key]: !device?.notify[key] } }))}
    />
  );
  return (
    <div
      className="st-screen"
      {...edge.handlers}
      style={edge.offset ? { transform: `translateX(${edge.offset}px)` } : undefined}
    >
      <header className="c-nav">
        <button className="x-round" aria-label={t('返回')} onClick={back}>
          <I name="back" size={26} stroke={2.2} />
        </button>
        <div className="c-title is-static">
          <b>{t('设置')}</b>
        </div>
        <span className="x-round" />
      </header>
      <div className="st-body">
        <div className="st-title">{t('电脑')}</div>
        <ul className="st-list">
          {computers.map((item) => {
            const current = item.room === computer?.room;
            return (
              <li key={item.room}>
                <button className="st-row" onClick={() => current || void connection.select(item.room)}>
                  <span className={'st-pc' + (current ? ' is-' + status : '')}>
                    <I name="computer" size={20} />
                    <i />
                  </span>
                  <span className="s-text">
                    <b>{item.name}</b>
                    <small>
                      {current
                        ? status === 'offline' && since
                          ? t('离线 · 最后在线 {time}', { time: timeLabel(since) })
                          : statusText(status, t) + (welcome ? ' · AelionBot ' + welcome.app : '')
                        : t('点一下切换')}
                    </small>
                  </span>
                  {current && <I name="check" size={20} stroke={2.2} />}
                </button>
              </li>
            );
          })}
          <li>
            <button className="st-row is-link" onClick={() => go('#/pair')}>
              <I name="qr" size={20} />
              <span className="s-text">
                <b>{t('添加电脑')}</b>
              </span>
            </button>
          </li>
        </ul>

        <div className="st-title">{t('通知')}</div>
        <ul className="st-list">
          <li className="st-row">
            <span className="s-text">
              <b>{t('这部手机接收通知')}</b>
              <small>
                {!pushSupported()
                  ? t('这个浏览器不支持通知')
                  : isIos() && !isStandalone()
                    ? t('先添加到主屏幕，再从主屏幕打开')
                    : device?.push
                      ? t('需要你处理或任务完成时提醒你')
                      : t('未开启')}
              </small>
            </span>
            <button
              role="switch"
              aria-checked={Boolean(device?.push)}
              className={'x-switch' + (device?.push ? ' is-on' : '')}
              disabled={busy || !ready || !pushSupported()}
              onClick={() =>
                act(
                  () => (device?.push ? disablePush() : enablePush().then(() => connection.call('push.test'))),
                  device?.push ? undefined : t('通知已开启'),
                )
              }
            />
          </li>
          <li className="st-row">
            <span className="s-text">
              <b>{t('需要批准或回答时')}</b>
            </span>
            {notify('requests')}
          </li>
          <li className="st-row">
            <span className="s-text">
              <b>{t('任务完成或失败')}</b>
              <small>{t('你在电脑前操作时不会提醒')}</small>
            </span>
            {notify('finished')}
          </li>
          <li className="st-row">
            <span className="s-text">
              <b>{t('自动化运行结果')}</b>
            </span>
            {notify('automations')}
          </li>
          <li className="st-row">
            <span className="s-text">
              <b>{t('通知里显示内容')}</b>
              <small>{t('关闭时只显示是哪个 Bot、什么事')}</small>
            </span>
            {notify('content')}
          </li>
        </ul>

        <div className="st-title">{t('安全')}</div>
        <ul className="st-list">
          <li className="st-row">
            <I name="lock" size={20} />
            <span className="s-text">
              <b>{t('打开时验证身份')}</b>
              <small>{t('用 Face ID、指纹或手机密码，电脑验证后才能使用')}</small>
            </span>
            <button
              role="switch"
              aria-checked={Boolean(device?.verify)}
              className={'x-switch' + (device?.verify ? ' is-on' : '')}
              disabled={busy || !ready || !verifySupported()}
              onClick={() =>
                act(async () => {
                  if (device?.verify) await connection.call('verify.disable');
                  else await enableVerify();
                })
              }
            />
          </li>
          {computer && (
            <li>
              <button
                className="st-row is-danger"
                disabled={busy}
                onClick={() => {
                  if (confirm(t('断开后要重新扫码才能再连接“{name}”。', { name: computer.name })))
                    void act(() => connection.removeComputer(computer.room));
                }}
              >
                <span className="s-text">
                  <b>{t('断开这台电脑')}</b>
                </span>
              </button>
            </li>
          )}
        </ul>
        <p className="st-note">
          {t('连接经过端到端加密，中继只转发密文。')}
          <br />
          {computer && t('中继：{host}', { host: new URL(computer.relay).host })}
          <br />
          AelionBot {__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}
