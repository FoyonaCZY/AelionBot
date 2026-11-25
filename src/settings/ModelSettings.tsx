import { Select } from '../ui/Select';
import { useEffect, useRef, useState } from 'react';
import type { ModelProvider, ModelSelection, ProviderModel, Snapshot } from '../../shared/types/core';
import { hostedSearchProtocol, type ModelParameters, type ModelProtocol } from '../../shared/types/model-types';
import {
  IMAGE_ASPECTS,
  IMAGE_QUALITIES,
  defaultImageProtocol,
  type ImageProtocol,
  type ImageProtocolInfo,
} from '../../shared/types/image-types';
import { SPEECH_PROTOCOL_CATALOG, speechProtocolFor, type SpeechProtocol } from '../../shared/types/speech-types';
import {
  MODEL_USES,
  VIDEO_PROTOCOLS,
  usesModel,
  type ModelUse,
  type VideoProtocol,
} from '../../shared/types/media-types';
import { MediaAssignment } from './MediaAssignment';
import { SpeechAssignments } from './SpeechSettings';
import { Icon } from '../ui/Icon';
import { useSwitchMotion } from '../ui/motion';
import { ModelSelectionFields, validModelSelection } from './ModelSelectionFields';
import { ContextCapacityInput } from './ContextCapacityInput';
import { EditableSelect } from '../ui/EditableSelect';
import { REASONING_PROTOCOLS, reasoningPresets } from '../../shared/chat/reasoning';
import { useI18n } from '../i18n';
import './model-settings.css';

