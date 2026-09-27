export function safeRelativePath(value: string) {
  if (
    !value ||
    value.length > 500 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /^[a-z]:/i.test(value) ||
    value.split('/').includes('..') ||
    value.includes('\0')
  )
    throw new Error('路径必须位于当前 Bot 的工作目录内');
  return value;
}
export function workspacePath(value: string, botId: string) {
  const prefix = `/work/${botId}/`;
  return safeRelativePath(value.startsWith(prefix) ? value.slice(prefix.length) : value);
}
export function requiredText(args: Record<string, unknown>, key: string, max: number) {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`无效参数：${key}`);
  return value;
}
export function memorySafe(value: string) {
  if (/(?:sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]{15,}|BEGIN [A-Z ]*PRIVATE KEY)/.test(value))
    throw new Error('记忆和技能不能保存凭据');
}
