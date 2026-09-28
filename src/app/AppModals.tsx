import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { Bot, Snapshot } from '../../shared/types/core';
import { WorkspaceFileTree } from '../files/WorkspaceFileTree';
import { usePreviewWorkbench } from '../preview/PreviewWorkbench';
import { AppearanceSettings } from '../settings/AppearanceSettings';
import { RuntimeSettings } from '../settings/RuntimeSettings';
import { UsageSettings } from '../settings/UsageSettings';
import { SettingsWindow, type SettingsTab } from '../settings/SettingsWindow';
import { CommandPermissionsSettings } from '../settings/CommandPermissionsSettings';
import { UserProfileSettings } from '../settings/UserProfileSettings';
import { ModelSettings } from '../settings/ModelSettings';
import { AboutSettings } from '../settings/AboutSettings';
import { ComputerSetup } from '../computer/ComputerSetup';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { Vnc } from '../ui/Vnc';
import { useI18n } from '../i18n';
import { ComputerSettings } from './ComputerSettings';
import { MemorySettings } from './MemorySettings';
import type { useAppearance } from './use-appearance';
import type { useComputerControl } from './use-computer-control';
import type { PreviewFile } from './use-file-actions';

export type Modal =
  | 'new'
  | 'profile'
  | 'switch-type'
  | 'delete-bot'
  | 'settings'
  | 'computer'
  | 'computer-setup'
  | 'terminal'
  | 'files'
  | 'screen'
  | null;

