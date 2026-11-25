// Pre-log argument masking and post-save conversation/history/turnContext scrubbing for `vault_save`.
import type { ChatMessage, WireMessage } from '../../../shared/types/core';
import type { VaultItemMeta } from '../../../shared/types/vault-types';
import type { Store } from '../storage/store';

export interface ScrubTargetField {
  key: string;
  value: string;
}

export interface ScrubAfterSaveParams {
  store: Pick<Store, 'data' | 'touch' | 'save' | 'humanRunMessage'>;
  runId: string;
  botId: string;
  item: Pick<VaultItemMeta, 'id' | 'title' | 'slug'>;
  savedFields: ScrubTargetField[];
  history?: WireMessage[];
  preparedContext?: WireMessage[];
  turnContext?: WireMessage;
  callId?: string;
}

export interface ScrubResult {
  scrubbedMessages: number;
  scrubbedToolCalls: number;
  scrubbedTurnContext: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Masks plaintext field values in `vault_save` input before creating UI activity bubbles, ledger entries or journals. */
function maskVaultSaveArgs(args: Record<string, unknown>): Record<string, unknown> {
  const cloned = structuredClone(args);
  if (isPlainObject(cloned.fields)) {
    for (const [key, value] of Object.entries(cloned.fields)) {
      if (value !== null && value !== undefined) {
        cloned.fields[key] = '[已加密保存]';
      }
    }
  }
  return cloned;
}

/** Masks raw JSON `tool.intent` arguments string for `vault_save` before writing to `events.jsonl`. */
function maskVaultSaveArgumentsJson(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs);
    if (isPlainObject(parsed)) {
      return JSON.stringify(maskVaultSaveArgs(parsed));
    }
  } catch {
    /* Fall through to safe placeholder if arguments JSON was malformed. */
  }
  return '{"masked":"[已加密保存]"}';
}

function maskToolCallArguments(rawArgs: string, savedFields: ScrubTargetField[]): { next: string; changed: boolean } {
  try {
    const parsed = JSON.parse(rawArgs);
    if (isPlainObject(parsed) && isPlainObject(parsed.fields)) {
      let changed = false;
      for (const [key, value] of Object.entries(parsed.fields)) {
        if (typeof value === 'string' && value !== '[vault:saved]') {
          parsed.fields[key] = '[vault:saved]';
          changed = true;
        }
      }
      return changed ? { next: JSON.stringify(parsed), changed: true } : { next: rawArgs, changed: false };
    }
  } catch {
    /* Fall back to direct string scrubbing if JSON cannot be parsed. */
  }
  let fallback = rawArgs;
  let changed = false;
  for (const field of savedFields) {
    if (field.value.length >= 4 && fallback.includes(field.value)) {
      fallback = fallback.split(field.value).join('[vault:saved]');
      changed = true;
    }
  }
  return { next: fallback, changed };
}

interface ReplacementPattern {
  needle: string;
  replacement: string;
}

function buildReplacements(itemTitle: string, savedFields: ScrubTargetField[]): ReplacementPattern[] {
  const patterns: ReplacementPattern[] = [];
  const seen = new Set<string>();
  const add = (needle: string, fieldKey: string) => {
    if (needle.length < 4 || seen.has(needle)) return;
    seen.add(needle);
    patterns.push({ needle, replacement: `[保险库：${itemTitle}.${fieldKey}]` });
  };
  const addWithJsonEscape = (base: string, fieldKey: string) => {
    add(base, fieldKey);
    const jsonEscaped = JSON.stringify(base).slice(1, -1);
    if (jsonEscaped !== base) add(jsonEscaped, fieldKey);
  };

  for (const { key, value } of savedFields) {
    if (typeof value !== 'string' || value.length < 4) continue;
    addWithJsonEscape(value, key);
    const trimmed = value.trim();
    if (trimmed.length >= 4) addWithJsonEscape(trimmed, key);

    // Card number spacing/hyphen formatting variants (13-19 digits).
    const compactDigits = trimmed.replace(/[\s-]+/g, '');
    if (/^\d{13,19}$/.test(compactDigits) && /^[\d\s-]+$/.test(trimmed)) {
      addWithJsonEscape(compactDigits, key);
      addWithJsonEscape(compactDigits.replace(/(.{4})(?=.)/g, '$1 '), key);
      addWithJsonEscape(compactDigits.replace(/(.{4})(?=.)/g, '$1-'), key);
      if (compactDigits.length === 15) {
        addWithJsonEscape(`${compactDigits.slice(0, 4)} ${compactDigits.slice(4, 10)} ${compactDigits.slice(10)}`, key);
        addWithJsonEscape(`${compactDigits.slice(0, 4)}-${compactDigits.slice(4, 10)}-${compactDigits.slice(10)}`, key);
      }
    }

    if (value.includes('\n')) {
      const lf = value.replace(/\r\n/g, '\n');
      const crlf = lf.replace(/\n/g, '\r\n');
      for (const block of [lf, lf.trim(), crlf, crlf.trim()]) {
        addWithJsonEscape(block, key);
      }
      for (const line of lf.split('\n')) {
        const clean = line.trim();
        if (clean.startsWith('-----BEGIN ') || clean.startsWith('-----END ')) continue;
        if (clean.length >= 16) addWithJsonEscape(clean, key);
      }
    }
  }

  return patterns.sort((a, b) => b.needle.length - a.needle.length);
}

