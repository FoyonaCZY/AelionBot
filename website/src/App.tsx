import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Aurora } from './Aurora';
import { BenchmarkSection } from './BenchmarkSection';
import { capabilityCopy } from './capability-content';
import { homeCopy } from './home-content';
import { ComputerArt, DesignArt, GroupChatArt, WorkspaceArt } from './Illustrations';
import { Mark } from './Mark';
import { VideoSection } from './VideoSection';
import { readSiteLanguage, rememberSiteLanguage } from './locale.mjs';
import { version } from '../../package.json';
import { siteCopy, siteLanguages, siteQuestions, type SiteLanguage } from './site-i18n';
import {
  detectDownloadPlatform,
  downloadHref,
  downloadIcon,
  navigatorHints,
  readBrowserDownloadHints,
  recommendDownload,
} from './download-platform.mjs';
import { useMotionPreference, useSiteMotion } from './useSiteMotion';
import site from '../site.json';

type IconName = 'arrow' | 'down' | 'up' | 'plus' | 'close' | 'menu' | 'check' | 'windows' | 'mac';
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    down: <path d="M12 4v15m-6-6 6 6 6-6" />,
    up: <path d="M12 20V5m-6 6 6-6 6 6" />,
    plus: <path d="M5 12h14M12 5v14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    menu: <path d="M4 8h16M4 16h16" />,
    check: <path d="m5 12 4 4L19 6" />,
    windows: <path d="m3 5 8-1v7H3zm10-1 8-1v8h-8zM3 13h8v7l-8-1zm10 0h8v8l-8-1z" fill="currentColor" stroke="none" />,
    mac: (
      <>
        <path d="M6 5h12a1 1 0 0 1 1 1v8H5V6a1 1 0 0 1 1-1z" />
        <path d="M3 17h18" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function downloadLabel(copy: (typeof siteCopy)['zh-CN'], id: string) {
  return id === 'windows-x64' ? copy.downloadWindows : id === 'mac-arm64' ? copy.downloadMacArm : copy.downloadAll;
}
function downloadShort(copy: (typeof siteCopy)['zh-CN'], id: string) {
  return id === 'windows-x64' ? copy.downloadWindowsShort : copy.downloadMacArmShort;
}

function DownloadPanel({ copy }: { copy: (typeof siteCopy)['zh-CN'] }) {
  const [platform, setPlatform] = useState(() => detectDownloadPlatform(navigatorHints()));
  useEffect(() => {
    let live = true;
    readBrowserDownloadHints().then((hints) => {
      if (live) setPlatform(detectDownloadPlatform(hints));
    });
    return () => {
      live = false;
    };
  }, []);
  const { primary, alternatives } = recommendDownload(platform);
  const hint =
    platform.os === 'ios' || platform.os === 'android'
      ? copy.downloadMobileHint
      : platform.os === 'linux'
        ? copy.downloadLinuxHint
        : platform.os === 'mac' && platform.arch === 'x64'
          ? copy.downloadMacIntelHint
          : '';
  return (
    <div className="download-panel">
      <a
        className="pill pill-light pill-large"
        href={downloadHref(primary, site.repository, version)}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Icon name={downloadIcon(primary) as IconName} size={18} />
        {downloadLabel(copy, primary)}
        <Icon name="arrow" size={17} />
      </a>
      {hint ? <p className="download-hint">{hint}</p> : null}
      <p className="download-meta">
        <span>v{version}</span>
        {alternatives.map((id: string) => (
          <a key={id} href={downloadHref(id, site.repository, version)} target="_blank" rel="noopener noreferrer">
            {downloadShort(copy, id)}
          </a>
        ))}
      </p>
    </div>
  );
}

export default function App() {
  const root = useRef<HTMLDivElement>(null),
    menuButton = useRef<HTMLButtonElement>(null);
  const motion = useMotionPreference();
  useSiteMotion(root, motion.enabled);
  const [language, setLanguage] = useState<SiteLanguage>(() => readSiteLanguage() as SiteLanguage),
    [menuOpen, setMenuOpen] = useState(false);
  const copy = siteCopy[language],
    home = homeCopy[language],
    capabilities = capabilityCopy[language],
    questions = siteQuestions[language];
  const chapters = [
    { id: 'group-chat', feature: capabilities.group, Art: GroupChatArt },
    { id: 'vm', feature: capabilities.vm, Art: ComputerArt },
    { id: 'design-systems', feature: capabilities.design, Art: DesignArt },
  ];
  const sectionLinks = [
    ...chapters.map((chapter, index) => ({ href: '#' + chapter.id, label: capabilities.nav[index] })),
    { href: '#benchmark', label: home.benchmarkNav },
  ];
  const releases = language === 'en' ? 'Releases' : '版本更新';
  const feedback = language === 'en' ? 'Feedback' : language === 'zh-TW' ? '回報建議' : '反馈建议';

  useEffect(() => {
    document.documentElement.lang = language;
    document.title =
      language === 'en'
        ? 'AelionBot · A general-purpose multi-agent workspace'
        : language === 'zh-TW'
          ? 'AelionBot · 通用多 Agent 工作空間'
          : 'AelionBot · 通用多 Agent 工作空间';
    document.querySelector('meta[name="description"]')?.setAttribute('content', copy.heroDescription);
    rememberSiteLanguage(language);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', document.title);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', copy.heroDescription);
  }, [language, copy.heroDescription]);
  useEffect(() => {
    if (!menuOpen) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (!(event.target as Element).closest('.site-header')) setMenuOpen(false);
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', outside);
    };
  }, [menuOpen]);

  return (
    <div ref={root} id="top" className="home" data-motion={motion.enabled ? 'on' : 'off'}>
      <a className="skip-link" href="#main">
        {copy.skip}
      </a>
      <header className="site-header">
        <div className="header-shell">
          <a className="brand" href="#top" aria-label={copy.home}>
            <Mark className="brand-mark" />
            <span>AelionBot</span>
          </a>
          <nav id="main-navigation" className={`main-nav ${menuOpen ? 'is-open' : ''}`} aria-label={copy.mainNav}>
            {sectionLinks.map((link) => (
              <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>
                {link.label}
              </a>
            ))}
            <a href={`/blog/?lang=${language}`} onClick={() => setMenuOpen(false)}>
              {copy.blog}
            </a>
            <a href={site.repository} target="_blank" rel="noopener noreferrer" onClick={() => setMenuOpen(false)}>
              {copy.github}
            </a>
          </nav>
          <div className="header-actions">
            <select
              className="language-switcher"
              aria-label={language === 'en' ? 'Language' : language === 'zh-TW' ? '語言' : '语言'}
              value={language}
              onChange={(event) => setLanguage(event.target.value as SiteLanguage)}
            >
              {siteLanguages.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <a className="pill pill-glass header-download" href="#download">
              {copy.download}
            </a>
            <button
              ref={menuButton}
              className="menu-button"
              aria-label={menuOpen ? copy.closeNav : copy.openNav}
              aria-controls="main-navigation"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((value) => !value)}
            >
              <Icon name={menuOpen ? 'close' : 'menu'} />
            </button>
          </div>
        </div>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="hero-title" data-scroll-scene="hero">
          <div className="hero-card">
            <Aurora scene="veils" />
            <div className="hero-inner">
              <h1 id="hero-title" className="hero-wordmark">
                AelionBot
                <Mark className="hero-mark" />
              </h1>
              <div className="hero-intro">
                <p className="hero-lead">{copy.heroTitle.join(' ')}</p>
                <p className="hero-description">{copy.heroDescription}</p>
                <div className="hero-actions">
                  <a className="pill pill-glass" href="#download">
                    {copy.download}
                    <Icon name="arrow" size={16} />
                  </a>
                  <a className="text-link" href={'#' + chapters[0].id}>
                    {home.heroMore}
                  </a>
                </div>
                <p className="hero-meta">
                  v{version} · {home.heroMeta}
                </p>
              </div>
            </div>
            <a className="hero-scroll" href="#intro" aria-label={home.scrollCue}>
              <Icon name="down" size={16} />
            </a>
          </div>
        </section>

        <section className="statement shell-narrow" id="intro" aria-labelledby="statement-title">
          <p className="kicker" data-reveal>
            {home.statementKicker}
          </p>
          <h2 id="statement-title" className="display" data-reveal data-delay="1">
            {home.statementTitle}
          </h2>
          <p className="serif-lead" data-reveal data-delay="2">
            {home.statementBody}
          </p>
          <dl className="facts" data-reveal data-delay="3">
            {home.facts.map((fact) => (
              <div key={fact.value}>
                <dt>{fact.value}</dt>
                <dd>{fact.label}</dd>
              </div>
            ))}
          </dl>
        </section>

        <VideoSection copy={home.tour} />

        <section className="workspace shell" aria-labelledby="workspace-title">
          <div className="section-head centered" data-reveal>
            <p className="kicker">{home.workspace.kicker}</p>
            <h2 id="workspace-title" className="display">
              {home.workspace.title}
            </h2>
            <p className="serif-lead">{home.workspace.description}</p>
          </div>
          <div data-reveal>
            <WorkspaceArt label={home.workspace.title} />
          </div>
        </section>

        {chapters.map((chapter, index) => (
          <section
            key={chapter.id}
            id={chapter.id}
            className={`chapter shell ${index % 2 ? 'is-flipped' : ''}`}
            aria-labelledby={chapter.id + '-title'}
          >
            <div className="chapter-copy" data-reveal>
              <p className="kicker">{chapter.feature.kicker}</p>
              <h2 id={chapter.id + '-title'} className="display">
                {chapter.feature.title}
              </h2>
              <p className="serif-lead">{chapter.feature.description}</p>
              <ul className="line-list">
                {chapter.feature.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              {chapter.feature.note && <p className="fine-print">{chapter.feature.note}</p>}
            </div>
            <div className="chapter-visual" data-reveal data-delay="1">
              <chapter.Art label={chapter.feature.title} />
            </div>
          </section>
        ))}

        <BenchmarkSection language={language} methodUrl={`${site.repository}/blob/main/docs/terminal-bench.md`} />

        <section className="faq shell" id="questions" aria-labelledby="faq-title">
          <div className="section-head" data-reveal>
            <p className="kicker">{home.faqKicker}</p>
            <h2 id="faq-title" className="display">
              {copy.questionsTitle}
            </h2>
          </div>
          <div className="faq-list">
            {questions.map((item) => (
              <details key={item.question}>
                <summary>
                  {item.question}
                  <Icon name="plus" size={18} />
                </summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="download" id="download" aria-labelledby="download-title">
          <Aurora scene="clouds" />
          <div className="download-inner shell-narrow">
            <p className="kicker" data-reveal>
              {home.downloadKicker}
            </p>
            <h2 id="download-title" className="display display-large" data-reveal data-delay="1">
              {copy.downloadTitle.join(' ')}
            </h2>
            <p className="serif-lead" data-reveal data-delay="2">
              {home.downloadLead}
            </p>
            <div className="download-card" data-reveal data-delay="3">
              <DownloadPanel copy={copy} />
              <ol className="steps">
                {home.steps.map((step, index) => (
                  <li key={step}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <strong>{step}</strong>
                  </li>
                ))}
              </ol>
            </div>
            <ul className="trust">
              {home.trust.map((item) => (
                <li key={item}>
                  <Icon name="check" size={14} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-grid shell">
          <div className="footer-brand">
            <a className="brand" href="#top" aria-label={copy.home}>
              <Mark className="brand-mark" />
              <span>AelionBot</span>
            </a>
            <p>{copy.footerTagline}</p>
          </div>
          <nav aria-label={home.footerProduct}>
            <h3>{home.footerProduct}</h3>
            {sectionLinks.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
            <a href="#download">{copy.download}</a>
          </nav>
          <nav aria-label={home.footerResources}>
            <h3>{home.footerResources}</h3>
            <a href={`/blog/?lang=${language}`}>{copy.blog}</a>
            <a href={site.repository} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <a href={`${site.repository}/releases`} target="_blank" rel="noopener noreferrer">
              {releases}
            </a>
            <a href={`${site.repository}/issues`} target="_blank" rel="noopener noreferrer">
              {feedback}
            </a>
          </nav>
        </div>
        <div className="footer-bottom shell">
          <span>© {new Date().getFullYear()} AelionBot</span>
          <span>v{version}</span>
        </div>
      </footer>
      <a className="to-top" href="#top" aria-label={home.backToTop}>
        <Icon name="up" size={16} />
      </a>
    </div>
  );
}
