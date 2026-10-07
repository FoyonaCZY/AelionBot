import './conversation-chrome.css';
// Import order below decides the order of the bundled stylesheets (the cascade), so keep it when editing.
import { DesignerTaskDrawer } from './DesignerTaskDrawer';
import { usePreviewWorkbench } from '../preview/PreviewWorkbench';
import { useAgentPreview } from '../preview/use-agent-preview';
import { useAppearance } from './use-appearance';
import { useEffect, useMemo, useState } from 'react';
import { FilePreviewProvider, PreviewScopeProvider } from '../preview/FilePreviewContext';
import type { Bot, InteractionRequest } from '../../shared/types/core';
import { ipcErrorText } from '../ui/ipc-error';
import { PluginsPage, type PluginFilter } from '../settings/PluginsPage';
import type { SettingsTab } from '../settings/SettingsWindow';
import { AppModals, type Modal } from './AppModals';
import { ComputerDetails } from './ComputerDetails';
import { BotProfileForm } from './BotProfileForm';
import { ConversationPane } from './ConversationPane';
import { Sidebar } from './Sidebar';
import { computerSetupDismissalKey } from '../computer/computer-setup-state';
import { BotContextMenu, type BotMenuAnchor } from '../bots/BotContextMenu';
import { InteractionNotifications } from '../chat/InteractionPrompts';
import { PeerNotifications, PrivateChatWindow, type PeerPanel } from '../group/PeerChats';
import { GroupEditor } from '../group/GroupEditor';
import { GroupNotifications } from '../group/GroupNotifications';
import { BotAvatarProvider } from '../bots/BotAvatarContext';
import { botActivities } from '../bots/bot-activity';
import { useWindowDimming } from './window-dimming';
import { I18nProvider, useI18n } from '../i18n';
import { botConversation } from './bot-conversation';
import { useAppSnapshot } from './use-app-snapshot';
import { useBotChat } from './use-bot-chat';
import { useBotProfile } from './use-bot-profile';
import { useComputerControl, type TakeoverRequest } from './use-computer-control';
import { useComputerSetupOffer } from './use-computer-setup-offer';
import { useDesignTask } from './use-design-task';
import { useDismissableMenu } from './use-dismissable-menu';
import { useDrafts } from './use-drafts';
import { useFileActions } from './use-file-actions';
import { useMessageFollow } from './use-message-follow';
import { useModalEffects } from './use-modal-effects';
import { useToast } from './use-toast';
import { StreamsProvider, useStreamOwners } from './streams';
import { useShared } from '../ui/use-shared';