const errorText = (error: unknown) =>
  (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** The protocol catalog is owned by the main process so adding an adapter needs no renderer change. */
function useImageProtocols() {
  const [catalog, setCatalog] = useState<ImageProtocolInfo[]>([]);
  useEffect(() => {
    let live = true;
    void window.aelion
      .imageProtocols()
      .then((value) => {
        if (live) setCatalog(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return catalog;
}
export function ModelSettings({ state, onNotify }: { state: Snapshot; onNotify: (text: string) => void }) {
  const { t } = useI18n(),
    providers = state.providers || [];
  const [use, setUse] = useState<ModelUse>('chat');
  const [page, setPage] = useState<'assignments' | 'providers'>(providers.length ? 'assignments' : 'providers');
  const [editing, setEditing] = useState<string>(providers[0]?.id || 'new'),
    [refreshing, setRefreshing] = useState<string[]>([]),
    [removing, setRemoving] = useState('');
  const attempted = useRef(new Set<string>()),
    workspace = useRef<HTMLDivElement>(null);
  useSwitchMotion(workspace, page, ':scope > :not([hidden], .model-settings-navigation)');
  useSwitchMotion(workspace, editing, '.provider-editor');
  const refresh = async (id: string) => {
    setRefreshing((value) => [...new Set([...value, id])]);
    try {
      await window.aelion.refreshProviderModels(id);
    } catch (error) {
      onNotify(errorText(error));
    } finally {
      setRefreshing((value) => value.filter((item) => item !== id));
    }
  };
  useEffect(() => {
    for (const provider of providers)
      if (usesModel(provider, 'chat') && !provider.modelsCheckedAt && !attempted.current.has(provider.id)) {
        attempted.current.add(provider.id);
        void refresh(provider.id);
      }
  }, [providers.map((provider) => `${provider.id}:${provider.modelsCheckedAt || ''}`).join('|')]);
  useEffect(() => {
    if (editing !== 'new' && !providers.some((provider) => provider.id === editing))
      setEditing(providers[0]?.id || 'new');
  }, [editing, providers]);
  const affected = state.bots.filter((bot) => !bot.model).map((bot) => bot.id),
    busy = state.runs.some((run) => run.status === 'running' && affected.includes(run.botId));
  const editor = providers.find((provider) => provider.id === editing),
    editingUsed = state.bots
      .filter((bot) => (bot.model || state.defaultModel)?.providerId === editing)
      .map((bot) => bot.id),
    editingBusy = state.runs.some((run) => run.status === 'running' && editingUsed.includes(run.botId));
  const used = Boolean(
    editor &&
    (state.defaultModel?.providerId === editor.id ||
      state.approvalModel?.providerId === editor.id ||
      state.mediaDefaults?.image?.providerId === editor.id ||
      state.mediaDefaults?.video?.providerId === editor.id ||
      state.speech?.input?.providerId === editor.id ||
      state.speech?.output?.providerId === editor.id ||
      state.bots.some((bot) => bot.model?.providerId === editor.id)),
  );
  const remove = async () => {
    if (!editor || used) return;
    setRemoving(editor.id);
    try {
      await window.aelion.removeProvider(editor.id);
      setEditing(providers.find((provider) => provider.id !== editor.id)?.id || 'new');
    } catch (error) {
      onNotify(errorText(error));
    } finally {
      setRemoving('');
    }
  };
  return (
    <div ref={workspace} className="model-settings-workspace">
      <div className="model-settings-navigation" role="group" aria-label={t('模型设置')}>
        <button type="button" aria-pressed={page === 'assignments'} onClick={() => setPage('assignments')}>
          <Icon name="sliders" size={16} />
          {t('模型分配')}
        </button>
        <button type="button" aria-pressed={page === 'providers'} onClick={() => setPage('providers')}>
          <Icon name="layers" size={16} />
          {t('Provider 连接')}
          <span className="model-count-badge">{providers.length}</span>
        </button>
      </div>
      <div className="model-assignments-page" hidden={page !== 'assignments'}>
        <div className="media-use-tabs" role="group" aria-label={t('模型用途')}>
          {(Object.keys(MODEL_USES) as ModelUse[]).map((kind) => (
            <button type="button" key={kind} aria-pressed={use === kind} onClick={() => setUse(kind)}>
              {t(MODEL_USES[kind])}
            </button>
          ))}
        </div>
        {(use === 'image' || use === 'video') && (
          <MediaAssignment
            key={use + JSON.stringify(state.mediaDefaults?.[use])}
            kind={use}
            selection={state.mediaDefaults?.[use]}
            providers={providers}
            onNotify={onNotify}
            onManage={(id) => {
              setEditing(id || providers[0]?.id || 'new');
              setPage('providers');
            }}
          />
        )}
        {use === 'chat' && (
          <div className="model-assignment-grid">
            <section className="model-assignment-panel">
              <header>
                <h3>{t('默认模型')}</h3>
              </header>
              <DefaultModelAssignment
                providers={providers}
                selection={state.defaultModel || null}
                busy={busy}
                onNotify={onNotify}
              />
              {busy && (
                <p className="provider-model-note" role="status">
                  {t('任务运行中，暂不可修改')}
                </p>
              )}
            </section>
            <section className="model-assignment-panel">
              <header>
                <h3>{t('自动审核模型')}</h3>
              </header>
              <DefaultModelAssignment
                approval
                defaultModel={state.defaultModel}
                providers={providers}
                selection={state.approvalModel || null}
                busy={false}
                onNotify={onNotify}
              />
            </section>
          </div>
        )}
        {(use === 'asr' || use === 'tts') && (
          <SpeechAssignments
            kind={use === 'asr' ? 'input' : 'output'}
            providers={providers}
            settings={state.speech || {}}
            onNotify={onNotify}
          />
        )}
        {!providers.length && (
          <button
            type="button"
            className="secondary-button model-add-first"
            onClick={() => {
              setEditing('new');
              setPage('providers');
            }}
          >
            <Icon name="plus" size={16} />
            {t('添加 Provider')}
          </button>
        )}
      </div>
      <div className="provider-workspace" hidden={page !== 'providers'}>
        <aside className="provider-browser" aria-label={t('Provider 列表')}>
          <div className="provider-browser-heading">
            <span>Providers</span>
            <button
              type="button"
              className="icon-button"
              aria-label={t('添加 Provider')}
              title={t('添加 Provider')}
              onClick={() => setEditing('new')}
            >
              <Icon name="plus" size={17} />
            </button>
          </div>
          <div className="provider-browser-list">
            {providers.map((provider) => (
              <button
                type="button"
                key={provider.id}
                className={`provider-browser-item${editing === provider.id ? ' is-selected' : ''}`}
                aria-pressed={editing === provider.id}
                aria-label={t('编辑 Provider {name}', { name: provider.name })}
                onClick={() => setEditing(provider.id)}
              >
                <span className="provider-browser-copy">
                  <span className="provider-browser-name">
                    <strong>{provider.name}</strong>
                    {provider.modelsError && (
                      <span className="provider-warning" title={provider.modelsError}>
                        <Icon name="alert" size={14} />
                      </span>
                    )}
                  </span>
                </span>
              </button>
            ))}
            {editing === 'new' && (
              <div className="provider-browser-item is-selected provider-new-item">
                <span className="provider-new-mark" aria-hidden="true">
                  <Icon name="plus" size={15} />
                </span>
                {t('添加 Provider')}
              </div>
            )}
          </div>
        </aside>
        <ProviderEditor
          key={editing}
          provider={editor}
          disabled={editingBusy}
          refreshing={Boolean(editor && refreshing.includes(editor.id))}
          removing={removing === editing}
          used={used}
          onRefresh={() => editor && void refresh(editor.id)}
          onRemove={() => void remove()}
          onSaved={(provider, close) => {
            setEditing((current) => (current === editing ? provider.id : current));
            onNotify(
              provider.modelsError
                ? t('Provider 已保存，模型列表拉取失败')
                : close === false
                  ? t('模型目录已更新')
                  : t('Provider 已保存'),
            );
          }}
        />
      </div>
    </div>
  );
}

function DefaultModelAssignment({
  providers,
  selection,
  busy,
  onNotify,
  approval = false,
  defaultModel,
}: {
  approval?: boolean;
  defaultModel?: ModelSelection;
  providers: ModelProvider[];
  selection: ModelSelection | null;
  busy: boolean;
  onNotify: (text: string) => void;
}) {
  const [value, setValue] = useState<ModelSelection | null>(selection),
    seq = useRef(0);
  useEffect(() => {
    setValue(selection);
  }, [JSON.stringify(selection)]);
  const persist = async (next: ModelSelection | null) => {
    setValue(next);
    if (!validModelSelection(next, providers) || same(next, selection)) return;
    const n = ++seq.current;
    try {
      if (approval) await window.aelion.setApprovalModel(next);
      else await window.aelion.setDefaultModel(next);
    } catch (error) {
      if (n === seq.current) {
        setValue(selection);
        onNotify(errorText(error));
      }
    }
  };
  return (
    <div className="model-assignment">
      <ModelSelectionFields
        providers={providers}
        value={value}
        onChange={persist}
        disabled={busy}
        inheritDefault={approval}
        defaultModel={defaultModel}
        showInheritedReasoning={!approval}
      />
    </div>
  );
}

function ProviderEditor({
  provider,
  disabled,
  refreshing,
  removing,
  used,
  onRefresh,
  onRemove,
  onSaved,
}: {
  provider?: ModelProvider;
  disabled: boolean;
  refreshing: boolean;
  removing: boolean;
  used: boolean;
  onRefresh: () => void;
  onRemove: () => void;
  onSaved: (provider: ModelProvider, close?: boolean) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'connection' | 'models' | 'images' | 'speech' | 'video' | 'advanced'>('connection');
  const form = useRef<HTMLFormElement>(null);
  useSwitchMotion(form, tab, ':scope > .provider-editor-content:not([hidden])');
  const [parameters, setParameters] = useState<ModelParameters>({
    protocol: provider ? provider.protocol || 'chat' : 'responses',
    responsesTransport: provider?.responsesTransport,
    temperature: provider?.temperature,
    thinkingBudget: provider?.thinkingBudget,
    fallbackModel: provider?.fallbackModel,
    hostedWebSearch: provider?.hostedWebSearch,
    hostedImageGeneration: provider?.hostedImageGeneration,
    imageProtocol: provider?.imageProtocol,
    imageAspect: provider?.imageAspect,
    imageQuality: provider?.imageQuality,
    speechProtocol: provider?.speechProtocol,
    asrProtocol: provider?.asrProtocol,
    ttsProtocol: provider?.ttsProtocol,
    uses:
      provider?.uses ||
      (provider ? (Object.keys(MODEL_USES) as ModelUse[]).filter((k) => usesModel(provider, k)) : ['chat']),
    videoProtocol: provider?.videoProtocol,
  });
  const [name, setName] = useState(provider?.name || ''),
    [baseUrl, setBaseUrl] = useState(provider?.baseUrl || ''),
    [apiKey, setApiKey] = useState(''),
    [clearKey, setClearKey] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const save = async () => {
    setPending(true);
    setError('');
    try {
      const saved = await window.aelion.saveProvider({
        id: provider?.id,
        name,
        baseUrl,
        ...parameters,
        imageProtocol,
        apiKey: clearKey ? null : apiKey || undefined,
      });
      setName(saved.name);
      setBaseUrl(saved.baseUrl);
      setApiKey('');
      setClearKey(false);
      onSaved(saved);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  };
  const responses = parameters.protocol === 'responses';
  const protocols = useImageProtocols();
  // Hosted generation only exists on a Responses provider; drop it from the menu and from state when the chat protocol moves away.
  const imageOptions = protocols.filter((info) => info.id !== 'responses-images' || responses);
  // A provider that never chose shows the protocol it uses; saving keeps that choice.
  const imageProtocol =
    parameters.imageProtocol && imageOptions.some((info) => info.id === parameters.imageProtocol)
      ? parameters.imageProtocol
      : defaultImageProtocol(parameters.protocol);
  const imageInfo = imageOptions.find((info) => info.id === imageProtocol);
  const toggleUse = (kind: ModelUse, enabled: boolean) => {
    const uses = enabled ? [...parameters.uses!, kind] : parameters.uses!.filter((k) => k !== kind);
    setParameters({
      ...parameters,
      uses,
      videoProtocol: parameters.videoProtocol || (kind === 'video' && enabled ? 'dashscope' : undefined),
    });
  };
  return (
    <form
      ref={form}
      className="provider-editor"
      onInvalidCapture={(event) => {
        const field = event.target as HTMLInputElement,
          panel = field.closest<HTMLElement>('[data-provider-panel]');
        if (panel?.hidden) {
          event.preventDefault();
          setTab(panel.dataset.providerPanel as typeof tab);
          requestAnimationFrame(() => {
            field.focus();
            field.reportValidity();
          });
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !pending && name.trim() && baseUrl.trim()) void save();
      }}
    >
      <header className="provider-editor-heading">
        <div>
          {!provider && (
            <span className="provider-new-mark is-large" aria-hidden="true">
              <Icon name="plus" size={18} />
            </span>
          )}
          <h3>{provider?.name || t('添加 Provider')}</h3>
        </div>
        {provider && (
          <button
            type="button"
            className="icon-button provider-delete"
            disabled={used || disabled || pending || removing}
            title={used ? t('请先切换使用此连接的模型') : t('删除 Provider {name}', { name: provider.name })}
            aria-label={t('删除 Provider {name}', { name: provider.name })}
            onClick={onRemove}
          >
            <Icon name="trash" size={16} />
          </button>
        )}
      </header>
      <div className="provider-editor-tabs" role="group" aria-label={t('Provider 设置')}>
        {(
          [
            { id: 'connection', label: t('连接') },
            { id: 'models', label: t('模型'), count: provider?.models.length },
            { id: 'images', label: t('生图') },
            { id: 'speech', label: t('语音') },
            { id: 'video', label: t('视频生成') },
            { id: 'advanced', label: t('高级') },
          ] as const
        )
          .filter((item) =>
            item.id === 'images'
              ? parameters.uses?.includes('image')
              : item.id === 'speech'
                ? parameters.uses?.some((k) => k === 'asr' || k === 'tts')
                : item.id === 'video'
                  ? parameters.uses?.includes('video')
                  : item.id === 'advanced'
                    ? parameters.uses?.includes('chat')
                    : true,
          )
          .map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={tab === item.id}
              disabled={item.id === 'models' && !provider}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {'count' in item && item.count !== undefined && <span>{item.count}</span>}
            </button>
          ))}
      </div>
      {disabled && (
        <p className="provider-editor-notice" role="status">
          {t('任务运行中，暂不可修改')}
        </p>
      )}
      <div className="provider-editor-content" data-provider-panel="connection" hidden={tab !== 'connection'}>
        <div className="settings-card">
          <fieldset className="provider-uses">
            <legend>{t('模型用途')}</legend>
            {(Object.keys(MODEL_USES) as ModelUse[]).map((kind) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  disabled={disabled || pending}
                  checked={parameters.uses?.includes(kind) || false}
                  onChange={(e) => toggleUse(kind, e.target.checked)}
                />
                {t(MODEL_USES[kind])}
              </label>
            ))}
          </fieldset>
          <label className="settings-row" hidden={!parameters.uses?.includes('chat')}>
            <span>{t('协议')}</span>
            <Select
              aria-label={t('Provider 协议')}
              value={parameters.protocol}
              disabled={disabled || pending}
              onChange={(e) => setParameters({ ...parameters, protocol: e.target.value as ModelProtocol })}
            >
              <option value="chat">OpenAI {t('兼容')}</option>
              <option value="responses">OpenAI Responses</option>
              <option value="anthropic">Claude Messages</option>
              <option value="gemini">Gemini Generate Content</option>
            </Select>
          </label>
          <label className="settings-row">
            <span>{t('名称')}</span>
            <input
              aria-label={t('Provider 名称')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              disabled={disabled || pending}
              placeholder={t('例如：OpenAI')}
            />
          </label>
          <label className="settings-row">
            <span>Base URL</span>
            <input
              aria-label={t('Provider Base URL')}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              maxLength={2000}
              spellCheck={false}
              disabled={disabled || pending}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label className="settings-row">
            <span>API Key</span>
            <input
              aria-label={t('Provider API Key')}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setClearKey(false);
              }}
              disabled={disabled || pending}
              maxLength={4000}
              placeholder={provider?.hasKey && !clearKey ? t('已保存，留空保持不变') : t('本地服务可留空')}
            />
          </label>
        </div>
        {provider?.hasKey && (
          <label className="provider-clear-key">
            <input
              type="checkbox"
              checked={clearKey}
              disabled={disabled || pending}
              onChange={(event) => {
                setClearKey(event.target.checked);
                setApiKey('');
              }}
            />
            {t('清除已保存的密钥')}
          </label>
        )}
      </div>
      <div className="provider-editor-content" data-provider-panel="images" hidden={tab !== 'images'}>
        <div className="settings-card provider-image-card">
          <label className="settings-row">
            <span>{t('生图协议')}</span>
            <Select
              aria-label={t('生图协议')}
              value={imageProtocol}
              disabled={disabled || pending}
              onChange={(e) => setParameters({ ...parameters, imageProtocol: e.target.value as ImageProtocol })}
            >
              {imageOptions.map((info) => (
                <option key={info.id} value={info.id}>
                  {info.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="settings-row">
            <span>{t('默认画幅')}</span>
            <EditableSelect
              label={t('默认画幅')}
              value={parameters.imageAspect || ''}
              disabled={disabled || pending || !imageInfo?.capabilities.aspect}
              options={[...IMAGE_ASPECTS]}
              placeholder={t('模型默认')}
              onChange={(imageAspect) => setParameters({ ...parameters, imageAspect: imageAspect || undefined })}
            />
          </label>
          <label className="settings-row">
            <span>{t('默认质量')}</span>
            <EditableSelect
              label={t('默认质量')}
              value={parameters.imageQuality || ''}
              options={[...IMAGE_QUALITIES]}
              disabled={disabled || pending || !imageInfo?.capabilities.quality}
              placeholder={t('模型默认')}
              onChange={(value) =>
                setParameters({ ...parameters, imageQuality: value === 'auto' ? undefined : value || undefined })
              }
            />
          </label>
        </div>
      </div>
      <div className="provider-editor-content" data-provider-panel="speech" hidden={tab !== 'speech'}>
        <div className="settings-card provider-image-card">
          {(['asr', 'tts'] as const)
            .filter((kind) => parameters.uses?.includes(kind))
            .map((kind) => {
              const label = t(kind === 'asr' ? '语音识别协议' : '语音合成协议');
              return (
                <label key={kind} className="settings-row">
                  <span>{label}</span>
                  <Select
                    aria-label={label}
                    value={speechProtocolFor({ ...parameters, baseUrl }, kind === 'asr' ? 'input' : 'output')}
                    disabled={disabled || pending}
                    onChange={(e) =>
                      setParameters({
                        ...parameters,
                        [kind === 'asr' ? 'asrProtocol' : 'ttsProtocol']: e.target.value as SpeechProtocol,
                      })
                    }
                  >
                    {SPEECH_PROTOCOL_CATALOG.map((info) => (
                      <option key={info.id} value={info.id}>
                        {t(info.label)}
                      </option>
                    ))}
                  </Select>
                </label>
              );
            })}
        </div>
      </div>
      <div className="provider-editor-content" data-provider-panel="video" hidden={tab !== 'video'}>
        <div className="settings-card">
          <label className="settings-row">
            <span>{t('视频协议')}</span>
            <Select
              value={parameters.videoProtocol || 'dashscope'}
              disabled={disabled || pending}
              onChange={(e) => setParameters({ ...parameters, videoProtocol: e.target.value as VideoProtocol })}
            >
              {Object.entries(VIDEO_PROTOCOLS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>
      <div className="provider-editor-content" data-provider-panel="advanced" hidden={tab !== 'advanced'}>
        <div className="settings-card">
          {responses && (
            <label className="settings-row">
              <span>{t('连接方式')}</span>
              <Select
                aria-label={t('Responses 连接方式')}
                value={parameters.responsesTransport || 'auto'}
                disabled={disabled || pending}
                onChange={(e) =>
                  setParameters({
                    ...parameters,
                    responsesTransport: e.target.value as ModelParameters['responsesTransport'],
                  })
                }
              >
                <option value="auto">{t('自动')}</option>
                <option value="http">HTTP</option>
                <option value="websocket">WebSocket（{t('服务端支持时')}）</option>
              </Select>
            </label>
          )}
        </div>
        <h4>{t('对话默认')}</h4>
        <div className="settings-card">
          <label className="settings-row">
            <span>{t('温度')}</span>
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              placeholder={t('模型默认')}
              disabled={disabled || pending}
              value={parameters.temperature ?? ''}
              onChange={(e) =>
                setParameters({
                  ...parameters,
                  temperature: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
          </label>
          {['anthropic', 'gemini'].includes(parameters.protocol || 'chat') && (
            <label className="settings-row">
              <span>{t('思考预算')}</span>
              <input
                type="number"
                min={1024}
                max={64000}
                placeholder={t('模型默认')}
                disabled={disabled || pending}
                value={parameters.thinkingBudget ?? ''}
                onChange={(e) =>
                  setParameters({
                    ...parameters,
                    thinkingBudget: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
              />
            </label>
          )}
          <label className="settings-row">
            <span>{t('故障时的备用模型')}</span>
            <input
              value={parameters.fallbackModel || ''}
              disabled={disabled || pending}
              placeholder={t('不自动切换')}
              maxLength={256}
              onChange={(e) => setParameters({ ...parameters, fallbackModel: e.target.value })}
            />
          </label>
        </div>
        {hostedSearchProtocol(parameters.protocol) && (
          <div className="settings-card provider-tools-card">
            <p className="provider-card-kicker">{responses ? t('Responses 工具') : t('Claude 工具')}</p>
            <label className="settings-row provider-hosted-row">
              <span>{t('服务端搜索')}</span>
              <input
                type="checkbox"
                checked={Boolean(parameters.hostedWebSearch)}
                disabled={disabled || pending}
                onChange={(event) => setParameters({ ...parameters, hostedWebSearch: event.target.checked })}
                aria-label={t('使用服务端内置搜索；应用内不再提供内置搜索工具')}
              />
            </label>
            {responses && parameters.uses?.includes('image') && (
              <label className="settings-row provider-hosted-row">
                <span>{t('服务端生图')}</span>
                <input
                  type="checkbox"
                  checked={Boolean(parameters.hostedImageGeneration)}
                  disabled={disabled || pending}
                  onChange={(event) => setParameters({ ...parameters, hostedImageGeneration: event.target.checked })}
                  aria-label={t('使用服务端内置生图，由 Responses 直接出图')}
                />
              </label>
            )}
          </div>
        )}
      </div>
      {provider && (
        <div
          className="provider-editor-content provider-catalog-panel"
          data-provider-panel="models"
          hidden={tab !== 'models'}
        >
          <ProviderModelCatalog
            provider={provider}
            disabled={disabled || pending}
            refreshing={refreshing}
            onRefresh={onRefresh}
            onChange={(next) => onSaved(next, false)}
          />
        </div>
      )}
      <footer className="provider-editor-footer">
        <div className="provider-save-status" role="status">
          {error ? (
            <span className="provider-error">{error}</span>
          ) : provider?.modelsError ? (
            <span className="provider-error">{provider.modelsError}</span>
          ) : null}
        </div>
        <button
          className="primary-button"
          disabled={disabled || pending || !parameters.uses?.length || !name.trim() || !baseUrl.trim()}
        >
          {pending ? t('保存中…') : provider ? t('保存更改') : t('添加 Provider')}
        </button>
      </footer>
    </form>
  );
}

function ProviderModelCatalog({
  provider,
  disabled,
  refreshing,
  onRefresh,
  onChange,
}: {
  provider: ModelProvider;
  disabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onChange: (provider: ModelProvider) => void;
}) {
  const { t } = useI18n();
  const [customId, setCustomId] = useState(''),
    [query, setQuery] = useState(''),
    chat = usesModel(provider, 'chat'),
    image = usesModel(provider, 'image'),
    thinking = chat && ['anthropic', 'gemini'].includes(provider.protocol || 'chat');
  const [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const save = async (model: ProviderModel) => {
    setSaving(true);
    setError('');
    try {
      const next = await window.aelion.updateProviderModel({ providerId: provider.id, model });
      onChange(next);
      return true;
    } catch (error) {
      setError(errorText(error));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const add = async () => {
    const id = customId.trim();
    if (disabled || saving || !id || provider.models.some((model) => model.id === id)) return;
    if (await save(chat ? { id, contextTokens: 32000 } : { id })) setCustomId('');
  };
  const needle = query.trim().toLowerCase(),
    models = needle ? provider.models.filter((model) => model.id.toLowerCase().includes(needle)) : provider.models;
  return (
    <div className="provider-model-catalog">
      <div className="provider-catalog-toolbar">
        <label className="provider-model-search">
          <Icon name="search" size={16} />
          <input
            value={query}
            aria-label={t('筛选模型')}
            placeholder={t('筛选模型')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="text-button"
          type="button"
          disabled={disabled || refreshing || saving || !usesModel(provider, 'chat')}
          onClick={onRefresh}
        >
          <Icon name="restart" size={14} />
          {refreshing ? t('拉取中…') : t('刷新')}
        </button>
      </div>
      <div className="provider-model-add">
        <input
          value={customId}
          disabled={disabled || saving}
          aria-label={t('自定义模型名称')}
          maxLength={256}
          placeholder={t('自定义模型名称')}
          onChange={(event) => setCustomId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void add();
            }
          }}
        />
        <button
          type="button"
          className="secondary-button"
          disabled={
            disabled || saving || !customId.trim() || provider.models.some((model) => model.id === customId.trim())
          }
          onClick={() => void add()}
        >
          <Icon name="plus" size={15} />
          {t('添加模型')}
        </button>
      </div>
      {error && (
        <p className="provider-error" role="alert">
          {error}
        </p>
      )}
      <div className="provider-model-results">
        {models.map((model) =>
          !chat && !image ? (
            <div key={model.id} className="provider-model-card">
              <span className="provider-model-id">{model.id}</span>
            </div>
          ) : (
            <details key={model.id} className="provider-model-card">
              <summary>
                <Icon name="arrow" size={14} />
                <span className="provider-model-id" title={model.id}>
                  {model.id}
                </span>
                <span className="provider-model-meta">
                  {model.imageOutput ? `${t('生图')} · ` : ''}
                  {model.contextTokens ? `${Math.round(model.contextTokens / 1000)}k` : ''}
                  {model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}
                  {model.thinkingBudget ? ` · ${model.thinkingBudget}` : ''}
                </span>
              </summary>
              {chat && (
                <label className="settings-row settings-number">
                  <span>{t('上下文容量')}</span>
                  <ContextCapacityInput
                    value={model.contextTokens ?? 32000}
                    disabled={disabled}
                    onChange={(contextTokens) =>
                      Number.isInteger(contextTokens) && void save({ ...model, contextTokens })
                    }
                  />
                </label>
              )}
              {chat && REASONING_PROTOCOLS.includes(provider.protocol || 'chat') && (
                <label className="settings-row">
                  <span>{t('推理强度')}</span>
                  <EditableSelect
                    label={t('推理强度')}
                    value={model.reasoningEffort || ''}
                    onChange={(text) => void save({ ...model, reasoningEffort: text || undefined })}
                    options={reasoningPresets(provider.protocol)}
                    maxLength={80}
                    placeholder={t('模型默认，可输入自定义值')}
                    disabled={disabled}
                  />
                </label>
              )}
              {thinking && (
                <label className="settings-row">
                  <span>{t('思考预算')}</span>
                  <input
                    type="number"
                    min={1024}
                    max={64000}
                    placeholder={t('模型默认')}
                    disabled={disabled}
                    value={model.thinkingBudget ?? ''}
                    onChange={(event) => {
                      const text = event.target.value;
                      if (text === '') void save({ ...model, thinkingBudget: undefined });
                      else if (Number.isInteger(Number(text))) void save({ ...model, thinkingBudget: Number(text) });
                    }}
                  />
                </label>
              )}
              {image && (
                <label className="settings-row provider-hosted-row">
                  <span>{t('可用于生图')}</span>
                  <input
                    type="checkbox"
                    checked={Boolean(model.imageOutput)}
                    disabled={disabled}
                    onChange={(event) => void save({ ...model, imageOutput: event.target.checked || undefined })}
                    aria-label={t('把 {model} 标记为生图模型', { model: model.id })}
                  />
                </label>
              )}
              {image && model.imageOutput && (
                <>
                  <label className="settings-row">
                    <span>{t('默认画幅')}</span>
                    <EditableSelect
                      label={t('{model} 的默认画幅', { model: model.id })}
                      value={model.imageAspect || ''}
                      disabled={disabled}
                      options={[...IMAGE_ASPECTS]}
                      placeholder={t('跟随 Provider')}
                      onChange={(imageAspect) => void save({ ...model, imageAspect: imageAspect || undefined })}
                    />
                  </label>
                  <label className="settings-row">
                    <span>{t('默认质量')}</span>
                    <EditableSelect
                      label={t('{model} 的默认质量', { model: model.id })}
                      value={model.imageQuality || ''}
                      options={[...IMAGE_QUALITIES]}
                      disabled={disabled}
                      placeholder={t('跟随 Provider')}
                      onChange={(v) => void save({ ...model, imageQuality: v === 'auto' ? undefined : v || undefined })}
                    />
                  </label>
                </>
              )}
            </details>
          ),
        )}
        {!models.length && <p className="provider-empty">{query.trim() ? t('没有匹配的模型') : t('暂无模型')}</p>}
      </div>
    </div>
  );
}
