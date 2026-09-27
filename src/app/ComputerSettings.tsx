import type { Snapshot } from '../../shared/types/core';
import { ComputerStatus } from '../computer/ComputerSetup';
import { HostWorkspaceSettings } from '../settings/HostWorkspaceSettings';
import { SettingsSection } from '../settings/SettingsWindow';
import { VmStorageSettings } from '../settings/VmStorageSettings';
import { bytes } from '../ui/format';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';

/** The Computer settings tab: storage, host workspace, environment details and maintenance actions. */
export function ComputerSettings({
  state,
  busy,
  anyRunning,
  vmReady,
  desktopAvailable,
  act,
  onNotify,
  onSetup,
  onTerminal,
}: {
  state: Snapshot;
  busy: boolean;
  anyRunning: boolean;
  vmReady: boolean;
  desktopAvailable: boolean;
  act: (operation: () => Promise<unknown>) => Promise<void>;
  onNotify: (message: string) => void;
  onSetup: () => void;
  onTerminal: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <VmStorageSettings vm={state.vm} busy={anyRunning || busy} />
      {state.hostWorkspace && (
        <HostWorkspaceSettings
          settings={state.hostWorkspace}
          busy={busy || anyRunning}
          act={act}
          onSaved={() => onNotify(t('本机工作目录已保存'))}
        />
      )}
      <SettingsSection title={t('工作电脑')}>
        {desktopAvailable ? (
          <div className="settings-computer-title">
            <Icon name="computer" size={34} />
            <div>
              <strong>{t('Linux 工作电脑')}</strong>
              <p>{state.vm.detail}</p>
            </div>
          </div>
        ) : (
          <ComputerStatus vm={state.vm} onOpen={onSetup} />
        )}
      </SettingsSection>
      <SettingsSection title={t('环境信息')}>
        <dl className="settings-specs">
          <div>
            <dt>{t('应用环境')}</dt>
            <dd>{state.vm.appsReady ? 'Chrome · ' + t('文件管理器') + ' · ' + t('办公套件') : t('需要准备')}</dd>
          </div>
          <div>
            <dt>{t('桌面')}</dt>
            <dd>Aelion {t('桌面')} · Linux</dd>
          </div>
          <div>
            <dt>{t('资源')}</dt>
            <dd>4 GB RAM · 4 vCPU</dd>
          </div>
          <div>
            <dt>{t('工作磁盘文件')}</dt>
            <dd>{bytes(state.vm.diskBytes || 0)}</dd>
          </div>
        </dl>
      </SettingsSection>
      <SettingsSection title={t('维护')}>
        <div className="settings-maintenance">
          <button disabled={!vmReady || busy || anyRunning} onClick={onTerminal}>
            <Icon name="terminal" />
            {t('打开工作终端')}
            <Icon name="arrow" size={16} />
          </button>
          <button
            disabled={!vmReady || busy || anyRunning}
            onClick={() => act(() => window.aelion.vmAction('restart'))}
          >
            <Icon name="restart" />
            {t('重启电脑')}
            <Icon name="arrow" size={16} />
          </button>
          <button
            disabled={!vmReady || busy || anyRunning || state.vm.maintenance}
            onClick={() => act(() => window.aelion.vmAction('repair-tools'))}
          >
            <Icon name="settings" />
            {state.vm.maintenance ? t('正在准备工作环境…') : t('修复工作环境')}
            <Icon name="arrow" size={16} />
          </button>
          <button disabled={!vmReady || busy || anyRunning} onClick={() => act(() => window.aelion.vmAction('stop'))}>
            <Icon name="computer" />
            {t('关闭工作电脑')}
            <Icon name="arrow" size={16} />
          </button>
          <button onClick={() => act(() => window.aelion.openData())}>
            <Icon name="folder" />
            {t('打开本地数据目录')}
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </SettingsSection>
      {state.vm.lastError && <p className="computer-notice">{state.vm.lastError}</p>}
    </>
  );
}