/** The dialog layer: bot profile, settings, work computer, terminal, file browser and screenshot views. */
export function AppModals({
  modal,
  setModal,
  closeModal,
  act,
  busy,
  state,
  bot,
  computer,
  profileForm,
  saveProfile,
  deletingBot,
  removeBot,
  settingsTab,
  setSettingsTab,
  scope,
  setScope,
  appearance,
  command,
  setCommand,
  output,
  setOutput,
  screen,
  openPreview,
  setToast,
}: {
  modal: Exclude<Modal, null>;
  setModal: (modal: Modal) => void;
  closeModal: () => Promise<void>;
  act: (operation: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
  state: Snapshot;
  bot?: Bot;
  computer: ReturnType<typeof useComputerControl>;
  /** The create/edit Bot form; the caller renders it while `modal` is 'new' or 'profile'. */
  profileForm: ReactNode;
  saveProfile: (confirmContextReset?: boolean) => Promise<void>;
  deletingBot?: Bot;
  removeBot: () => Promise<void>;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  scope: string;
  setScope: (id: string) => void;
  appearance: ReturnType<typeof useAppearance>;
  command: string;
  setCommand: (command: string) => void;
  output: string;
  setOutput: Dispatch<SetStateAction<string>>;
  screen: string;
  openPreview: (file: PreviewFile) => void;
  setToast: (message: string) => void;
}) {
  const { t } = useI18n(),
    previewWorkbench = usePreviewWorkbench();
  const { vmReady, desktopBot, desktop, controlled, takeover, controlPending, computerAction, toggleComputerControl } =
    computer;
  const anyRunning = state.runs.some((run) => run.status === 'running') || false;
  const title =
    modal === 'switch-type'
      ? t('切换 Bot 类型？')
      : modal === 'computer-setup'
        ? t('工作电脑设置')
        : modal === 'settings'
          ? t('设置')
          : modal === 'new'
            ? t('创建新 Bot')
            : modal === 'profile'
              ? t('Bot 资料')
              : modal === 'delete-bot'
                ? t('删除 Bot')
                : modal === 'terminal'
                  ? t('工作终端')
                  : modal === 'files'
                    ? `${bot?.name || 'Bot'} ${t('的文件')}`
                    : modal === 'screen'
                      ? t('操作截图')
                      : t('工作电脑');
  return (
    <div
      className={`modal-backdrop ${modal === 'settings' ? 'settings-backdrop' : modal === 'computer' ? 'computer-backdrop' : modal === 'screen' ? 'wide-backdrop' : ''}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void act(closeModal);
      }}
    >
      <section
        className={`modal ${modal === 'computer-setup' ? 'computer-setup-modal' : modal === 'settings' ? 'settings-modal' : modal === 'profile' || modal === 'new' ? 'bot-profile-modal' : modal === 'computer' ? 'computer-modal' : modal === 'screen' ? 'preview-modal' : modal === 'terminal' ? 'terminal-modal' : modal === 'files' ? 'file-browser-modal' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {modal !== 'computer' && modal !== 'settings' && (
          <header>
            <h2>{title}</h2>
            <div className="modal-header-actions">
              <button className="icon-button" aria-label={t('关闭对话框')} onClick={() => void act(closeModal)}>
                <Icon name="close" />
              </button>
            </div>
          </header>
        )}
        {modal === 'computer-setup' && (
          <ComputerSetup
            vm={state.vm}
            bot={bot}
            disabled={anyRunning}
            onClose={() => void closeModal()}
            onReady={() => setModal('computer')}
            onNotify={setToast}
          />
        )}
        {profileForm}
        {modal === 'switch-type' && (
          <div className="delete-bot-confirmation">
            <p>{t('切换 Bot 类型将永久清空这个 Bot 的所有上下文，包括对话、记忆、任务历史和设计会话。')}</p>
            <p>{t('工作文件、已安装插件、群成员关系与共享聊天记录会保留。此操作无法撤销。')}</p>
            <div className="dialog-actions">
              <button className="secondary-button" autoFocus disabled={busy} onClick={() => setModal('profile')}>
                {t('取消')}
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => previewWorkbench?.navigate(() => void act(() => saveProfile(true)))}
              >
                {t('清空上下文并切换')}
              </button>
            </div>
          </div>
        )}
        {modal === 'delete-bot' && deletingBot && (
          <div className="delete-bot-confirmation">
            <p>{t('删除“{name}”及其对话和记忆？工作文件和私聊记录会保留。', { name: deletingBot.name })}</p>
            <div className="dialog-actions">
              <button className="secondary-button" autoFocus disabled={busy} onClick={() => setModal(null)}>
                {t('取消')}
              </button>
              <button className="danger-button" disabled={busy} onClick={() => void removeBot()}>
                {busy ? t('正在删除…') : t('删除 Bot')}
              </button>
            </div>
          </div>
        )}
        {modal === 'settings' && (
          <SettingsWindow tab={settingsTab} onTabChange={setSettingsTab} onClose={() => void act(closeModal)}>
            {settingsTab === 'appearance' && <AppearanceSettings {...appearance} />}
            {settingsTab === 'profile' && <UserProfileSettings profile={state.userProfile} onNotify={setToast} />}
            {settingsTab === 'runtime' && <RuntimeSettings settings={state.runtime} onNotify={setToast} />}
            {settingsTab === 'model' && <ModelSettings state={state} onNotify={setToast} />}
            {settingsTab === 'usage' && <UsageSettings state={state} />}
            {settingsTab === 'memory' && (
              <MemorySettings state={state} bot={bot} scope={scope} onScope={setScope} busy={busy} act={act} />
            )}
            {settingsTab === 'computer' && (
              <ComputerSettings
                state={state}
                busy={busy}
                anyRunning={anyRunning}
                vmReady={vmReady}
                desktopAvailable={computer.desktopAvailable}
                act={act}
                onNotify={setToast}
                onSetup={() => setModal('computer-setup')}
                onTerminal={() => {
                  setOutput('');
                  setModal('terminal');
                }}
              />
            )}
            {settingsTab === 'permissions' && (
              <CommandPermissionsSettings rules={state.commandPermissions || []} busy={busy} act={act} />
            )}
            {settingsTab === 'about' && <AboutSettings update={state.updates} onNotify={setToast} />}
          </SettingsWindow>
        )}

        {modal === 'terminal' && (
          <>
            <form
              className="terminal-input"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  setOutput(t('正在执行…'));
                  try {
                    const result = await window.aelion.vmTerminal(command);
                    setOutput(
                      `${result.stdout}${result.stderr ? '\n' + result.stderr : ''}\n\n${t('退出码')} ${result.exitCode} · ${result.durationMs} ms`,
                    );
                  } catch (error) {
                    setOutput(ipcErrorText(error));
                    throw error;
                  }
                });
              }}
            >
              <input value={command} onChange={(event) => setCommand(event.target.value)} spellCheck={false} />
              <button className="primary-button" disabled={busy}>
                {t('运行')}
              </button>
            </form>
            <pre className="terminal-output">{output}</pre>
          </>
        )}
        {modal === 'computer' && (
          <>
            <div className="expanded-screen">
              <Vnc key={desktopBot?.id} url={vmReady ? desktop?.vncUrl : undefined} control={controlled} />
            </div>
            <div className="computer-floating-controls">
              <span className="desktop-owner">{desktopBot?.name}</span>
              <button
                className="computer-control"
                aria-pressed={controlled}
                disabled={!vmReady || desktop?.status !== 'ready' || controlPending}
                onClick={toggleComputerControl}
              >
                {controlled ? (takeover?.phase === 'controlling' ? t('交还并继续') : t('交还控制')) : t('接管电脑')}
              </button>
              <button
                className="computer-close icon-button"
                aria-label={t('退出全屏')}
                title={t('退出全屏')}
                disabled={controlPending}
                onClick={() => void computerAction(closeModal)}
              >
                <Icon name="close" />
              </button>
            </div>
          </>
        )}
        {modal === 'files' && (
          <>
            {bot && vmReady ? (
              <WorkspaceFileTree botId={bot.id} onOpen={(file) => void openPreview({ ...file, botId: bot.id })} />
            ) : (
              <div className="settings-empty">{t('启动工作电脑后，可以浏览当前 Bot 的完整目录。')}</div>
            )}
          </>
        )}

        {modal === 'screen' && (
          <img className="artifact-image screen-full" src={screen} alt={t('Bot 操作后的工作电脑截图')} />
        )}
      </section>
    </div>
  );
}
