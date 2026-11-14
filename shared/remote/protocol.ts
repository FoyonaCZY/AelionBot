// What the phone and the desktop say to each other once the channel is open. The phone calls methods by name; the
// desktop answers each call and pushes views when they change. Everything here travels end-to-end encrypted.
import type { EntityDelta } from '../state-sync';
import type { Attachment } from '../types/attachment-types';
import type {
  ChatMessage,
  InteractionAction,
  InteractionRequest,
  RunRecord,
  StreamingReply,
  WorkSession,
} from '../types/core';
import type { GroupPage } from '../types/group-types';
import type { HostPermissionMode } from '../types/permission-types';
import type { ScheduledTaskStatus } from '../types/scheduled-types';
import type { BotAvatarStyle } from '../chat/bot-colors';

/** Bumped when either side can no longer understand the other; features are announced as capabilities instead. */
export const REMOTE_PROTOCOL = 1;
/** What this desktop version offers, so a newer phone app can hide what an older desktop cannot do. */
export const REMOTE_CAPABILITIES = [
  'chat',
  'groups',
  'files',
  'speech',
  'automations',
  'computer',
  'push',
  'verify',
  'direct',
] as const;
type RemoteCapability = (typeof REMOTE_CAPABILITIES)[number];

/** A file the phone may send or read: the app's own attachment limit. */
export const REMOTE_FILE_BYTES = 25 * 1024 * 1024;
/** Paths on the relay: the desktop's control connection, a phone's connection to a room. */
export const RELAY_DESKTOP_PATH = '/v1/desktop';
export const RELAY_CLIENT_PATH = '/v1/client';

/** The relay and phone app run for everyone; a self-hoster sets their own in the desktop's settings. */
export const OFFICIAL_RELAY_URL = 'https://relay.aelion.chat';
export const OFFICIAL_APP_URL = 'https://app.aelion.chat';

