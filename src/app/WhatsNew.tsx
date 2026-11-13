// What changed since the version someone last saw: shown once after updating, newest release first. The notes are the
// repository's docs/releases files, bundled with the app, so they show without a network.
import { useEffect, useState } from 'react';
import Markdown from '../chat/MessageMarkdown';
import { Icon } from '../ui/Icon';
import { currentLanguage, useI18n } from '../i18n';
import { compareVersions } from '../../shared/version';
import { releaseNotesSection } from '../../shared/release-notes';
import './whats-new.css';

const files = Object.entries(import.meta.glob<string>('/docs/releases/v*.md', { query: '?raw', import: 'default' }))
  .map(([path, load]) => ({ version: /v(\d+\.\d+\.\d+)\.md$/.exec(path)?.[1] || '', load }))
  .filter((file) => file.version);

export function WhatsNew({ from, version, onClose }: { from?: string; version: string; onClose: () => void }) {
  const { t } = useI18n();
  const [releases, setReleases] = useState<Array<{ version: string; text: string }>>();
  useEffect(() => {
    let active = true;
    const wanted = files
      .filter((file) =>
        from
          ? compareVersions(file.version, from) > 0 && compareVersions(file.version, version) <= 0
          : file.version === version,
      )
      .sort((a, b) => compareVersions(b.version, a.version));
    void Promise.all(
      wanted.map(async (file) => ({
        version: file.version,
        text: releaseNotesSection(await file.load(), currentLanguage()),
      })),
    ).then(
      (value) => {
        if (!active) return;
        // Nothing to show (a build without notes for this version): the dialog never appears.
        if (value.length) setReleases(value);
        else onClose();
      },
      () => active && onClose(),
    );
    return () => {
      active = false;
    };
  }, [from, version]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  if (!releases) return null;
  const title = t('AelionBot 已更新到 v{version}', { version });
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal whats-new-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div>
            <h2>{title}</h2>
            {from && (
              <p className="whats-new-range">
                {t('从 v{from} 以来的 {count} 个版本', { from, count: releases.length })}
              </p>
            )}
          </div>
          <div className="modal-header-actions">
            <button className="icon-button" aria-label={t('关闭对话框')} onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        <div className="whats-new-body">
          {releases.map((release) => (
            <article key={release.version} className="whats-new-release">
              <h3>v{release.version}</h3>
              <div className="markdown">
                <Markdown>{release.text}</Markdown>
              </div>
            </article>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="primary-button" autoFocus onClick={onClose}>
            {t('知道了')}
          </button>
        </div>
      </section>
    </div>
  );
}
