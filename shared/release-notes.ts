/**
 * One release's notes (a docs/releases file) in the interface language, without its title. Newer notes have a
 * "## 简体中文" and a "## English" section; older ones are in one language and are shown whole.
 */
export function releaseNotesSection(text: string, language: string) {
  const body = text.replace(/\r\n/g, '\n').replace(/^# .*\n+/, ''),
    chinese = /^## 简体中文[ \t]*$/m.exec(body),
    english = /^## English[ \t]*$/m.exec(body);
  if (!chinese || !english) return body.trim();
  const [first, second] = chinese.index < english.index ? [chinese, english] : [english, chinese],
    wanted = language.startsWith('en') ? english : chinese;
  return (
    wanted === first
      ? body.slice(first.index + first[0].length, second.index)
      : body.slice(second.index + second[0].length)
  ).trim();
}
