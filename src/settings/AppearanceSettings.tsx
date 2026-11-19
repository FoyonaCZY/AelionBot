import { useEffect, useState, type ReactNode } from 'react';
import { Select } from '../ui/Select';
import { Icon } from '../ui/Icon';
import {
  CANVAS_TONES,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  resolvedTheme,
  type AppearanceSettings as Values,
  type CanvasTone,
} from '../../shared/preview/appearance';
import { Avatar } from '../ui/Avatar';
import { SettingsSection } from './SettingsWindow';
import { languageOptions, useI18n } from '../i18n';
import { useSystemAudio } from '../chat/system-audio';
import './appearance-settings.css';

const canvasNames: Record<CanvasTone, string> = {
  neutral: '中性灰',
  lilac: '淡紫灰',
  cool: '冷灰蓝',
  warm: '暖米色',
  deep: '深紫灰',
  wash: '淡渐变',
  white: '纯白',
};

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="appearance-row">
      <div>
        <span>{title}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="appearance-control">{children}</div>
    </div>
  );
}
function FontName({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const { t } = useI18n();
  return (
    <input
      aria-label={label}
      value={draft}
      placeholder={t('例如 Microsoft YaHei')}
      maxLength={80}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const name = normalizeAppearance({ customFont: draft }).customFont;
        setDraft(name);
        onChange(name);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}
export function AppearanceSettings({
  settings,
  change,
  saving,
  error,
}: {
  settings: Values;
  change: (patch: Partial<Values>) => void;
  saving: boolean;
  error: string;
}) {
  const { t, language, setLanguage } = useI18n();
  // Whether the rail in the conversation behind the settings gets the system's sound.
  const systemAudio = useSystemAudio(false);
  const number = (
    key: 'textScale' | 'messageSize' | 'codeSize' | 'lineHeight',
    label: string,
    min: number,
    max: number,
    step = 1,
    suffix = '',
  ) => (
    <div className="appearance-range">
      <input
        type="range"
        aria-label={t(label)}
        min={min}
        max={max}
        step={step}
        value={settings[key]}
        onChange={(e) => change({ [key]: Number(e.target.value) })}
      />
      <output>
        {settings[key]}
        {suffix}
      </output>
    </div>
  );
  const dark = resolvedTheme(settings.theme, window.matchMedia('(prefers-color-scheme: dark)').matches) === 'dark';
  return (
    <div className="appearance-settings">
      {/* Stays in view while you scroll, so every change below shows on a real exchange. */}
      <div className="appearance-preview-dock">
        <figure className="appearance-preview" aria-label={t('外观实时预览')}>
          <div className="appearance-preview-chat" aria-hidden="true">
            <p className="appearance-preview-bubble is-you">{t('帮我整理一下今天的工作记录。')}</p>
            <div className="appearance-preview-reply">
              <Avatar bot={{ name: 'AelionBot', color: '#4fc3b5' }} size={26} />
              <p className="appearance-preview-bubble">
                {t('整理好了，三件事都已完成：')}
                <code>notes.md</code>
              </p>
            </div>
          </div>
        </figure>
      </div>
      <SettingsSection title={t('主题')}>
        <div className="appearance-themes">
          {(['light', 'dark', 'system'] as const).map((theme) => (
            <button type="button" key={theme} aria-pressed={settings.theme === theme} onClick={() => change({ theme })}>
              <span className={`appearance-theme-swatch is-${theme}`} aria-hidden="true">
                <i />
                <b />
                <em />
              </span>
              <span>
                {t(theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统')}
                {settings.theme === theme && <Icon name="check" size={14} />}
              </span>
            </button>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection title={t('对话背景')} aside={dark ? <small>{t('这项设置只影响浅色主题')}</small> : undefined}>
        <div className="appearance-canvases">
          {CANVAS_TONES.map((canvas) => (
            <button
              type="button"
              key={canvas}
              aria-pressed={settings.canvas === canvas}
              onClick={() => change({ canvas })}
            >
              <span className="appearance-canvas-swatch" data-canvas={canvas} aria-hidden="true">
                <i />
                <b />
              </span>
              <span>
                {t(canvasNames[canvas])}
                {settings.canvas === canvas && <Icon name="check" size={14} />}
              </span>
            </button>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection title={t('字体')}>
        <div className="settings-card">
          <Row title={t('界面字体')}>
            <Select
              aria-label={t('界面字体')}
              value={settings.font}
              onChange={(e) => change({ font: e.target.value as Values['font'] })}
            >
              <option value="bundled">Inter ＋ {language === 'en' ? 'Noto Sans' : '思源黑体'}</option>
              <option value="system">{t('系统默认')}</option>
              <option value="custom">{t('自定义字体')}</option>
            </Select>
          </Row>
          {settings.font === 'custom' && (
            <Row title={t('字体名称')}>
              <FontName
                label={t('自定义界面字体名称')}
                value={settings.customFont}
                onChange={(customFont) => change({ customFont })}
              />
            </Row>
          )}
          <Row title={t('代码字体')}>
            <Select
              aria-label={t('代码字体')}
              value={settings.codeFont}
              onChange={(e) => change({ codeFont: e.target.value as Values['codeFont'] })}
            >
              <option value="bundled">JetBrains Mono</option>
              <option value="system">{t('系统等宽字体')}</option>
              <option value="custom">{t('自定义字体')}</option>
            </Select>
          </Row>
          {settings.codeFont === 'custom' && (
            <Row title={t('代码字体名称')}>
              <FontName
                label={t('自定义代码字体名称')}
                value={settings.customCodeFont}
                onChange={(customCodeFont) => change({ customCodeFont })}
              />
            </Row>
          )}
          <Row title={t('正文字重')}>
            <Select
              aria-label={t('正文字重')}
              value={String(settings.weight)}
              onChange={(e) => change({ weight: Number(e.target.value) })}
            >
              <option value="300">{t('纤细 · 300')}</option>
              <option value="400">{t('常规 · 400')}</option>
              <option value="500">{t('中等 · 500')}</option>
              <option value="600">{t('较粗 · 600')}</option>
            </Select>
          </Row>
        </div>
      </SettingsSection>
      <SettingsSection title={t('大小与间距')}>
        <div className="settings-card">
          <Row title={t('消息文字')}>{number('messageSize', '消息文字大小', 12, 22, 1, ' px')}</Row>
          <Row title={t('代码文字')}>{number('codeSize', '代码文字大小', 11, 20, 1, ' px')}</Row>
          <Row title={t('消息行距')}>{number('lineHeight', '消息行距', 1.4, 2.2, 0.1)}</Row>
          <Row title={t('界面文字')}>{number('textScale', '界面文字大小', 85, 130, 5, '%')}</Row>
          <Row title={t('显示比例')}>
            <Select
              aria-label={t('显示比例')}
              value={String(settings.zoom)}
              onChange={(e) => change({ zoom: Number(e.target.value) })}
            >
              {[...new Set([50, 75, 90, 100, 110, 125, 150, 175, 200, settings.zoom])]
                .sort((a, b) => a - b)
                .map((value) => (
                  <option key={value} value={String(value)}>
                    {value}%{value === 100 ? ` · ${t('默认')}` : ''}
                  </option>
                ))}
            </Select>
          </Row>
        </div>
      </SettingsSection>
      <SettingsSection title={t('对话')}>
        <div className="settings-card">
          <Row title={t('思考过程')}>
            <Select
              aria-label={t('思考过程')}
              value={settings.reasoning}
              onChange={(e) => change({ reasoning: e.target.value as Values['reasoning'] })}
            >
              <option value="collapsed">{t('自动收起')}</option>
              <option value="expanded">{t('始终展开')}</option>
              <option value="hidden">{t('不显示')}</option>
            </Select>
          </Row>
          <Row
            title={t('对话导航条')}
            hint={
              settings.conversationRail === 'audio' && systemAudio === 'unavailable'
                ? t(
                    '没有取到系统音频。请在“系统设置 > 隐私与安全性 > 录屏与系统录音”中允许 AelionBot；Linux 暂不支持。',
                  )
                : undefined
            }
          >
            <Select
              aria-label={t('对话导航条')}
              value={settings.conversationRail}
              onChange={(e) => change({ conversationRail: e.target.value as Values['conversationRail'] })}
            >
              <option value="audio">{t('随系统音频律动')}</option>
              <option value="static">{t('静态显示')}</option>
              <option value="hidden">{t('不显示')}</option>
            </Select>
          </Row>
        </div>
      </SettingsSection>
      <SettingsSection title={t('语言')}>
        <div className="settings-card">
          <Row title={t('界面语言')}>
            <Select
              aria-label={t('选择界面语言')}
              value={language}
              onChange={(event) => setLanguage(event.target.value as typeof language)}
            >
              {languageOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Row>
        </div>
      </SettingsSection>
      <footer className="appearance-footer">
        <button type="button" className="text-button" onClick={() => change({ ...DEFAULT_APPEARANCE })}>
          {t('恢复默认')}
        </button>
        <span role="status" className={error ? 'is-error' : ''}>
          {error || (saving ? t('正在保存…') : t('更改已自动保存'))}
        </span>
      </footer>
    </div>
  );
}
