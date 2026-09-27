import type { Snapshot } from '../../shared/types/core';
import { BotPaletteEditor } from '../bots/BotPaletteEditor';
import { ModelSelectionFields, validModelSelection } from '../settings/ModelSelectionFields';
import { useI18n } from '../i18n';
import { BotTypeArt } from './BotTypeArt';
import type { BotProfile } from './use-bot-profile';

/** Create a Bot or edit its profile. Changing an existing Bot's type asks for confirmation first. */
export function BotProfileForm({
  modal,
  state,
  profile,
  busy,
  onSwitchType,
  onSave,
}: {
  modal: 'new' | 'profile';
  state: Snapshot;
  profile: BotProfile;
  busy: boolean;
  onSwitchType: () => void;
  onSave: () => void;
}) {
  const { t, language } = useI18n();
  const { name, setName, role, setRole, newBotPalette, setNewBotPalette } = profile;
  const {
    type: profileType,
    setType: setProfileType,
    originalType: profileOriginalType,
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
        if (modal === 'profile' && profileType !== profileOriginalType) {
          onSwitchType();
          return;
        }
        onSave();
      }}
    >
      <div className="bot-profile-types" aria-label={language === 'en' ? 'Bot type' : 'Bot 类型'}>
        {(['general', 'designer'] as const).map((type) => (
          <button
            type="button"
            className={`bot-type-card is-${type}`}
            key={type}
            aria-pressed={profileType === type}
            onClick={() => setProfileType(type)}
          >
            <BotTypeArt type={type} />
            <span className="bot-type-copy">
              <strong>
                {type === 'general'
                  ? language === 'en'
                    ? 'General Bot'
                    : '通用 Bot'
                  : language === 'en'
                    ? 'Designer'
                    : '设计师'}
              </strong>
            </span>
          </button>
        ))}
      </div>
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
      <label>
        {t('职责描述')}
        <textarea
          rows={modal === 'profile' ? 3 : 4}
          maxLength={4000}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        />
      </label>
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
      {modal === 'new' && (
        <div className="presets">
          {['整理资料与写作', '分析数据与报表', '编写代码与测试'].map((value) => (
            <button
              type="button"
              key={value}
              onClick={() => {
                setName(value.split('与')[0]);
                setRole(`${t('帮助我')}${t(value)}，${t('使用工作电脑执行并验证成果。')}`);
              }}
            >
              {t(value)}
            </button>
          ))}
        </div>
      )}
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
