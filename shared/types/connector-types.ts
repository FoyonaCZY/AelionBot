// Connectors: IM accounts (Feishu, WeCom, WeChat) through which people message their Bot. Each private or group chat
// on a connector is one work session of the bound Bot (see WorkSession.connector).
import type { HostPermissionMode } from './permission-types';

export type ConnectorPlatform = 'feishu' | 'wecom' | 'weixin';
export const CONNECTOR_PLATFORM_NAMES: Record<ConnectorPlatform, string> = {
  feishu: '飞书',
  wecom: '企业微信',
  weixin: '微信',
};
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
  /** The platform account: Feishu App ID, WeCom BotID or the WeChat bot ID. Never a secret. */
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
}
type ConnectorCredentials =
  { platform: 'feishu'; appId: string; appSecret: string } | { platform: 'wecom'; botId: string; secret: string };
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
