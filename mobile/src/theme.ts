// Light or dark: with the phone's setting unless the user picked one here. The choice stays on this phone.
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'aelion-remote-theme';
/** The status bar's color in each theme: the screens' background. */
const BAR = { light: '#ffffff', dark: '#0b0b0c' };

export function themeChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice = themeChoice()) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  // index.html has one theme-color per system theme; a chosen theme sets both.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    meta.content = BAR[choice === 'system' ? (meta.media.includes('dark') ? 'dark' : 'light') : choice];
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage unavailable: the choice holds until the app closes.
  }
  applyTheme(choice);
}