export default function App() {
  return (
    <I18nProvider>
      <FilePreviewProvider>
        <StreamsProvider>
          <AppContent />
        </StreamsProvider>
      </FilePreviewProvider>
    </I18nProvider>
  );
}
function AppContent() {
  const previewWorkbench = usePreviewWorkbench();
  const [page, setPage] = useState<'chat' | 'plugins'>('chat'),
    [pluginFilter, setPluginFilter] = useState<PluginFilter>('all');
  const { t } = useI18n();
  useWindowDimming();
  const profile = useBotProfile();
  const [designTaskId, setDesignTaskId] = useDesignTask();
  const [toast, setToast] = useToast();
  const { state, selected, setSelected } = useAppSnapshot(setToast);
  const [query, setQuery] = useState('');
  const drafts = useDrafts(),
    groupDrafts = useDrafts();
  const appearance = useAppearance(state?.appearance);
  const streamOwners = useStreamOwners();
  const avatarActivities = useShared(
    useMemo(() => (state ? botActivities(state, streamOwners) : {}), [state, streamOwners]),
  );
  const [peerPanel, setPeerPanel] = useState<PeerPanel>();
  const [selectedGroup, setSelectedGroup] = useState(''),
    [groupEditor, setGroupEditor] = useState<string>(),
    [newMenu, setNewMenu] = useState(false);
  const group = state?.groups?.rooms.find((room) => room.id === selectedGroup);
  const [modal, setModal] = useState<Modal>(null),
    [settingsTab, setSettingsTab] = useState<SettingsTab>('model'),
    [scope, setScope] = useState('');
  const [botMenu, setBotMenu] = useState<BotMenuAnchor>(),
    [deletingId, setDeletingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [viewingRequest, setViewingRequest] = useState('');
  const [command, setCommand] = useState('uname -s; id -u; pwd'),
    [output, setOutput] = useState('');
  const [screen, setScreen] = useState('');
  const bot = state?.bots.find((item) => item.id === selected) || state?.bots[0];
  useEffect(() => {
    previewWorkbench?.activate(
      page === 'chat'
        ? group
          ? { kind: 'group', id: group.id }
          : bot
            ? { kind: 'bot', id: bot.id }
            : undefined
        : undefined,
    );
  }, [page, bot?.id, group?.id, previewWorkbench?.activate]);
  const menuBot = state?.bots.find((item) => item.id === botMenu?.id),
    deletingBot = state?.bots.find((item) => item.id === deletingId);
  // Derived from the parts of the state it reads, so a change elsewhere (the work computer, a setting) keeps it.
  const conversation = useMemo(
    () => botConversation(state, bot),
    [state?.messages, state?.runs, state?.interactions, state?.greetingBotIds, state?.botModels, state?.model, bot],
  );
  const { messages, requests } = conversation;
  const anyRunning = state?.runs.some((run) => run.status === 'running') || false;
  useAgentPreview(
    state?.previewRequests,
    group ? { kind: 'group', id: group.id } : { kind: 'bot', id: bot?.id || '' },
    Boolean(page !== 'chat' || modal || peerPanel || groupEditor || taskModalOpen),
    (error) => setToast(ipcErrorText(error)),
  );
  const computer = useComputerControl(state, bot, setToast);
  const { vmReady, desktopBot, controlled, computerAction } = computer;
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      setToast(ipcErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  const closeModal = async () => {
    if (modal === 'computer' && controlled && desktopBot)
      await window.aelion.setComputerControl({ botId: desktopBot.id, enabled: false });
    if (modal === 'computer-setup' && state)
      try {
        localStorage.setItem(computerSetupDismissalKey(state.dataDir, state.vm), 'dismissed');
      } catch {}
    setModal(null);
  };
  const startTakeover = (request: TakeoverRequest) =>
    computerAction(async () => {
      await closeModal();
      setPage('chat');
      await window.aelion.respondInteraction({ id: request.id, action: 'takeover' });
      setPeerPanel(undefined);
      setSelected(request.botId);
      computer.setComputerBotId(request.botId);
      setModal('computer');
    });
  const viewInteraction = (request: InteractionRequest) =>
    void computerAction(async () => {
      await closeModal();
      setPage('chat');
      setPeerPanel(undefined);
      setQuery('');
      setSelected(request.botId);
      setSelectedGroup(state?.runs.find((run) => run.id === request.runId)?.groupOrigin?.groupId || '');
      setBotMenu(undefined);
      setViewingRequest(request.id);
    });
  const openGroup = (id: string) =>
    void computerAction(async () => {
      await closeModal();
      setPage('chat');
      setPeerPanel(undefined);
      setGroupEditor(undefined);
      setNewMenu(false);
      setBotMenu(undefined);
      setSelectedGroup(id);
    });
  const openPrivateChat = (panel: PeerPanel) =>
    void computerAction(async () => {
      await closeModal();
      setPage('chat');
      setBotMenu(undefined);
      setPeerPanel(panel);
    });
  useComputerSetupOffer({
    state,
    bot,
    page,
    modal,
    peerPanel,
    groupEditor,
    taskModalOpen,
    onOffer: () => setModal('computer-setup'),
  });
  useEffect(() => {
    setBotMenu(undefined);
    setNewMenu(false);
  }, [modal]);
  useDismissableMenu(newMenu, '.new-menu-anchor', () => setNewMenu(false));
  useEffect(() => {
    if (!viewingRequest || modal) return;
    const panel = document.getElementById(`interaction-${viewingRequest}`);
    if (panel) {
      panel.focus({ preventScroll: true });
      setViewingRequest('');
    }
  }, [viewingRequest, bot?.id, modal]);
  const { messagesPane, follow, onMessagesScroll, followLive } = useMessageFollow({
    botId: bot?.id,
    group,
    messages,
    artifactCount: state?.artifacts.length,
  });
  useEffect(() => {
    // Listing a workspace lets the main process adopt files the bot wrote outside a tracked run.
    if (!bot || (!vmReady && bot.type !== 'designer')) return;
    window.aelion.listFiles(bot.id).catch(() => {});
  }, [bot?.id, bot?.type, vmReady]);
  useModalEffects({
    modal,
    controlled,
    onEscape: () => void (modal === 'computer' ? computerAction(closeModal) : act(closeModal)),
    onError: setToast,
  });
  const openPlugins = (filter: PluginFilter = 'all') => {
    setPluginFilter(filter);
    setModal(null);
    setPeerPanel(undefined);
    setGroupEditor(undefined);
    setNewMenu(false);
    setBotMenu(undefined);
    setPage('plugins');
  };
  const openSettings = (tab: SettingsTab | 'mcp' = 'model') => {
    if (tab === 'mcp') {
      openPlugins('mcp');
      return;
    }
    setScope(bot?.id || '');
    setSettingsTab(tab);
    setModal('settings');
  };
  const chat = useBotChat({
    state,
    bot,
    conversation,
    drafts,
    follow,
    onNeedModel: () => openSettings(),
    onError: setToast,
  });
  const files = useFileActions({
    state,
    group,
    clearModal: () => setModal(null),
    openComputer: (botId) => {
      computer.setComputerBotId(botId);
      setModal('computer');
    },
    act,
    onNotify: setToast,
  });
  const openNewBot = () => {
    setPage('chat');
    if (!newMenu) profile.shuffleNewPalette();
    profile.startNew(state?.defaultModel?.reasoningEffort || '');
    setModal('new');
  };
  const editBot = (target: Bot) => {
    setBotMenu(undefined);
    profile.startEdit(target);
    setModal('profile');
  };
  const showBotMenu = (target: Bot, trigger: HTMLButtonElement, x?: number, y?: number) => {
    const box = trigger.getBoundingClientRect();
    setBotMenu({ id: target.id, trigger, x: x ?? box.left + 24, y: y ?? box.bottom });
  };
  const saveProfile = async (confirmContextReset = false) => {
    await profile.save({
      creating: modal === 'new',
      confirmContextReset,
      onCreated: setSelected,
      onContextReset: (id) => {
        drafts.remove(id);
        setDesignTaskId(undefined);
        setPeerPanel(undefined);
      },
    });
    setModal(null);
  };
  const removeBot = () =>
    act(async () => {
      if (!deletingBot) return;
      const id = deletingBot.id;
      await window.aelion.deleteBot(id);
      drafts.remove(id);
      setScope((value) => (value === id ? '' : value));
      setDeletingId('');
      setModal(null);
      setToast(t('Bot 已删除'));
    });
  if (!window.aelion)
    return (
      <div className="launch-note">
        <h1>AelionBot</h1>
        <p>{t('请通过桌面客户端启动。')}</p>
      </div>
    );
  if (!state) return <div className="launch-note">{t('正在打开工作台…')}</div>;
  return (
    <PreviewScopeProvider
      scope={group ? { kind: 'group', id: group.id } : bot ? { kind: 'bot', id: bot.id } : undefined}
    >
      <BotAvatarProvider bots={state.bots}>
        <div
          className="app-shell"
          data-platform={state.platform}
          data-page={page}
          data-bot-type={!group ? bot?.type : undefined}
        >
          <Sidebar
            state={state}
            page={page}
            group={group}
            bot={bot}
            query={query}
            onQuery={setQuery}
            avatarActivities={avatarActivities}
            botMenu={botMenu}
            newMenu={newMenu}
            newBotPalette={profile.newBotPalette}
            onToggleNewMenu={() => {
              if (!newMenu) profile.shuffleNewPalette();
              setNewMenu((value) => !value);
            }}
            onNewBot={() => {
              setNewMenu(false);
              openNewBot();
            }}
            onNewGroup={() => {
              setNewMenu(false);
              setGroupEditor('new');
            }}
            onOpenGroup={openGroup}
            onSelectBot={(id) => {
              setPage('chat');
              setSelectedGroup('');
              setSelected(id);
            }}
            onBotMenu={showBotMenu}
            onPlugins={() => openPlugins()}
            onSettings={openSettings}
          />
          {page === 'plugins' && (
            <PluginsPage
              key={pluginFilter}
              initialFilter={pluginFilter}
              state={state}
              busy={busy || anyRunning}
              act={act}
              onClose={() => setPage('chat')}
            />
          )}
          <ConversationPane
            state={state}
            group={group}
            bot={bot}
            visible={page === 'chat' && !modal && !peerPanel && !groupEditor && !taskModalOpen}
            busy={busy}
            vmReady={vmReady}
            avatarActivities={avatarActivities}
            conversation={conversation}
            chat={chat}
            drafts={drafts}
            groupDrafts={groupDrafts}
            files={files}
            messagesPane={messagesPane}
            follow={follow}
            onMessagesScroll={onMessagesScroll}
            followLive={followLive}
            onSwitch={(kind, id) => {
              setPage('chat');
              setSelectedGroup(kind === 'group' ? id : '');
              if (kind === 'bot') setSelected(id);
            }}
            onManageGroup={setGroupEditor}
            onProfile={editBot}
            onSettings={openSettings}
            onPlugins={() => openPlugins()}
            onNewBot={openNewBot}
            onScreen={(url) => {
              setScreen(url);
              setModal('screen');
            }}
            onReview={viewInteraction}
            onTakeover={startTakeover}
            onOpenGroup={openGroup}
            onOpenPrivateChat={openPrivateChat}
          />
          {bot?.type !== 'designer' && (
            <ComputerDetails
              state={state}
              bot={bot}
              group={group}
              computer={computer}
              expanded={modal === 'computer'}
              act={act}
              onOpen={() => setModal('computer')}
              onSetup={() => setModal('computer-setup')}
              onSettings={() => openSettings('computer')}
              onError={setToast}
              onTaskModalChange={setTaskModalOpen}
            />
          )}
          {designTaskId && (
            <DesignerTaskDrawer
              taskId={designTaskId}
              state={state}
              onProfile={editBot}
              onTakeover={startTakeover}
              onClose={() => setDesignTaskId(undefined)}
            />
          )}
          {toast && (
            <div className="toast" role="status">
              {toast}
            </div>
          )}
          <InteractionNotifications requests={requests} bots={state.bots} onView={viewInteraction} />
          <GroupNotifications
            view={state.groups}
            selected={page === 'chat' && !modal && !peerPanel && !taskModalOpen ? group?.id : undefined}
            onView={openGroup}
          />
          {groupEditor && (
            <GroupEditor
              laya={state.layaFeature}
              key={groupEditor}
              bots={state.bots}
              group={state.groups?.rooms.find((room) => room.id === groupEditor)}
              onClose={() => setGroupEditor(undefined)}
              onSaved={(id) => {
                setGroupEditor(undefined);
                setSelectedGroup(id);
              }}
              onDeleted={(id) => {
                setGroupEditor(undefined);
                if (selectedGroup === id) setSelectedGroup('');
                groupDrafts.remove(id);
              }}
            />
          )}
          <PeerNotifications view={state.peers} bots={state.bots} onView={openPrivateChat} />
          {peerPanel && (
            <PrivateChatWindow
              designer={state.designer}
              panel={peerPanel}
              view={state.peers}
              bots={state.bots}
              avatarActivities={avatarActivities}
              runs={state.runs}
              messages={state.messages}
              onNavigate={setPeerPanel}
              onClose={() => setPeerPanel(undefined)}
            />
          )}
          {botMenu && menuBot && (
            <BotContextMenu
              anchor={botMenu}
              name={menuBot.name}
              canDelete={!state.runs.some((run) => run.botId === menuBot.id && run.status === 'running')}
              onEdit={() => editBot(menuBot)}
              onDelete={() => {
                setDeletingId(menuBot.id);
                setBotMenu(undefined);
                setModal('delete-bot');
              }}
              onPrivateChats={() => openPrivateChat({ ownerId: menuBot.id })}
              onClose={() => setBotMenu(undefined)}
            />
          )}
          {modal && (
            <AppModals
              modal={modal}
              setModal={setModal}
              closeModal={closeModal}
              act={act}
              busy={busy}
              state={state}
              bot={bot}
              computer={computer}
              profileForm={
                (modal === 'new' || modal === 'profile') && (
                  <BotProfileForm
                    modal={modal}
                    state={state}
                    profile={profile}
                    busy={busy}
                    onSwitchType={() => setModal('switch-type')}
                    onSave={() => void act(() => saveProfile())}
                  />
                )
              }
              saveProfile={saveProfile}
              deletingBot={deletingBot}
              removeBot={removeBot}
              settingsTab={settingsTab}
              setSettingsTab={setSettingsTab}
              scope={scope}
              setScope={setScope}
              appearance={appearance}
              command={command}
              setCommand={setCommand}
              output={output}
              setOutput={setOutput}
              screen={screen}
              openPreview={files.openPreview}
              setToast={setToast}
            />
          )}
        </div>
      </BotAvatarProvider>
    </PreviewScopeProvider>
  );
}