/** What the pairing QR code carries after `#pair=` in the phone app's address. */
export interface PairingLink {
  v: typeof REMOTE_PROTOCOL;
  /** The relay's address. */
  u: string;
  /** The desktop's room on the relay. */
  r: string;
  /** The desktop's key-agreement public key. */
  k: string;
  /** The pairing and its one-time secret. */
  i: string;
  s: string;
  /** The computer's name, shown while connecting. */
  n: string;
}
export function pairingUrl(appUrl: string, link: PairingLink) {
  const json = JSON.stringify(link);
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return appUrl.replace(/\/+$/, '') + '/#pair=' + encoded;
}
export function readPairingUrl(hash: string): PairingLink | undefined {
  const match = /(?:^|[#&])pair=([A-Za-z0-9_-]+)/.exec(hash);
  if (!match) return;
  try {
    const binary = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'));
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    if (
      value?.v === REMOTE_PROTOCOL &&
      ['u', 'r', 'k', 'i', 's', 'n'].every((key) => typeof value[key] === 'string' && value[key].length < 400)
    ) {
      normalizeRelayUrl(value.u);
      return value as PairingLink;
    }
  } catch {
    return;
  }
}

/** The relay's address as configured: an https origin, or http for localhost while testing. */
export function normalizeRelayUrl(value: string) {
  const text = value.trim().replace(/\/+$/, '');
  if (!text) return '';
  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : 'https://' + text);
  } catch {
    throw new Error('中继地址无效');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('中继地址必须使用 https');
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/'))
    throw new Error('中继地址只填域名，例如 https://app.example.com');
  return url.origin;
}
export const relaySocketUrl = (relayUrl: string, path: string) => relayUrl.replace(/^http/, 'ws') + path;

// ---------- Session ----------

/** Per-device choices of what the desktop pushes to it. */
export interface NotifyPrefs {
  requests: boolean;
  finished: boolean;
  automations: boolean;
  /** Put the reply or the command in the notification; otherwise only who and what kind. */
  content: boolean;
}
export const DEFAULT_NOTIFY: NotifyPrefs = { requests: true, finished: true, automations: true, content: false };

/** The desktop's first message on a new channel. */
export interface Welcome {
  t: 'welcome';
  protocol: number;
  app: string;
  name: string;
  capabilities: RemoteCapability[];
  device: { id: string; name: string; notify: NotifyPrefs; push: boolean; verify: boolean };
  /**
   * ready: paired and unlocked. pending: a new phone waiting for the user to allow it on the computer.
   * locked: the device asks for Face ID / a fingerprint before anything else (see `verify`).
   */
  state: 'ready' | 'pending' | 'locked';
  /** While locked: the WebAuthn challenge and the credential to answer it with. */
  verify?: { challenge: string; credentialId: string; rpId: string };
}

/**
 * `switch` marks the last frame a side sends through the relay: everything after it goes over the direct
 * connection, so the receiver reads the relay up to the marker and the direct connection after it.
 */
export type ClientMessage = { t: 'call'; id: number; method: string; params?: unknown } | { t: 'switch' };
export type ServerMessage =
  | Welcome
  | { t: 'result'; id: number; value?: unknown }
  | { t: 'error'; id: number; code: string; message: string }
  | { t: 'event'; name: string; data: unknown }
  | { t: 'switch' };

// ---------- Views ----------

/** A chat's last message, as a line in a list. */
export interface RemoteLast {
  text: string;
  fromUser: boolean;
  time: string;
}
export interface RemoteBot {
  id: string;
  name: string;
  color: string;
  avatarStyle?: BotAvatarStyle;
  /** working: running a tool; thinking: running otherwise; waiting: a request is waiting for the user. */
  state?: 'working' | 'thinking' | 'waiting';
  /** What it is doing now, while it works. */
  activity?: { label: string; detail?: string };
  /** The last message in any of its chats. */
  last?: RemoteLast;
  /** Last activity in any of its chats. */
  time: string;
  /** The chat that activity was in, so the list opens the right one. */
  sessionId?: string;
}
export interface RemoteSessionRow {
  id: string;
  botId: string;
  name: string;
  last?: RemoteLast;
  time: string;
  working?: boolean;
}
interface RemoteGroupRow {
  id: string;
  name: string;
  members: string[];
  line: string;
  time: string;
  unread: number;
  active: boolean;
}
export type RemoteRequest = InteractionRequest & { sessionId?: string; groupId?: string };
interface RemoteAutomation {
  id: string;
  title: string;
  target: { kind: 'bot' | 'group'; id: string; sessionId?: string };
  trigger: string;
  status: ScheduledTaskStatus;
  nextRunAt?: string;
  lastRun?: { status: string; at: string };
  needsReview?: boolean;
}
export interface HomeView {
  name: string;
  bots: RemoteBot[];
  sessions: RemoteSessionRow[];
  groups: RemoteGroupRow[];
  requests: RemoteRequest[];
  automations: RemoteAutomation[];
  computer: {
    status: string;
    desktops: Record<string, { status: string; ownerBotId?: string; manualControl: boolean }>;
  };
  speech: { input: boolean; output: boolean };
}

/** One open chat: a window of its newest messages and their runs, extended by `chat.more`. */
export interface ChatView {
  key: string;
  botId: string;
  sessionId?: string;
  messages: ChatMessage[];
  runs: RunRecord[];
  streams: StreamingReply[];
  hasMore: boolean;
  permission: HostPermissionMode;
}
export interface ChatDelta {
  key: string;
  messages?: EntityDelta<ChatMessage>;
  runs?: EntityDelta<RunRecord>;
  streams?: StreamingReply[];
  permission?: HostPermissionMode;
}
export const chatKey = (botId: string, sessionId?: string) => botId + ':' + (sessionId || '');

export interface RecentFile extends Attachment {
  time: string;
  sessionId?: string;
}

// ---------- Methods ----------

/** Every method the phone may call, with its parameters and result. The desktop refuses anything else. */
interface RemoteMethods {
  'home.subscribe'(): HomeView;
  'chat.open'(input: { botId: string; sessionId?: string }): ChatView;
  'chat.more'(input: { key: string }): { messages: ChatMessage[]; runs: RunRecord[]; hasMore: boolean };
  'chat.close'(): void;
  'chat.send'(input: {
    botId: string;
    sessionId?: string;
    message: string;
    attachmentIds?: string[];
    replyToMessageId?: string;
  }): void;
  'chat.stop'(input: { botId: string; sessionId?: string }): void;
  'chat.retract'(input: { botId: string; sessionId?: string; messageId: string }): void;
  'chat.resume'(input: { botId: string; runId: string }): void;
  'chat.toolResult'(input: { botId: string; messageId: string }): unknown;
  'session.create'(input: { botId: string; name: string }): WorkSession;
  'session.update'(input: { id: string; name?: string; archived?: boolean }): void;
  'permission.set'(input: { botId: string; sessionId?: string; mode: Exclude<HostPermissionMode, 'full'> }): void;
  'request.respond'(input: { id: string; action: InteractionAction; answers?: Record<string, string> }): void;
  'files.upload'(input: {
    scope: { kind: 'bot' | 'group'; id: string; sessionId?: string };
    name: string;
    bytes: Uint8Array;
  }): Attachment;
  'files.read'(input: { id: string }): { name: string; mime: string; bytes: Uint8Array };
  'files.recent'(input: { botId: string }): RecentFile[];
  'speech.transcribe'(input: { audio: Uint8Array; name?: string }): { text: string };
  'speech.synthesize'(input: { text: string; botId?: string }): { audio: Uint8Array; mime: string };
  'automation.run'(input: { id: string }): void;
  'automation.setEnabled'(input: { id: string; enabled: boolean }): void;
  'group.open'(input: { id: string }): GroupPage;
  'group.more'(input: { id: string; before: string }): GroupPage;
  'group.close'(): void;
  'group.send'(input: { id: string; message: string; attachmentIds?: string[]; replyToMessageId?: string }): void;
  'group.read'(input: { id: string; seq: number }): void;
  'group.stop'(input: { id: string }): void;
  'computer.open'(input: { botId: string }): { stream: number };
  'computer.close'(input: { stream: number }): void;
  'computer.control'(input: { botId: string; enabled: boolean }): void;
  'push.key'(): { key: string };
  'push.subscribe'(input: { endpoint: string; keys: { p256dh: string; auth: string } }): void;
  'push.unsubscribe'(): void;
  'push.test'(): void;
  'device.update'(input: { name?: string; notify?: Partial<NotifyPrefs> }): void;
  'device.forget'(): void;
  /** Which chat the phone shows in the foreground, so its notifications can be skipped. */
  presence(input: { chat?: string; visible: boolean }): void;
  'verify.begin'(): { challenge: string; rpId: string; userId: string; userName: string };
  'verify.register'(input: { credentialId: string; publicKey: string; clientData: string; rpId: string }): void;
  'verify.unlock'(input: { authenticatorData: string; clientData: string; signature: string }): void;
  'verify.disable'(): void;
  /** Direct connection on the same network: WebRTC signaling through the relayed channel. */
  'direct.offer'(input: { sdp: string }): { sdp: string };
  'direct.candidate'(input: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }): void;
}
export type RemoteMethod = keyof RemoteMethods;
export type RemoteParams<M extends RemoteMethod> = Parameters<RemoteMethods[M]>[0];
export type RemoteResult<M extends RemoteMethod> = ReturnType<RemoteMethods[M]>;

/** Events the desktop pushes: `home` and `chat` views, a group page, a closed stream, direct-connection signaling. */
export interface RemoteEvents {
  home: HomeView;
  chat: ChatDelta;
  group: GroupPage;
  state: Pick<Welcome, 'state' | 'device'>;
  'stream.close': { stream: number };
  'direct.candidate': { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
}

/** Push payloads, read by the phone's service worker. */
export interface PushPayload {
  title: string;
  body: string;
  /** Replaces an earlier notification of the same chat or request. */
  tag: string;
  /** Where tapping it leads, inside the app. */
  url: string;
}
