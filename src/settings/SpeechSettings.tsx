// Which provider and model the app uses for speech recognition and synthesis, beside the default and approval models.
import { useEffect, useState } from 'react';
import type { ModelProvider } from '../../shared/types/core';
import {
  defaultSpeechProtocol,
  speechProtocolInfo,
  type SpeechSelection,
  type SpeechSettings,
} from '../../shared/types/speech-types';
import { EditableSelect } from '../ui/EditableSelect';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { ipcErrorText } from '../ui/ipc-error';
import { speak, stopSpeaking, useSpeaking } from '../speech/speech-player';
import { useI18n } from '../i18n';
import '../speech/speech.css';

const SAMPLE = '你好，我是你的 AelionBot。这是语音合成的试听。';

/** The speech protocol a provider uses, chosen in its speech tab or taken from its address. */
const providerSpeechProtocol = (provider?: Pick<ModelProvider, 'speechProtocol' | 'baseUrl'>) =>
  provider ? provider.speechProtocol || defaultSpeechProtocol(provider.baseUrl) : undefined;

/** A selection is complete when its provider exists and it names a model, unless the protocol takes none. */
const complete = (selection: SpeechSelection | undefined, providers: ModelProvider[]) => {
  if (!selection) return true;
  const protocol = providerSpeechProtocol(providers.find((item) => item.id === selection.providerId));
  return Boolean(protocol && (speechProtocolInfo(protocol).modelless || selection.model.trim()));
};

function SpeechFields({
  kind,
  providers,
  value,
  onChange,
}: {
  kind: 'input' | 'output';
  providers: ModelProvider[];
  value?: SpeechSelection;
  onChange: (value: SpeechSelection | undefined) => void;
}) {
  const { t } = useI18n();
  const provider = providers.find((item) => item.id === value?.providerId),
    protocol = providerSpeechProtocol(provider),
    info = protocol && speechProtocolInfo(protocol);
  return (
    <div className="settings-card">
      <label className="settings-row">
        <span>Provider</span>
        <Select
          aria-label={kind === 'input' ? t('语音识别 Provider') : t('语音合成 Provider')}
          value={value?.providerId || ''}
          onChange={(event) => onChange(event.target.value ? { providerId: event.target.value, model: '' } : undefined)}
        >
          <option value="">{t('不使用')}</option>
          {providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
      </label>
      {info && !info.modelless && (
        <label className="settings-row">
          <span>{t('模型')}</span>
          <EditableSelect
            label={kind === 'input' ? t('语音识别模型') : t('语音合成模型')}
            value={value?.model || ''}
            onChange={(model) => onChange({ ...value!, model })}
            options={kind === 'input' ? info.inputModels : info.outputModels}
            placeholder={t('选择或输入模型名称')}
            maxLength={256}
          />
        </label>
      )}
      {info && kind === 'output' && (
        <label className="settings-row">
          <span>{t('默认音色')}</span>
          <EditableSelect
            label={t('默认音色')}
            value={value?.voice || ''}
            onChange={(voice) => onChange({ ...value!, voice: voice || undefined })}
            options={info.voices.map((voice) => voice.id)}
            placeholder={t('服务默认')}
            maxLength={120}
          />
        </label>
      )}
      {info && (
        <p className="model-catalog-note">
          {t('语音协议')}：{t(info.label)}
        </p>
      )}
    </div>
  );
}

export function SpeechAssignments({
  providers,
  settings,
  onNotify,
}: {
  providers: ModelProvider[];
  settings: SpeechSettings;
  onNotify: (text: string) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<SpeechSettings>(settings),
    reading = useSpeaking();
  useEffect(() => setValue(settings), [JSON.stringify(settings)]);
  const persist = async (next: SpeechSettings) => {
    setValue(next);
    if (!complete(next.input, providers) || !complete(next.output, providers)) return;
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    try {
      await window.aelion.setSpeech(next);
    } catch (error) {
      setValue(settings);
      onNotify(ipcErrorText(error));
    }
  };
  const listening = reading?.key === 'speech-settings-sample';
  return (
    <>
      <section className="model-assignment-panel">
        <header>
          <span className="model-assignment-mark" aria-hidden="true">
            <Icon name="mic" size={16} />
          </span>
          <h3>{t('语音识别')}</h3>
        </header>
        <div className="model-assignment">
          <SpeechFields
            kind="input"
            providers={providers}
            value={value.input}
            onChange={(input) => void persist({ ...value, input })}
          />
          <p className="provider-model-note">{t('用于输入框的语音输入、IM 语音消息和 Bot 转写录音。')}</p>
        </div>
      </section>
      <section className="model-assignment-panel">
        <header>
          <span className="model-assignment-mark" aria-hidden="true">
            <Icon name="speaker" size={16} />
          </span>
          <h3>{t('语音合成')}</h3>
        </header>
        <div className="model-assignment">
          <SpeechFields
            kind="output"
            providers={providers}
            value={value.output}
            onChange={(output) => void persist({ ...value, output })}
          />
          <label className="settings-row provider-hosted-row">
            <span>{t('用语音回复 IM 里的语音消息')}</span>
            <input
              type="checkbox"
              checked={Boolean(value.connectorVoiceReplies)}
              disabled={!settings.output}
              aria-label={t('收到语音消息时，除了文字再发一条语音（目前支持飞书）')}
              onChange={(event) => void persist({ ...value, connectorVoiceReplies: event.target.checked || undefined })}
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={!settings.output}
            onClick={() =>
              listening
                ? stopSpeaking()
                : speak('speech-settings-sample', t(SAMPLE), { onError: (message) => onNotify(message) })
            }
          >
            {listening ? (reading.phase === 'loading' ? t('正在合成…') : t('停止试听')) : t('试听')}
          </button>
        </div>
      </section>
    </>
  );
}
