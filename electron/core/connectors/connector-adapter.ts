// The contract between the connector hub and one IM platform. An adapter keeps its own connection alive and remembers
// whatever a platform needs to reply in a chat (WeCom's callback request, WeChat's context token).
import type { ConnectorPerson, ConnectorPlatform, ConnectorStatus } from '../../../shared/types/connector-types';

export interface InboundResource {
  kind: 'image' | 'file' | 'audio' | 'video';
  name?: string;
  /** Downloads the file; platforms expire their links within minutes, so the hub calls it at once. */
  fetch(signal: AbortSignal): Promise<{ name: string; bytes: Buffer }>;
}
export interface InboundMessage {
  messageId: string;
  chatId: string;
  isGroup: boolean;
  sender: ConnectorPerson;
  text: string;
  quoted?: string;
  resources: InboundResource[];
  /** Milliseconds since the epoch, as the platform reports it. */
  sentAt: number;
}
/** A button press on a card the hub sent. */
export interface InboundAction {
  chatId: string;
  operator: ConnectorPerson;
  key: string;
}
export interface ConnectorCard {
  title: string;
  lines: string[];
  buttons: Array<{ label: string; key: string; style?: 'primary' | 'danger' }>;
}
export interface AdapterHandlers {
  status(status: ConnectorStatus, issue?: string): void;
  message(message: InboundMessage): void;
  /** Resolves to what the card should say once decided, or undefined when the press changed nothing. */
  action(action: InboundAction): Promise<string | undefined>;
  /** Credentials refreshed by the platform, such as a WeChat login moved to another host. */
  credentials?(value: Record<string, string>): void;
  /** State to keep across restarts, such as a long-poll cursor. */
  state?(value: Record<string, string>): void;
}
export interface ConnectorAdapter {
  readonly platform: ConnectorPlatform;
  /** Connects and keeps reconnecting until stop(). */
  start(handlers: AdapterHandlers): void;
  stop(): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendFile(chatId: string, file: { name: string; bytes: Buffer }): Promise<void>;
  /** A voice message, Ogg Opus; absent where the platform takes none from bots. */
  sendVoice?(chatId: string, voice: { bytes: Buffer; durationMs: number }): Promise<void>;
  /** Absent where the platform has no buttons; the hub then asks for a text reply. */
  sendCard?(chatId: string, card: ConnectorCard): Promise<string | undefined>;
  /** Replaces a sent card with a decided state (its buttons removed). */
  closeCard?(handle: string, card: ConnectorCard, result: string): Promise<void>;
  /** Shows or clears a "working on it" cue in the chat, without sending a message. */
  typing?(chatId: string, active: boolean): Promise<void>;
}