function applyReplacements(text: string, patterns: ReplacementPattern[]): { next: string; changed: boolean } {
  let out = text;
  let changed = false;
  for (const { needle, replacement } of patterns) {
    if (out.includes(needle)) {
      out = out.split(needle).join(replacement);
      changed = true;
    }
  }
  return { next: out, changed };
}

function scrubWireList(
  messages: WireMessage[] | undefined,
  patterns: ReplacementPattern[],
  savedFields: ScrubTargetField[],
  callId?: string,
  userStartIndex = 0,
): { toolCalls: number; userChanged: boolean } {
  if (!messages?.length) return { toolCalls: 0, userChanged: false };
  let toolCalls = 0;
  let userChanged = false;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'assistant' && message.tool_calls?.length) {
      let assistantTouched = false;
      for (const call of message.tool_calls) {
        if (call.function.name !== 'vault_save') continue;
        if (callId && call.id !== callId) continue;
        const masked = maskToolCallArguments(call.function.arguments, savedFields);
        if (masked.changed) {
          call.function.arguments = masked.next;
          toolCalls++;
          assistantTouched = true;
        }
      }
      // `model-protocol.ts` replays `message.native.data` directly instead of `message.tool_calls`; strip it when scrubbing.
      if (assistantTouched && message.native !== undefined) {
        delete message.native;
      }
      if (assistantTouched && typeof message.content === 'string' && patterns.length) {
        const scrubbed = applyReplacements(message.content, patterns);
        if (scrubbed.changed) message.content = scrubbed.next;
      }
    }
    if (i >= userStartIndex && message.role === 'user' && typeof message.content === 'string') {
      const scrubbed = applyReplacements(message.content, patterns);
      if (scrubbed.changed) {
        message.content = scrubbed.next;
        userChanged = true;
      }
    }
  }
  return { toolCalls, userChanged };
}

function currentTurnUserStart(messages: WireMessage[]): number {
  // Scrub from the last user-message stretch that precedes the active assistant tool batch (avoiding ancient history).
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      let start = i;
      while (start > 0 && messages[start - 1].role === 'user') start--;
      return start;
    }
  }
  return 0;
}

export const VaultScrubber = {
  maskVaultSaveArgs,
  maskVaultSaveArgumentsJson,

  /**
   * Scrubs plaintext secrets saved via `vault_save` out of:
   * 1. Assistant `tool_calls` arguments (clearing unredacted `native` replay blobs) in `history` and `preparedContext`;
   * 2. Current run triggering `ChatMessage`(s) in `store` (setting `vaultScrubbed = true` and calling `store.touch`);
   * 3. Current turn `user` WireMessages in `history` and `preparedContext`;
   * 4. `turnContext` anchor copy (including JSON-escaped occurrences).
   */
  scrubAfterSave(params: ScrubAfterSaveParams): ScrubResult {
    const patterns = buildReplacements(params.item.title, params.savedFields);
    let scrubbedMessages = 0;
    let scrubbedToolCalls = 0;
    let scrubbedTurnContext = false;
    let historyUserChanged = false;

    const candidateChatMessages = new Set<ChatMessage>();
    for (const list of [
      params.store.data.messages,
      params.store.data.peerMessages,
      params.store.data.groupRunMessages,
    ]) {
      for (const message of list) {
        if (message.runId === params.runId && message.botId === params.botId && message.role === 'user') {
          candidateChatMessages.add(message);
        }
      }
    }
    const humanSource = params.store.humanRunMessage(params.runId);
    if (humanSource && humanSource.role === 'user') {
      candidateChatMessages.add(humanSource);
    }

    for (const message of candidateChatMessages) {
      if (typeof message.content !== 'string' || !patterns.length) continue;
      const scrubbed = applyReplacements(message.content, patterns);
      if (scrubbed.changed) {
        message.content = scrubbed.next;
        message.vaultScrubbed = true;
        params.store.touch(message);
        scrubbedMessages++;
      }
    }

    if (params.history) {
      const start = currentTurnUserStart(params.history);
      const res = scrubWireList(params.history, patterns, params.savedFields, params.callId, start);
      scrubbedToolCalls += res.toolCalls;
      historyUserChanged = res.userChanged;
    }
    if (params.preparedContext) {
      const start = currentTurnUserStart(params.preparedContext);
      scrubbedToolCalls += scrubWireList(
        params.preparedContext,
        patterns,
        params.savedFields,
        params.callId,
        start,
      ).toolCalls;
      // Also scrub any turnContext system message inside preparedContext.
      for (const wire of params.preparedContext) {
        if (wire.role === 'system' && typeof wire.content === 'string' && patterns.length) {
          const scrubbed = applyReplacements(wire.content, patterns);
          if (scrubbed.changed) {
            wire.content = scrubbed.next;
            scrubbedTurnContext = true;
          }
        }
      }
    }
    if (params.turnContext && typeof params.turnContext.content === 'string' && patterns.length) {
      const scrubbed = applyReplacements(params.turnContext.content, patterns);
      if (scrubbed.changed) {
        params.turnContext.content = scrubbed.next;
        scrubbedTurnContext = true;
      }
    }

    if (scrubbedMessages > 0 || scrubbedToolCalls > 0 || historyUserChanged) {
      params.store.save();
    }

    return { scrubbedMessages, scrubbedToolCalls, scrubbedTurnContext };
  },
};
