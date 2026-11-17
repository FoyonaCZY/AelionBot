// Connectors: IM accounts (Feishu, WeCom, WeChat, Telegram, Discord, Slack) through which people message their Bot.
// Each private or group chat on a connector is one work session of the bound Bot (see WorkSession.connector).
import type { HostPermissionMode } from './permission-types';

export type ConnectorPlatform = 'feishu' | 'wecom' | 'weixin' | 'telegram' | 'discord' | 'slack';
export const CONNECTOR_PLATFORM_NAMES: Record<ConnectorPlatform, string> = {
  feishu: '飞书',
  wecom: '企业微信',
  weixin: '微信',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
};
/** In the order the app lists them. */
export const CONNECTOR_PLATFORMS = Object.keys(CONNECTOR_PLATFORM_NAMES) as ConnectorPlatform[];
/**
 * Shown with an "experimental" tag: WeChat goes through a plugin the platform may restrict, and the last three have
 * only run against local stand-ins of their services so far.
 */
export const EXPERIMENTAL_CONNECTORS: ReadonlySet<ConnectorPlatform> = new Set([
  'weixin',
  'telegram',
  'discord',
  'slack',
]);
/**
 * disabled: switched off. connecting: starting or reconnecting. displaced: another device took the single connection
 * the platform allows. needs-config: credentials or the bound Bot are missing.
 */
export type ConnectorStatus = 'disabled' | 'connecting' | 'connected' | 'displaced' | 'needs-config' | 'error';
export interface ConnectorPerson {
  id: string;
  name?: string;
}
/** Someone who messaged the connector and is waiting for the user to let them in. */
export interface ConnectorPairing extends ConnectorPerson {
  code: string;
  requestedAt: string;
}
export interface ConnectorView {
  id: string;
  platform: ConnectorPlatform;
  botId: string;
  enabled: boolean;
  permissionMode: HostPermissionMode;
  status: ConnectorStatus;
  issue?: string;
  /** The person the connector belongs to. Approvals and questions go to them only. */
  owner?: ConnectorPerson;
  /** Other people allowed to message the Bot. */
  allowed: ConnectorPerson[];
  pairings: ConnectorPairing[];
  /**
   * The platform account: Feishu App ID, WeCom BotID, the WeChat bot ID, a Telegram @username, a Discord bot name or
   * a Slack workspace and app. Never a secret.
   */
  account: string;
  createdAt: string;
  lastMessageAt?: string;
}
type ConnectorSetupPhase = 'starting' | 'waiting' | 'scanned' | 'verify-code' | 'done' | 'failed';
/** A QR flow that creates a connector: Feishu app registration or WeChat ClawBot login. */
export interface ConnectorSetupView {
  id: string;
  platform: 'feishu' | 'weixin';
  phase: ConnectorSetupPhase;
  /** SVG markup of the QR code; it encodes `url`. */
  qrSvg?: string;
  url?: string;
  expiresAt?: string;
  message?: string;
  connectorId?: string;
}
export interface ConnectorsView {
  /** Closing the window keeps connectors running in the tray. */
  keepRunning: boolean;
  connectors: ConnectorView[];
  setups: ConnectorSetupView[];
}
/** The connector chat a work session belongs to. */
export interface WorkSessionConnector {
  connectorId: string;
  platform: ConnectorPlatform;
  chatId: string;
  peer: ConnectorPerson;
}
/** Where a chat message arrived from. */
export interface MessageConnectorSource {
  connectorId: string;
  platform: ConnectorPlatform;
  messageId: string;
  /** Sent in a group chat, where the reply is visible to every member. */
  isGroup?: boolean;
  sender: ConnectorPerson;
  /** Whether the sender is the connector's owner, the person the user profile describes. Absent while it has none. */
  owner?: boolean;
  /** The message was spoken: a voice message turned into text, which may be answered by voice too. */
  voice?: boolean;
}
/** What to call a connector message's sender: the name if the platform gave one. WeCom reports only an ID. */
export const connectorSenderLabel = (sender: ConnectorPerson) =>
  sender.name?.replace(/\s+/g, ' ').trim().slice(0, 80) || sender.id;
/** Credentials the hub stores as they are; the others are checked with the platform first. */
export type ConnectorLocalCredentials =
  { platform: 'feishu'; appId: string; appSecret: string } | { platform: 'wecom'; botId: string; secret: string };
type ConnectorCredentials =
  | ConnectorLocalCredentials
  | { platform: 'telegram'; token: string }
  | { platform: 'discord'; token: string }
  /** A Socket Mode app: its app-level token (xapp-) and its bot token (xoxb-). */
  | { platform: 'slack'; appToken: string; botToken: string };
export interface ConnectorCreateInput {
  botId: string;
  permissionMode: HostPermissionMode;
  credentials: ConnectorCredentials;
}
export interface ConnectorSetupInput {
  platform: 'feishu' | 'weixin';
  botId: string;
  permissionMode: HostPermissionMode;
}
export interface ConnectorUpdateInput {
  id: string;
  enabled?: boolean;
  botId?: string;
  permissionMode?: HostPermissionMode;
  /** Removes these people from the allowed list. */
  removeAllowed?: string[];
}
