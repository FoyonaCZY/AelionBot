/** Which events show a notification of the operating system while the window is in the background. */
export interface DesktopNotifySettings {
  /** A Bot waits for an approval, an answer, or for you to take over the work computer. */
  requests: boolean;
  /** A task you started ended. */
  finished: boolean;
  /** An automation ran. */
  automations: boolean;
  /** Show what the Bot said or asks for; otherwise only that something happened. */
  content: boolean;
}
export const DEFAULT_DESKTOP_NOTIFY: DesktopNotifySettings = {
  requests: true,
  finished: true,
  automations: true,
  content: true,
};
export function normalizeDesktopNotify(value: unknown): DesktopNotifySettings {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const settings = { ...DEFAULT_DESKTOP_NOTIFY };
  for (const key of Object.keys(settings) as Array<keyof DesktopNotifySettings>)
    if (typeof input[key] === 'boolean') settings[key] = input[key];
  return settings;
}
/** The chat a notification leads to when it is clicked. */
export interface ChatTarget {
  botId: string;
  sessionId?: string;
  groupId?: string;
  /** The request to bring into view there. */
  requestId?: string;
}
