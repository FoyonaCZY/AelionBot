// The contract between the connector hub and one IM platform. An adapter keeps its own connection alive and remembers
// whatever a platform needs to reply in a chat (WeCom's callback request, WeChat's context token).
import type { ConnectorPerson, ConnectorPlatform, ConnectorStatus } from '../../../shared/types/connector-types';
import type { VoiceClip, VoiceFormat } from '../speech/speech-service';

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
  /** A voice message the platform put into words itself; `text` holds what was said. */
  spoken?: boolean;
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
/** One live-updated message while the Bot is writing it. Methods are called sequentially, never concurrently. */
export interface ConnectorTextStream {
  /** Minimum wait between intermediate `update` calls, in ms. May change dynamically if a stream falls back. */
  readonly intervalMs?: number;
  /** Updates the message with the full text generated so far. */
  update(text: string): Promise<void>;
  /** Finalizes the message with its complete text, or closes an open stream cleanly when empty. */
  finish(text: string): Promise<void>;
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
  /**
   * Starts a live-updated reply in the chat, where the platform supports it. Absent, or returning undefined (such as
   * WeCom without a recent message to reply to), tells the outbox to send each completed message with `sendText`.
   */
  beginStream?(chatId: string): ConnectorTextStream | undefined;
  sendFile(chatId: string, file: { name: string; bytes: Buffer }): Promise<void>;
  /** The audio of voice messages the platform takes from bots; absent, with sendVoice, where it takes none. */
  readonly voiceFormat?: VoiceFormat;
  /** One voice message in `voiceFormat`. */
  sendVoice?(chatId: string, voice: VoiceClip): Promise<void>;
  /** Absent where the platform has no buttons; the hub then asks for a text reply. */
  sendCard?(chatId: string, card: ConnectorCard): Promise<string | undefined>;
  /** Replaces a sent card with a decided state (its buttons removed). */
  closeCard?(handle: string, card: ConnectorCard, result: string): Promise<void>;
  /** Shows or clears a "working on it" cue in the chat, without sending a message. */
  typing?(chatId: string, active: boolean): Promise<void>;
}
