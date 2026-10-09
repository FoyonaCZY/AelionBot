import { useId, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/types/core';
import { SOUL_MAX_CHARS, normalizeSoul } from '../../shared/chat/bot-soul';
import { isStarterText, soulPresets } from '../../shared/chat/soul-presets';
import { BotPaletteEditor } from '../bots/BotPaletteEditor';
import { ModelSelectionFields, validModelSelection } from '../settings/ModelSelectionFields';
import { useI18n } from '../i18n';
import type { BotProfile } from './use-bot-profile';

/** Create a Bot or edit its profile. Every Bot can take on design work; the designer is one of the presets. */
export function BotProfileForm({
  modal,
  state,
  profile,
  busy,
  onSave,
}: {
  modal: 'new' | 'profile';
  state: Snapshot;
  profile: BotProfile;
  busy: boolean;
  onSave: () => void;
}) {
  const { t, language } = useI18n();
  const { name, setName, soul, setSoul, newBotPalette, setNewBotPalette } = profile;
  const soulId = useId(),
    fileInput = useRef<HTMLInputElement>(null),
    [soulIssue, setSoulIssue] = useState('');
  const {
    model: profileModel,
    setModel: setProfileModel,
    imageModel: profileImageModel,
    setImageModel: setProfileImageModel,
    reasoning: profileReasoning,
    setReasoning: setProfileReasoning,
    palette: profilePalette,
    setPalette: setProfilePalette,
  } = profile;
  const editingBot = state.bots.find((item) => item.id === profile.editingId);
  const profileRunning = state.runs.some((run) => run.botId === profile.editingId && run.status === 'running') || false;
  const profileModelChanged =
    JSON.stringify(profileModel) !== JSON.stringify(editingBot?.model || null) ||
    profileReasoning.trim() !== (editingBot?.reasoningEffort || '');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <BotPaletteEditor
        value={modal === 'new' ? newBotPalette : profilePalette}
        onChange={modal === 'new' ? setNewBotPalette : setProfilePalette}
        name={name || t('新 Bot')}
        disabled={busy}
      />
      <label>
        {t('名称')}
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          placeholder={t('名称')}
        />
      </label>
      <div className="bot-soul-field">
        <div className="bot-soul-header">
          <label htmlFor={soulId}>SOUL.md</label>
          <button type="button" className="text-button" disabled={busy} onClick={() => fileInput.current?.click()}>
            {t('导入文件')}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            style={{ display: 'none' }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              const text = normalizeSoul(await file.text());
              if (text === undefined) setSoulIssue(t('文件超过 {max} 字符，未导入。', { max: SOUL_MAX_CHARS }));
              else {
                setSoul(text);
                setSoulIssue('');
              }
            }}
          />
        </div>
        <textarea
          id={soulId}
          rows={modal === 'profile' ? 10 : 12}
          maxLength={SOUL_MAX_CHARS}
          spellCheck={false}
          value={soul}
          onChange={(event) => {
            setSoul(event.target.value);
            setSoulIssue('');
          }}
        />
        <div className="bot-soul-footer">
          <span role={soulIssue ? 'alert' : undefined} className={soulIssue ? 'is-error' : undefined}>
            {soulIssue}
          </span>
          <span>
            {soul.length.toLocaleString()} / {SOUL_MAX_CHARS.toLocaleString()}
          </span>
        </div>
        {modal === 'new' && (
          <div className="presets" role="group" aria-label={t('从示例开始')}>
            <span className="presets-label">{t('从示例开始')}</span>
            {soulPresets(language).map((preset) => (
              <button
                type="button"
                key={preset.id}
                aria-pressed={soul === preset.soul}
                onClick={() => {
                  setSoul(preset.soul);
                  setSoulIssue('');
                  if (isStarterText(name)) setName(preset.name);
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="bot-profile-model">
        <h3>{t('对话模型')}</h3>
        <ModelSelectionFields
          providers={state.providers || []}
          value={profileModel}
          onChange={setProfileModel}
          defaultModel={state.defaultModel}
          reasoningValue={profileReasoning}
          onReasoningChange={setProfileReasoning}
          inheritDefault
          disabled={busy || (modal === 'profile' && profileRunning)}
        />
      </div>
      <div className="bot-profile-model">
        <h3>{t('生图模型')}</h3>
        <p className="settings-note">{t('未配置时无法生成图片。')}</p>
        <ModelSelectionFields
          providers={state.providers || []}
          value={profileImageModel}
          onChange={setProfileImageModel}
          inheritDefault
          noneLabel={t('不单独配置生图模型')}
          purpose="image"
          showInheritedReasoning={false}
          disabled={busy || (modal === 'profile' && profileRunning)}
        />
      </div>
      <button
        className="primary-button full"
        disabled={
          busy ||
          !validModelSelection(profileModel, state.providers || []) ||
          !validModelSelection(profileImageModel, state.providers || []) ||
          (modal === 'profile' && (!name.trim() || (profileModelChanged && profileRunning)))
        }
      >
        {modal === 'new' ? t('创建伙伴') : t('保存资料')}
      </button>
    </form>
  );
}
