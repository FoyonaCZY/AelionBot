import { catalogMatches } from '../../shared/model-catalog';
import { useState } from 'react';
import type { ModelProvider } from '../../shared/types/core';
import { MODEL_USES, usesModel, type VideoSelection } from '../../shared/types/media-types';
import { useI18n } from '../i18n';
import { Select } from '../ui/Select';
import { EditableSelect } from '../ui/EditableSelect';
import { ipcErrorText } from '../ui/ipc-error';
import { VideoTest } from './VideoTest';
import { ImageModelTest } from './ModelSelectionFields';

export function MediaAssignment({
  kind,
  selection,
  providers,
  onManage,
  onNotify,
}: {
  kind: 'image' | 'video';
  selection?: VideoSelection;
  providers: ModelProvider[];
  onManage: (id?: string) => void;
  onNotify: (message: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<VideoSelection>(selection || { providerId: '', model: '' });
  const [saving, setSaving] = useState(false),
    [testing, setTesting] = useState(false);
  const canTestVideo = kind === 'video' && Boolean(selection) && JSON.stringify(draft) === JSON.stringify(selection);
  const connections = providers.filter((p) => usesModel(p, kind)),
    connection = connections.find((p) => p.id === draft.providerId);
  const save = async () => {
    setSaving(true);
    try {
      await window.aelion.setMediaDefault(kind, draft.providerId ? draft : null);
      onNotify(t('已保存'));
    } catch (error) {
      onNotify(ipcErrorText(error));
    } finally {
      setSaving(false);
    }
  };
  const fields: [keyof Pick<VideoSelection, 'aspect' | 'resolution' | 'duration'>, string, string[]][] = [
    ['aspect', '画幅比例', ['16:9', '9:16', '1:1', '21:9']],
    ['resolution', '分辨率', kind === 'video' ? ['720p', '1080p', '4k'] : ['1024x1024', '1536x1024', '2K']],
  ];
  if (kind === 'video') fields.push(['duration', '视频时长', ['5', '8', '10']]);
  return (
    <section className="media-assignment">
      <header className={'media-banner media-banner-' + kind}>
        <h3>{t(MODEL_USES[kind])}</h3>
      </header>
      <div className="media-section-heading">
        <h3>{t('模型连接')}</h3>
        <button className="text-button" onClick={() => onManage(connection?.id)}>
          {t('管理连接')}
        </button>
      </div>
      <div className="settings-card media-fields">
        <label>
          <span>Provider</span>
          <Select value={draft.providerId} onChange={(e) => setDraft({ providerId: e.target.value, model: '' })}>
            <option value="">{t('未设置')}</option>
            {connections.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span>{t('模型')}</span>
          <EditableSelect
            label={t('模型')}
            value={draft.model}
            onChange={(model) => setDraft({ ...draft, model })}
            options={(kind === 'image'
              ? [...(connection?.models || [])].sort(
                  (a, b) => Number(Boolean(b.imageOutput)) - Number(Boolean(a.imageOutput)),
                )
              : connection?.models || []
            )
              .filter((m) => catalogMatches(m, kind))
              .map((m) => m.id)}
            disabled={!connection}
            placeholder={t('选择或输入模型名称')}
          />
        </label>
      </div>
      {connection && (
        <>
          <div className="media-section-heading">
            <h3>{t('默认输出')}</h3>
          </div>
          <div className="settings-card media-fields">
            {fields.map(([key, label, options]) => (
              <label key={key}>
                <span>{t(label)}</span>
                <EditableSelect
                  label={t(label)}
                  value={draft[key] || ''}
                  options={options}
                  placeholder={t('模型默认')}
                  onChange={(value) => setDraft({ ...draft, [key]: value || undefined })}
                />
              </label>
            ))}
          </div>
        </>
      )}
      <div className="media-actions">
        {canTestVideo && (
          <button
            type="button"
            className="secondary-button"
            aria-expanded={testing}
            onClick={() => setTesting(!testing)}
          >
            {t('测试视频模型')}
          </button>
        )}
        {kind === 'image' && connection && draft.model.trim() && (
          <ImageModelTest
            selection={{ providerId: connection.id, model: draft.model, contextTokens: 32000 }}
            disabled={saving}
          />
        )}
        <button
          className="primary-button"
          onClick={() => void save()}
          disabled={saving || Boolean(draft.providerId && !draft.model.trim())}
        >
          {t('保存设置')}
        </button>
      </div>
      {canTestVideo && testing && <VideoTest />}
    </section>
  );
}
